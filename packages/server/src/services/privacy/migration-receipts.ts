import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { canonicalJson, partitionPrivateRecovery } from "@starter/core";
import { encryptedRecordSchema, PRIVATE_SNAPSHOT_MAX_BYTES, RECOVERY_MAX_RECORDS, signedPrivateFavoritesMigrationProofSchema, type EncryptedRecord, type SignedPrivateFavoritesMigrationProof } from "@starter/shared";
import { PrivateDirectory, PrivateMigrationReceipt, PrivateRecord, PrivateSnapshotChunk, PrivateSnapshotReader, PrivateWorkspace } from "../../models/PrivateData.js";
import { WorkspaceMember } from "../../models/WorkspaceMember.js";
import { fenceWorkspace, supportsBusinessTransactions, withBusinessTransaction } from "../business-transaction.js";
import { migrationFavoritesSource } from "./recovery.js";
import { verifyPrivateChange } from "./signatures.js";

/** Internal acknowledgement engine; it never changes workspace mode or wipes
 * source data. Public submission remains behind the rollout guard. */
export async function recordPrivateFavoritesMigrationProof(scope: { server: string; workspaceId: string; userId: string }, input: SignedPrivateFavoritesMigrationProof) {
  const signed = signedPrivateFavoritesMigrationProofSchema.parse(input), { proof } = signed;
  if (proof.server !== scope.server || proof.workspaceId !== scope.workspaceId || proof.userId !== scope.userId) throw new TRPCError({ code: "NOT_FOUND" });
  if (!await supportsBusinessTransactions()) throw new TRPCError({ code: "PRECONDITION_FAILED" });
  return withBusinessTransaction(async () => {
    const { workspaceId, userId } = scope, { migrationId } = proof;
    await fenceWorkspace(workspaceId);
    if (!await WorkspaceMember.exists({ workspaceId, userId })) throw new TRPCError({ code: "NOT_FOUND" });
    if (!await PrivateWorkspace.exists({ workspaceId, migrationId, state: "migrating" })) throw new TRPCError({ code: "PRECONDITION_FAILED" });
    const snapshot = await PrivateSnapshotReader.findOne({ workspaceId, migrationId, userId }).lean();
    if (!snapshot || snapshot.signed.manifest.root !== proof.snapshotRoot || snapshot.signed.manifest.directoryDigest !== proof.directoryDigest) throw new TRPCError({ code: "CONFLICT", message: "Verify the current initial snapshot before acknowledging preferences." });
    const directory = await PrivateDirectory.findOne({ workspaceId, digest: proof.directoryDigest }).lean();
    const member = directory?.signed.directory.members.find((row) => row.userId === userId);
    if (!member || directory?.signed.directory.server !== scope.server) throw new TRPCError({ code: "PRECONDITION_FAILED" });
    await verifyPrivateChange(member.signingPublicKey, proof, signed.signature);
    const source = await migrationFavoritesSource(workspaceId, userId, migrationId);
    const expected = partitionPrivateRecovery(source);
    const records: EncryptedRecord[] = [];
    const cursor = PrivateRecord.find({ workspaceId, kind: "favorites", authorId: userId }).lean().cursor({ batchSize: 10 });
    let bytes = 2;
    try {
      for await (const row of cursor) {
        if (row.deleted || row.revision !== 1) throw new TRPCError({ code: "CONFLICT" });
        const record = encryptedRecordSchema.parse({ id: row.id, kind: row.kind, authorId: row.authorId, revision: row.revision, box: row.box, grants: row.grants });
        bytes += Buffer.byteLength(JSON.stringify(record)) + 1;
        if (records.length >= RECOVERY_MAX_RECORDS || bytes > PRIVATE_SNAPSHOT_MAX_BYTES) throw new TRPCError({ code: "PAYLOAD_TOO_LARGE" });
        records.push(record);
      }
    } finally { await cursor.close(); }
    const ordered = (rows: EncryptedRecord[]) => rows.sort((a, b) => JSON.stringify([a.kind, a.id]) < JSON.stringify([b.kind, b.id]) ? -1 : JSON.stringify([a.kind, a.id]) > JSON.stringify([b.kind, b.id]) ? 1 : 0);
    ordered(records);
    const frozen: EncryptedRecord[] = [];
    const chunks = PrivateSnapshotChunk.find({ workspaceId, migrationId, records: { $elemMatch: { kind: "favorites", authorId: userId } } }).lean().cursor({ batchSize: 1 });
    let scanned = 0;
    try {
      for await (const chunk of chunks) {
        scanned += Buffer.byteLength(JSON.stringify(chunk.records));
        if (scanned > PRIVATE_SNAPSHOT_MAX_BYTES) throw new TRPCError({ code: "PAYLOAD_TOO_LARGE" });
        for (const row of chunk.records) if (row.kind === "favorites" && row.authorId === userId) {
          if (frozen.length >= RECOVERY_MAX_RECORDS) throw new TRPCError({ code: "PAYLOAD_TOO_LARGE" });
          frozen.push(encryptedRecordSchema.parse(row));
        }
      }
    } finally { await chunks.close(); }
    ordered(frozen);
    const addresses = (items: readonly { id: string; authorId: string | null }[]) => items.map((row) => JSON.stringify([row.id, row.authorId])).sort();
    const digest = createHash("sha256").update(canonicalJson(records)).digest("hex");
    const frozenDigest = createHash("sha256").update(canonicalJson(frozen)).digest("hex");
    if (source.sourceRevision !== proof.sourceRevision || records.length !== proof.verifiedRecords || canonicalJson(addresses(records)) !== canonicalJson(addresses(expected)) || records.some((row) => row.grants.length !== 1 || row.grants[0]!.userId !== userId) || digest !== proof.recordsDigest || frozenDigest !== digest) throw new TRPCError({ code: "CONFLICT", message: "Preferences changed or the receipt does not match staged and frozen ciphertext. Source data was kept." });
    const prior = await PrivateMigrationReceipt.findOne({ workspaceId, migrationId, userId, kind: "favorites" }).lean();
    if (prior) {
      if (canonicalJson(prior.proof) !== canonicalJson(proof)) throw new TRPCError({ code: "CONFLICT" });
      return { recorded: true as const };
    }
    await PrivateMigrationReceipt.create({ workspaceId, migrationId, userId, kind: "favorites", ...signed });
    return { recorded: true as const };
  });
}
