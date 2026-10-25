import { TRPCError } from "@trpc/server";
import { canonicalJson, fingerprint, type PublicKey } from "@starter/core";
import { PrivateWorkspace } from "../../models/PrivateData.js";
import { beforeBusinessCommit, fenceWorkspace, supportsBusinessTransactions, withBusinessTransaction } from "../business-transaction.js";
import { captureOperatorRecoveryArchive, signedOperatorRecoveryProofSchema, type SignedOperatorRecoveryProof } from "./operator-recovery.js";
import { verifyPrivateChange } from "./signatures.js";
import type { OriginalStageScope } from "./original-staging.js";
import { requireActivePrivatePreparation } from "./preparation.js";

function current(proof: SignedOperatorRecoveryProof["proof"]) {
  const now = Date.now();
  if (proof.verifiedAt > now + 30_000 || proof.expiresAt <= now || proof.expiresAt <= proof.verifiedAt || proof.expiresAt - proof.verifiedAt > 3_600_000) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Operator backup proof expired. Recheck the saved file and restore drill." });
}
/** Internal future-cutover check. Always revalidates current saved metadata,
 * signatures and source in its caller's fenced transaction, never a cached
 * boolean. It deliberately leaves source and backupVerified unchanged. */
export async function verifyStoredOperatorRecoveryProof(inputScope: OriginalStageScope, expectedRoot: string, trustedOperatorKey: PublicKey) {
  const scope = { ...inputScope }, key = structuredClone(trustedOperatorKey);
  if (!await supportsBusinessTransactions()) throw new TRPCError({ code: "PRECONDITION_FAILED" });
  return withBusinessTransaction(async () => {
    await fenceWorkspace(scope.workspaceId);
    const mode = await PrivateWorkspace.findOne({ workspaceId: scope.workspaceId, migrationId: scope.migrationId, ownerId: scope.userId }).lean();
    if (!mode?.operatorBackup) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "A current independently signed operator backup proof is required." });
    const signed = signedOperatorRecoveryProofSchema.parse(mode.operatorBackup);
    if (signed.proof.snapshotRoot !== expectedRoot) throw new TRPCError({ code: "CONFLICT" });
    return recordOperatorRecoveryProof(scope, signed, key);
  });
}
/** Internal operator transport only. trustedOperatorKey must come from an
 * independently pinned operational policy, NEVER the submitted request or an
 * owner's account key. This records an attestation, not backupVerified/mode.
 * Future cutover must revalidate the current stored proof in its transaction. */
export async function recordOperatorRecoveryProof(inputScope: OriginalStageScope, input: SignedOperatorRecoveryProof, trustedOperatorKey: PublicKey) {
  const scope = { ...inputScope }, signed = signedOperatorRecoveryProofSchema.parse(input), { proof } = signed;
  const key = structuredClone(trustedOperatorKey);
  if (key.d || proof.operatorFingerprint !== await fingerprint(key)) throw new TRPCError({ code: "FORBIDDEN" });
  if (proof.server !== scope.server || proof.workspaceId !== scope.workspaceId || proof.ownerId !== scope.userId || proof.migrationId !== scope.migrationId) throw new TRPCError({ code: "NOT_FOUND" });
  current(proof); await verifyPrivateChange(key, proof, signed.signature);
  if (!await supportsBusinessTransactions()) throw new TRPCError({ code: "PRECONDITION_FAILED" });
  return withBusinessTransaction(async () => {
    await fenceWorkspace(scope.workspaceId); current(proof);
    const archive = await captureOperatorRecoveryArchive(scope, proof.snapshotRoot);
    if (archive.modeId !== proof.modeId || archive.directoryDigest !== proof.directoryDigest || archive.snapshot.sourceRevision !== proof.sourceRevision || archive.supplement.sourceRevision !== proof.supplementRevision) throw new TRPCError({ code: "CONFLICT", message: "Operator backup covers a different preparation or original dataset. Source data was kept." });
    const mode = await PrivateWorkspace.findById(proof.modeId).lean();
    if (!mode) throw new TRPCError({ code: "NOT_FOUND" });
    current(proof);
    beforeBusinessCommit(async () => { current(proof); requireActivePrivatePreparation(mode); });
    if (mode.operatorBackup && canonicalJson(mode.operatorBackup) === canonicalJson(signed)) return { recorded: true as const };
    if (mode.operatorBackup) {
      const prior = signedOperatorRecoveryProofSchema.parse(mode.operatorBackup);
      if (prior.proof.operatorFingerprint !== proof.operatorFingerprint || prior.proof.verifiedAt >= proof.verifiedAt) throw new TRPCError({ code: "CONFLICT" });
      await verifyPrivateChange(key, prior.proof, prior.signature);
    }
    current(proof);
    const result = await PrivateWorkspace.updateOne({ _id: mode._id }, { $set: { operatorBackup: signed } });
    if (result.matchedCount !== 1) throw new TRPCError({ code: "CONFLICT" });
    return { recorded: true as const };
  });
}
