import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { canonicalJson, privateInitialSnapshotProjection } from "@starter/core";
import { signedPrivateProjectionOwnerProofSchema, signedPrivateProjectionPersonalProofSchema, type SignedPrivateProjectionOwnerProof, type SignedPrivateProjectionPersonalProof } from "@starter/shared";
import { PrivateMigrationReceipt, PrivateWorkspace } from "../../models/PrivateData.js";
import { WorkspaceMember } from "../../models/WorkspaceMember.js";
import { fenceWorkspace, supportsBusinessTransactions, withBusinessTransaction } from "../business-transaction.js";
import { personalMigrationSource } from "./personal-migration.js";
import { capturePreparedPrivateProjection } from "./projection-snapshots.js";
import { isPersonalPrivateKind } from "./projection-proposal.js";
import { workspaceRecovery } from "./recovery.js";
import { workspaceRecoverySupplement } from "./recovery-supplement.js";
import { requireActivePrivatePreparation } from "./preparation.js";
import { verifyPrivateChange } from "./signatures.js";

type Scope = { server: string; workspaceId: string; userId: string };
/** Internal saved-file/content acknowledgements for separated projections.
 * Neither approval activates encryption, verifies an operational restore nor
 * deletes originals. No public v3 submission route is mounted. */
export async function recordPrivateProjectionOwnerProof(scope: Scope, input: SignedPrivateProjectionOwnerProof) {
  return recordProof({ ...scope }, signedPrivateProjectionOwnerProofSchema.parse(input), "owner");
}
export async function recordPrivateProjectionPersonalProof(scope: Scope, input: SignedPrivateProjectionPersonalProof) {
  return recordProof({ ...scope }, signedPrivateProjectionPersonalProofSchema.parse(input), "personal");
}
async function recordProof(scope: Scope, signed: SignedPrivateProjectionOwnerProof | SignedPrivateProjectionPersonalProof, kind: "owner" | "personal") {
  const { proof } = signed, { server, workspaceId, userId } = scope;
  if (proof.server !== server || proof.workspaceId !== workspaceId || proof.userId !== userId) throw new TRPCError({ code: "NOT_FOUND" });
  if (!await supportsBusinessTransactions()) throw new TRPCError({ code: "PRECONDITION_FAILED" });
  return withBusinessTransaction(async () => {
    await fenceWorkspace(workspaceId);
    const membership = await WorkspaceMember.findOne({ workspaceId, userId }).lean();
    if (!membership) throw new TRPCError({ code: "NOT_FOUND" });
    if (kind === "owner" && membership.role !== "owner") throw new TRPCError({ code: "FORBIDDEN" });
    const { migrationId } = proof;
    const mode = await PrivateWorkspace.findOne({ workspaceId, migrationId }).lean();
    if (!mode) throw new TRPCError({ code: "PRECONDITION_FAILED" });
    requireActivePrivatePreparation(mode);
    if (kind === "owner" && mode.ownerId !== userId) throw new TRPCError({ code: "FORBIDDEN" });
    // The complete capture stays internal. Acting as the preparation owner
    // here grants no source access or signing authority to the requesting member.
    const captured = await capturePreparedPrivateProjection({ server, workspaceId, migrationId, userId: mode.ownerId });
    const member = captured.directory.signed.directory.members.find((row) => row.userId === userId);
    const changed = () => new TRPCError({ code: "CONFLICT", message: "Original data or encrypted snapshot changed. Make and verify a fresh backup. Source data was kept." });
    if (!member || captured.root !== proof.snapshotRoot || captured.directory.digest !== proof.directoryDigest) throw changed();
    await verifyPrivateChange(member.signingPublicKey, proof, signed.signature);
    let sourceRevision: string, supplementRevision: string;
    if (kind === "owner") {
      sourceRevision = (await workspaceRecovery(workspaceId, userId)).sourceRevision;
      supplementRevision = (await workspaceRecoverySupplement(workspaceId, userId)).sourceRevision;
    } else {
      const archive = await personalMigrationSource({ ...scope, migrationId });
      sourceRevision = archive.snapshot.sourceRevision; supplementRevision = archive.supplement.sourceRevision;
    }
    const ownRecords = captured.records.filter((row) => isPersonalPrivateKind(row.kind) ? row.authorId === userId : kind === "owner");
    const records = privateInitialSnapshotProjection(ownRecords, userId);
    const digest = createHash("sha256").update(canonicalJson(records)).digest("hex");
    if (sourceRevision !== proof.sourceRevision || supplementRevision !== proof.supplementRevision || records.length !== proof.verifiedRecords || digest !== proof.recordsDigest) throw changed();
    // Replay checks the current complete originals and every frozen projection
    // again, even when the previously stored attestation is byte-identical.
    const prior = await PrivateMigrationReceipt.findOne({ workspaceId, migrationId, userId, kind }).lean();
    if (prior) {
      if (canonicalJson(prior.proof) !== canonicalJson(proof)) throw new TRPCError({ code: "CONFLICT" });
      return { recorded: true as const };
    }
    await PrivateMigrationReceipt.create({ workspaceId, migrationId, userId, kind, ...signed });
    return { recorded: true as const };
  });
}
