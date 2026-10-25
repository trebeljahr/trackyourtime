import { TRPCError } from "@trpc/server";
import { canonicalJson, privateInitialSnapshotProjection, privateRecordDigest } from "@starter/core";
import { encryptedRecordSchema, PRIVATE_SNAPSHOT_MAX_BYTES, PRIVATE_SNAPSHOT_PAGE_MAX_BYTES, signedPrivateInitialProjectionRootSchema, type EncryptedRecord, type SignedPrivateInitialProjectionRoot } from "@starter/shared";
import { PrivateProjectionRoot, PrivateProjectionReader, PrivateSnapshotChunk, PrivateSnapshotReader, PrivateWorkspace } from "../../models/PrivateData.js";
import { WorkspaceMember } from "../../models/WorkspaceMember.js";
import { fenceWorkspace, supportsBusinessTransactions, withBusinessTransaction } from "../business-transaction.js";
import { captureCompleteProjectionPreparation, isPersonalPrivateKind, type ProjectionPreparationScope } from "./projection-proposal.js";
import { requireActivePrivatePreparation } from "./preparation.js";
import { verifyPrivateChange } from "./signatures.js";
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const incomplete = () => new TRPCError({ code: "PRECONDITION_FAILED", message: "Initial projection storage is incomplete. Original data was kept." });
type Location = { chunk: number; before: number; count: number };
const visible = (rows: readonly EncryptedRecord[], userId: string, lane: "shared" | "personal") => rows.filter((row) => (lane === "personal" ? isPersonalPrivateKind(row.kind) && row.authorId === userId : !isPersonalPrivateKind(row.kind)) && row.grants.some((grant) => grant.userId === userId));
function locations(chunks: readonly EncryptedRecord[][], userId: string, lane: "shared" | "personal"): Location[] {
  let before = 0; const result: Location[] = [];
  chunks.forEach((chunk, index) => { const count = visible(chunk, userId, lane).length; if (count) { result.push({ chunk: index, before, count }); before += count; } });
  return result;
}
function chunksFor(records: readonly EncryptedRecord[]): EncryptedRecord[][] {
  const chunks: EncryptedRecord[][] = []; let chunk: EncryptedRecord[] = [], bytes = 2;
  for (const record of records) {
    const added = size(record) + 1;
    if (added > PRIVATE_SNAPSHOT_PAGE_MAX_BYTES - 4096) throw new TRPCError({ code: "PAYLOAD_TOO_LARGE" });
    if (chunk.length && (chunk.length >= 100 || bytes + added > PRIVATE_SNAPSHOT_PAGE_MAX_BYTES - 4096)) { chunks.push(chunk); chunk = []; bytes = 2; }
    chunk.push(record); bytes += added;
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}
/** Freeze one common signed v3 root and bounded immutable chunks. Every
 * reader's shared/personal digest is recomputed from the complete staged set.
 * This never changes mode, verifies operational backups or removes originals. */
export async function preparePrivateProjectionSnapshot(scope: ProjectionPreparationScope, input: SignedPrivateInitialProjectionRoot) {
  const { root } = await prepareProjectionSnapshot(scope, input, false);
  return { root };
}
/** Server-internal complete capture for receipt/cutover verification only.
 * Never return this object from a user API. Requires already-frozen storage. */
export async function capturePreparedPrivateProjection(scope: ProjectionPreparationScope) {
  scope = { ...scope };
  if (!await supportsBusinessTransactions()) throw new TRPCError({ code: "PRECONDITION_FAILED" });
  return withBusinessTransaction(async () => {
    await fenceWorkspace(scope.workspaceId);
    const stored = await PrivateProjectionRoot.findOne({ workspaceId: scope.workspaceId, migrationId: scope.migrationId }).lean();
    if (!stored) throw incomplete();
    const checked = await prepareProjectionSnapshot(scope, stored.signed, true);
    if (checked.root !== stored.root) throw incomplete();
    return { ...checked.captured, signed: stored.signed, root: checked.root };
  });
}
async function prepareProjectionSnapshot(scope: ProjectionPreparationScope, input: SignedPrivateInitialProjectionRoot, existingOnly: boolean) {
  scope = { ...scope };
  if (size(input) > 256 * 1024) throw new TRPCError({ code: "PAYLOAD_TOO_LARGE" });
  const signed = signedPrivateInitialProjectionRootSchema.parse(input), { manifest } = signed;
  if (!await supportsBusinessTransactions()) throw new TRPCError({ code: "PRECONDITION_FAILED" });
  return withBusinessTransaction(async () => {
    const { workspaceId, migrationId, userId, server } = scope;
    const captured = await captureCompleteProjectionPreparation(scope), directory = captured.directory;
    const owner = directory.signed.directory.members.find((member) => member.userId === userId)!;
    if (manifest.server !== server || manifest.workspaceId !== workspaceId || manifest.migrationId !== migrationId || manifest.directoryDigest !== directory.digest || manifest.signerId !== userId || canonicalJson(manifest.readers.map((reader) => reader.userId)) !== canonicalJson(directory.signed.directory.members.map((member) => member.userId))) throw new TRPCError({ code: "BAD_REQUEST" });
    await verifyPrivateChange(owner.signingPublicKey, manifest, signed.signature);
    for (const reader of manifest.readers) {
      const shared = privateInitialSnapshotProjection(visible(captured.records, reader.userId, "shared"), reader.userId);
      const personal = visible(captured.records, reader.userId, "personal");
      if (reader.sharedDigest !== await privateRecordDigest(shared) || reader.personalDigest !== await privateRecordDigest(personal)) throw new TRPCError({ code: "BAD_REQUEST", message: "Projection root does not match staged ciphertext." });
    }
    if (await PrivateSnapshotReader.exists({ workspaceId, migrationId })) throw new TRPCError({ code: "CONFLICT", message: "A different snapshot protocol is already prepared. Cancel before restarting." });
    const root = await privateRecordDigest(manifest), chunks = chunksFor(captured.records);
    const readers = manifest.readers.map((reader) => ({ workspaceId, migrationId, userId: reader.userId, sharedLocations: locations(chunks, reader.userId, "shared"), personalLocations: locations(chunks, reader.userId, "personal") }));
    const prior = await PrivateProjectionRoot.findOne({ workspaceId, migrationId }).lean();
    if (prior) {
      if (prior.root !== root || prior.fullRecordsDigest !== captured.fullRecordsDigest || canonicalJson(prior.signed.manifest) !== canonicalJson(manifest)) throw new TRPCError({ code: "CONFLICT" });
      const cursor = PrivateSnapshotChunk.find({ workspaceId, migrationId }).sort({ index: 1 }).lean().cursor({ batchSize: 1 });
      let bytes = 2, count = 0;
      try {
        for await (const chunk of cursor) {
          bytes += size(chunk.records) + 1;
          if (bytes > PRIVATE_SNAPSHOT_MAX_BYTES || count >= chunks.length || chunk.index !== count || canonicalJson(chunk.records) !== canonicalJson(chunks[count])) throw incomplete();
          count++;
        }
      } finally { await cursor.close(); }
      if (count !== chunks.length) throw incomplete();
      const storedReaders = await PrivateProjectionReader.find({ workspaceId, migrationId }).lean();
      if (storedReaders.length !== readers.length || readers.some((reader) => {
        const stored = storedReaders.find((row) => row.userId === reader.userId);
        return !stored || canonicalJson(stored.sharedLocations) !== canonicalJson(reader.sharedLocations) || canonicalJson(stored.personalLocations) !== canonicalJson(reader.personalLocations);
      })) throw incomplete();
      return { root, captured };
    }
    if (existingOnly) throw incomplete();
    if (await PrivateSnapshotChunk.exists({ workspaceId, migrationId }) || await PrivateProjectionReader.exists({ workspaceId, migrationId })) throw incomplete();
    for (let index = 0; index < chunks.length; index++) await PrivateSnapshotChunk.create({ workspaceId, migrationId, index, records: chunks[index] });
    await PrivateProjectionReader.insertMany(readers);
    await PrivateProjectionRoot.create({ workspaceId, migrationId, root, fullRecordsDigest: captured.fullRecordsDigest, signed });
    return { root, captured };
  });
}
async function readerScope(scope: { server: string; workspaceId: string; userId: string }) {
  if (!await WorkspaceMember.exists({ workspaceId: scope.workspaceId, userId: scope.userId })) throw new TRPCError({ code: "NOT_FOUND" });
  const mode = await PrivateWorkspace.findOne({ workspaceId: scope.workspaceId }).lean();
  if (!mode) throw new TRPCError({ code: "NOT_FOUND" });
  if (mode.state === "migrating") requireActivePrivatePreparation(mode);
  const root = await PrivateProjectionRoot.findOne({ workspaceId: scope.workspaceId, migrationId: mode.migrationId }).lean();
  const reader = await PrivateProjectionReader.findOne({ workspaceId: scope.workspaceId, migrationId: mode.migrationId, userId: scope.userId }).lean();
  if (!root || !reader || root.signed.manifest.server !== scope.server) throw new TRPCError({ code: "NOT_FOUND" });
  if (root.root !== await privateRecordDigest(root.signed.manifest)) throw incomplete();
  if (mode.state === "encrypted" && (mode.revision < 1 || !mode.head || !/^[A-Za-z0-9_-]{43}$/.test(mode.head) || (mode.revision === 1 && mode.head !== root.root) || mode.directoryDigest !== root.signed.manifest.directoryDigest)) throw new TRPCError({ code: "PRECONDITION_FAILED" });
  return { root, reader };
}
/** Internal transport; no public route is mounted. Physical locations and
 * unrelated private counts/IDs stay server-side. Reads share the erasure fence. */
export async function privateProjectionSnapshotRoot(scope: { server: string; workspaceId: string; userId: string }) {
  scope = { ...scope };
  if (!await supportsBusinessTransactions()) throw new TRPCError({ code: "PRECONDITION_FAILED" });
  return withBusinessTransaction(async () => { await fenceWorkspace(scope.workspaceId); return (await readerScope(scope)).root.signed; });
}
export async function privateProjectionSnapshotPage(scope: { server: string; workspaceId: string; userId: string; migrationId: string }, lane: "shared" | "personal", offset: number) {
  scope = { ...scope };
  if ((lane !== "shared" && lane !== "personal") || !Number.isSafeInteger(offset) || offset < 0 || offset > 400_000) throw new TRPCError({ code: "BAD_REQUEST" });
  if (!await supportsBusinessTransactions()) throw new TRPCError({ code: "PRECONDITION_FAILED" });
  return withBusinessTransaction(async () => {
    await fenceWorkspace(scope.workspaceId);
    const { root, reader } = await readerScope(scope);
    if (root.migrationId !== scope.migrationId) throw new TRPCError({ code: "NOT_FOUND" });
    const index = lane === "shared" ? reader.sharedLocations : reader.personalLocations;
    const total = index.reduce((sum, location) => sum + location.count, 0);
    if (offset > total) throw new TRPCError({ code: "BAD_REQUEST" });
    const records: EncryptedRecord[] = []; let bytes = 2;
    for (const location of index) {
      if (offset >= location.before + location.count) continue;
      const chunk = await PrivateSnapshotChunk.findOne({ workspaceId: scope.workspaceId, migrationId: scope.migrationId, index: location.chunk }).lean();
      if (!chunk) throw incomplete();
      const rows = privateInitialSnapshotProjection(visible(chunk.records, scope.userId, lane), scope.userId);
      if (rows.length !== location.count) throw incomplete();
      for (const row of rows.slice(Math.max(0, offset - location.before))) {
        const record = encryptedRecordSchema.parse(row), added = size(record) + 1;
        if (records.length && (records.length >= 100 || bytes + added > PRIVATE_SNAPSHOT_PAGE_MAX_BYTES)) return { offset, next: offset + records.length, records };
        if (bytes + added > PRIVATE_SNAPSHOT_PAGE_MAX_BYTES) throw new TRPCError({ code: "PAYLOAD_TOO_LARGE" });
        records.push(record); bytes += added;
      }
    }
    return { offset, next: null, records };
  });
}
