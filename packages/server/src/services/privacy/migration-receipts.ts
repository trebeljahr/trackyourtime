import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { canonicalJson, partitionPrivateRecovery, partitionPrivateRecoverySupplement, readersForPrivateRecord, privateInitialSnapshotRoot } from "@starter/core";
import { encryptedRecordSchema, PRIVATE_SNAPSHOT_MAX_BYTES, RECOVERY_MAX_RECORDS, signedPrivateFavoritesMigrationProofSchema, signedPrivateOwnerMigrationProofSchema, signedPrivateCombinedOwnerMigrationProofSchema, type SignedPrivateCombinedOwnerMigrationProof, type SignedPrivateOwnerMigrationProof, type EncryptedRecord, type SignedPrivateFavoritesMigrationProof } from "@starter/shared";
import { PrivateDirectory, PrivateMigrationReceipt, PrivateRecord, PrivateSnapshotChunk, PrivateSnapshotReader, PrivateWorkspace } from "../../models/PrivateData.js";
import { WorkspaceMember } from "../../models/WorkspaceMember.js";
import { fenceWorkspace, supportsBusinessTransactions, withBusinessTransaction } from "../business-transaction.js";
import { migrationFavoritesSource, workspaceRecovery } from "./recovery.js";
import { capturePrivateMigrationSupplement, workspaceRecoverySupplement } from "./recovery-supplement.js";
import { requireActivePrivatePreparation } from "./preparation.js";
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
    const mode = await PrivateWorkspace.findOne({ workspaceId, migrationId, state: "migrating" }).lean();
    if (!mode) throw new TRPCError({ code: "PRECONDITION_FAILED" });
    requireActivePrivatePreparation(mode);
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

/** Owner content and saved-file attestation, never a cutover operation. The
 * owner source excludes other members' private preferences. Complete-source
 * integrity is checked internally and its plaintext checksum is never returned.
 * A receipt cannot substitute for an independently encrypted operational copy
 * and isolated restore. Temporary plaintext checksums must retire at cutover. */
export async function recordPrivateOwnerMigrationProof(scope: { server: string; workspaceId: string; userId: string }, input: SignedPrivateOwnerMigrationProof) {
  return recordOwnerProof(scope, signedPrivateOwnerMigrationProofSchema.parse(input));
}
/** Internal only; no public submission route or source deletion is enabled. */
export async function recordPrivateCombinedOwnerMigrationProof(scope: { server: string; workspaceId: string; userId: string }, input: SignedPrivateCombinedOwnerMigrationProof) {
  return recordOwnerProof(scope, signedPrivateCombinedOwnerMigrationProofSchema.parse(input));
}
async function recordOwnerProof(scope: { server: string; workspaceId: string; userId: string }, signed: SignedPrivateOwnerMigrationProof | SignedPrivateCombinedOwnerMigrationProof) {
  const { proof } = signed;
  if (proof.server !== scope.server || proof.workspaceId !== scope.workspaceId || proof.userId !== scope.userId) throw new TRPCError({ code: "NOT_FOUND" });
  if (!await supportsBusinessTransactions()) throw new TRPCError({ code: "PRECONDITION_FAILED" });
  return withBusinessTransaction(async () => {
    const { workspaceId, userId, server } = scope, { migrationId } = proof;
    await fenceWorkspace(workspaceId);
    if (!await WorkspaceMember.exists({ workspaceId, userId, role: "owner" })) throw new TRPCError({ code: "FORBIDDEN" });
    const mode = await PrivateWorkspace.findOne({ workspaceId, migrationId, ownerId: userId, state: "migrating" }).lean();
    if (!mode) throw new TRPCError({ code: "PRECONDITION_FAILED" });
    requireActivePrivatePreparation(mode);
    const snapshot = await PrivateSnapshotReader.findOne({ workspaceId, migrationId, userId }).lean();
    const directory = await PrivateDirectory.findOne({ workspaceId }).sort({ revision: -1 }).lean();
    const owner = directory?.signed.directory.members.find((row) => row.userId === userId && row.role === "owner");
    if (!snapshot || !directory || !owner || directory.digest !== proof.directoryDigest || directory.signed.directory.ownerId !== userId || directory.signed.directory.server !== server || snapshot.signed.manifest.root !== proof.snapshotRoot || snapshot.signed.manifest.directoryDigest !== proof.directoryDigest) throw new TRPCError({ code: "CONFLICT", message: "Verify the current initial snapshot and sharing keys before approving migration." });
    await verifyPrivateChange(owner.signingPublicKey, proof, signed.signature);
    const complete = await workspaceRecovery(workspaceId, userId, true);
    const own = await workspaceRecovery(workspaceId, userId);
    const supplement = await capturePrivateMigrationSupplement(workspaceId, userId);
    const ownSupplement = await workspaceRecoverySupplement(workspaceId, userId);
    const changed = () => new TRPCError({ code: "CONFLICT", message: "Original data or encrypted snapshot changed. Make and verify a fresh backup. Source data was kept." });
    if (complete.sourceRevision !== mode.sourceRevision || own.sourceRevision !== proof.sourceRevision) throw changed();
    if (proof.v === 2) {
      if (supplement.sourceRevision !== mode.supplementRevision || ownSupplement.sourceRevision !== proof.supplementRevision) throw changed();
    } else if (mode.supplementRevision || Object.values(supplement.collections).some((rows) => rows.length)) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Supplemental originals require a verified combined recovery backup. Source data was kept." });
    }
    const records: EncryptedRecord[] = [], frozen: EncryptedRecord[] = [];
    let bytes = 2;
    const staged = PrivateRecord.find({ workspaceId }).lean().cursor({ batchSize: 10 });
    try {
      for await (const row of staged) {
        if (row.deleted || row.revision !== 1) throw changed();
        const record = encryptedRecordSchema.parse({ id: row.id, kind: row.kind, authorId: row.authorId, revision: row.revision, box: row.box, grants: row.grants });
        bytes += Buffer.byteLength(JSON.stringify(record)) + 1;
        if (bytes > PRIVATE_SNAPSHOT_MAX_BYTES || records.length >= 400_000) throw new TRPCError({ code: "PAYLOAD_TOO_LARGE" });
        const readers = readersForPrivateRecord(record.kind, record.authorId, directory.signed.directory.members).map((member) => member.userId).sort();
        if (canonicalJson(readers) !== canonicalJson(record.grants.map((grant) => grant.userId).sort())) throw changed();
        records.push(record);
      }
    } finally { await staged.close(); }
    bytes = 2;
    const chunks = PrivateSnapshotChunk.find({ workspaceId, migrationId }).sort({ index: 1 }).lean().cursor({ batchSize: 1 });
    let chunkIndex = 0;
    try {
      for await (const chunk of chunks) {
        if (chunk.index !== chunkIndex++ || !chunk.records.length) throw changed();
        bytes += Buffer.byteLength(JSON.stringify(chunk.records)) + 1;
        if (bytes > PRIVATE_SNAPSHOT_MAX_BYTES || frozen.length + chunk.records.length > 400_000) throw new TRPCError({ code: "PAYLOAD_TOO_LARGE" });
        for (const row of chunk.records) frozen.push(encryptedRecordSchema.parse(row));
      }
    } finally { await chunks.close(); }
    const address = (row: { kind: string; id: string }) => JSON.stringify([row.kind, row.id]);
    const order = (rows: EncryptedRecord[]) => rows.sort((a, b) => address(a) < address(b) ? -1 : address(a) > address(b) ? 1 : 0);
    const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
    order(records); order(frozen);
    const recordsDigest = hash(records);
    const root = await privateInitialSnapshotRoot({ server, workspaceId, migrationId, directoryDigest: directory.digest }, Buffer.from(recordsDigest, "hex").toString("base64url"));
    const addresses = (rows: readonly { kind: string; id: string; authorId: string | null }[]) => rows.map((row) => JSON.stringify([row.kind, row.id, row.authorId])).sort();
    const originals = [...partitionPrivateRecovery(complete), ...(proof.v === 2 ? partitionPrivateRecoverySupplement(supplement) : [])];
    const verifiedRecords = records.filter((row) => row.grants.some((grant) => grant.userId === userId)).length;
    if (recordsDigest !== proof.recordsDigest || hash(frozen) !== recordsDigest || snapshot.fullRecordsDigest !== recordsDigest || root !== proof.snapshotRoot || canonicalJson(addresses(records)) !== canonicalJson(addresses(originals)) || verifiedRecords !== proof.verifiedRecords || records.length - verifiedRecords !== proof.opaqueRecords) throw changed();
    const prior = await PrivateMigrationReceipt.findOne({ workspaceId, migrationId, userId, kind: "owner" }).lean();
    if (prior) {
      if (canonicalJson(prior.proof) !== canonicalJson(proof)) throw new TRPCError({ code: "CONFLICT" });
      return { recorded: true as const };
    }
    await PrivateMigrationReceipt.create({ workspaceId, migrationId, userId, kind: "owner", ...signed });
    return { recorded: true as const };
  });
}
