import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { canonicalJson, partitionPrivateRecovery, partitionPrivateRecoverySupplement, recoverySupplementDigest, verifyCombinedWorkspaceRecoveryArchive } from "@starter/core";
import { encryptedRecordSchema, PRIVATE_SNAPSHOT_MAX_BYTES, PRIVATE_USER_ONLY_KINDS, RECOVERY_MAX_RECORDS, signedPrivatePersonalMigrationProofSchema, type EncryptedRecord, type SignedPrivatePersonalMigrationProof } from "@starter/shared";
import { PrivateDirectory, PrivateMigrationReceipt, PrivateRecord, PrivateSnapshotChunk, PrivateSnapshotReader, PrivateWorkspace } from "../../models/PrivateData.js";
import { WorkspaceMember } from "../../models/WorkspaceMember.js";
import { fenceWorkspace, supportsBusinessTransactions, withBusinessTransaction } from "../business-transaction.js";
import { migrationFavoritesSource } from "./recovery.js";
import { workspaceRecoverySupplement } from "./recovery-supplement.js";
import { requireActivePrivatePreparation } from "./preparation.js";
import { verifyPrivateChange } from "./signatures.js";

/** Internal caller-readable source only. A future public controller must first
 * verify trusted root/device authorization; no source route is mounted here. */
export async function personalMigrationSource(scope: { server: string; workspaceId: string; userId: string; migrationId: string }) {
  if (!await supportsBusinessTransactions()) throw new TRPCError({ code: "PRECONDITION_FAILED" });
  return withBusinessTransaction(async () => {
    const { workspaceId, userId, migrationId, server } = scope;
    if (!await WorkspaceMember.exists({ workspaceId, userId })) throw new TRPCError({ code: "NOT_FOUND" });
    const mode = await PrivateWorkspace.findOne({ workspaceId, migrationId }).lean();
    if (!mode?.supplementRevision || !/^[a-f0-9]{64}$/.test(mode.supplementRevision)) throw new TRPCError({ code: "PRECONDITION_FAILED" });
    requireActivePrivatePreparation(mode);
    const snapshot = await migrationFavoritesSource(workspaceId, userId, migrationId);
    const supplement = await workspaceRecoverySupplement(workspaceId, userId);
    supplement.collections.organization = [];
    supplement.sourceRevision = await recoverySupplementDigest(supplement.collections);
    return verifyCombinedWorkspaceRecoveryArchive({ format: "trackyourtime-workspace-recovery-v2", server, ownerId: userId, snapshot, supplement }, { server, workspaceId, ownerId: userId });
  });
}

/** Checks this creator's saved-file/content attestation, not anyone else's
 * private originals. Receipt replay revalidates originals and both ciphertext
 * copies. Source deletion and workspace conversion remain disabled. */
export async function recordPrivatePersonalMigrationProof(scope: { server: string; workspaceId: string; userId: string }, input: SignedPrivatePersonalMigrationProof) {
  const signed = signedPrivatePersonalMigrationProofSchema.parse(input), { proof } = signed;
  if (proof.server !== scope.server || proof.workspaceId !== scope.workspaceId || proof.userId !== scope.userId) throw new TRPCError({ code: "NOT_FOUND" });
  if (!await supportsBusinessTransactions()) throw new TRPCError({ code: "PRECONDITION_FAILED" });
  return withBusinessTransaction(async () => {
    const { workspaceId, userId, server } = scope, { migrationId } = proof;
    await fenceWorkspace(workspaceId);
    if (!await WorkspaceMember.exists({ workspaceId, userId })) throw new TRPCError({ code: "NOT_FOUND" });
    const mode = await PrivateWorkspace.findOne({ workspaceId, migrationId }).lean();
    if (!mode?.supplementRevision || !/^[a-f0-9]{64}$/.test(mode.supplementRevision)) throw new TRPCError({ code: "PRECONDITION_FAILED" });
    requireActivePrivatePreparation(mode);
    const snapshot = await PrivateSnapshotReader.findOne({ workspaceId, migrationId, userId }).lean();
    const directory = await PrivateDirectory.findOne({ workspaceId }).sort({ revision: -1 }).lean();
    const member = directory?.signed.directory.members.find((row) => row.userId === userId);
    if (!snapshot || !directory || !member || directory.digest !== proof.directoryDigest || directory.signed.directory.server !== server || snapshot.signed.manifest.root !== proof.snapshotRoot || snapshot.signed.manifest.directoryDigest !== proof.directoryDigest) throw new TRPCError({ code: "CONFLICT" });
    await verifyPrivateChange(member.signingPublicKey, proof, signed.signature);
    const archive = await personalMigrationSource({ ...scope, migrationId });
    const originals = [...partitionPrivateRecovery(archive.snapshot), ...partitionPrivateRecoverySupplement(archive.supplement)];
    const records: EncryptedRecord[] = [], frozen: EncryptedRecord[] = [];
    const selection = { kind: { $in: [...PRIVATE_USER_ONLY_KINDS] }, authorId: userId };
    let bytes = 2;
    const staged = PrivateRecord.find({ workspaceId, ...selection }).lean().cursor({ batchSize: 10 });
    try {
      for await (const row of staged) {
        if (row.deleted || row.revision !== 1) throw new TRPCError({ code: "CONFLICT" });
        const record = encryptedRecordSchema.parse({ id: row.id, kind: row.kind, authorId: row.authorId, revision: row.revision, keyCommitment: row.keyCommitment, box: row.box, grants: row.grants });
        bytes += Buffer.byteLength(JSON.stringify(record)) + 1;
        if (bytes > PRIVATE_SNAPSHOT_MAX_BYTES || records.length >= RECOVERY_MAX_RECORDS) throw new TRPCError({ code: "PAYLOAD_TOO_LARGE" });
        records.push(record);
      }
    } finally { await staged.close(); }
    bytes = 2;
    const chunks = PrivateSnapshotChunk.find({ workspaceId, migrationId, records: { $elemMatch: selection } }).lean().cursor({ batchSize: 1 });
    try {
      for await (const chunk of chunks) {
        bytes += Buffer.byteLength(JSON.stringify(chunk.records)) + 1;
        if (bytes > PRIVATE_SNAPSHOT_MAX_BYTES) throw new TRPCError({ code: "PAYLOAD_TOO_LARGE" });
        for (const row of chunk.records) if ((PRIVATE_USER_ONLY_KINDS as readonly string[]).includes(row.kind) && row.authorId === userId) {
          if (frozen.length >= RECOVERY_MAX_RECORDS) throw new TRPCError({ code: "PAYLOAD_TOO_LARGE" });
          frozen.push(encryptedRecordSchema.parse(row));
        }
      }
    } finally { await chunks.close(); }
    const address = (row: { kind: string; id: string }) => JSON.stringify([row.kind, row.id]);
    const ordered = (rows: EncryptedRecord[]) => rows.sort((a, b) => address(a) < address(b) ? -1 : address(a) > address(b) ? 1 : 0);
    ordered(records); ordered(frozen);
    const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
    const addresses = (rows: readonly { kind: string; id: string; authorId: string | null }[]) => rows.map((row) => JSON.stringify([row.kind, row.id, row.authorId])).sort();
    if (archive.snapshot.sourceRevision !== proof.sourceRevision || archive.supplement.sourceRevision !== proof.supplementRevision || records.length !== proof.verifiedRecords || canonicalJson(addresses(originals)) !== canonicalJson(addresses(records)) || records.some((row) => row.grants.length !== 1 || row.grants[0]!.userId !== userId) || hash(records) !== proof.recordsDigest || hash(frozen) !== proof.recordsDigest) throw new TRPCError({ code: "CONFLICT", message: "Personal originals or ciphertext changed. Source data was kept." });
    const prior = await PrivateMigrationReceipt.findOne({ workspaceId, migrationId, userId, kind: "personal" }).lean();
    if (prior) {
      if (canonicalJson(prior.proof) !== canonicalJson(proof)) throw new TRPCError({ code: "CONFLICT" });
      return { recorded: true as const };
    }
    await PrivateMigrationReceipt.create({ workspaceId, migrationId, userId, kind: "personal", ...signed });
    return { recorded: true as const };
  });
}
