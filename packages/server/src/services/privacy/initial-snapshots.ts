import { createHash } from "node:crypto";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { canonicalJson, privateInitialSnapshotProjection, privateInitialSnapshotRoot, privateRecordDigest } from "@starter/core";
import { encryptedRecordSchema, PRIVATE_SNAPSHOT_MAX_BYTES, PRIVATE_SNAPSHOT_PAGE_MAX_BYTES, signedPrivateInitialSnapshotSchema, type EncryptedRecord, type SignedPrivateInitialSnapshot } from "@starter/shared";
import { PrivateDirectory, PrivateRecord, PrivateSnapshotChunk, PrivateSnapshotReader, PrivateWorkspace } from "../../models/PrivateData.js";
import { WorkspaceMember } from "../../models/WorkspaceMember.js";
import { fenceWorkspace, supportsBusinessTransactions, withBusinessTransaction } from "../business-transaction.js";
import { privateReaders } from "./access.js";
import { verifyPrivateChange } from "./signatures.js";

const address = (row: { kind: string; id: string }) => JSON.stringify([row.kind, row.id]);
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const incomplete = () => new TRPCError({ code: "PRECONDITION_FAILED", message: "Initial snapshot storage is incomplete. Source data was kept." });
type Scope = { server: string; workspaceId: string; migrationId: string; userId: string };

/** Internal preparation only. It freezes the staged ciphertext and checks
 * every signed projection. It neither approves source conversion nor deletes
 * plaintext. Public conversion remains behind the unconditional rollout guard. */
export async function preparePrivateInitialSnapshot(scope: Scope, input: readonly SignedPrivateInitialSnapshot[]) {
  if (size(input) > 256 * 1024) throw new TRPCError({ code: "PAYLOAD_TOO_LARGE" });
  const readers = z.array(signedPrivateInitialSnapshotSchema).min(1).max(200).parse(input);
  if (!await supportsBusinessTransactions()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Initial snapshots require MongoDB transactions." });
  return withBusinessTransaction(async () => {
    const { workspaceId, userId, migrationId, server } = scope;
    await fenceWorkspace(workspaceId);
    if (!await WorkspaceMember.exists({ workspaceId, userId, role: "owner" })) throw new TRPCError({ code: "FORBIDDEN" });
    const mode = await PrivateWorkspace.findOne({ workspaceId, migrationId, ownerId: userId }).lean();
    if (!mode) throw new TRPCError({ code: "NOT_FOUND" });
    const directory = await PrivateDirectory.findOne({ workspaceId, digest: readers[0]!.manifest.directoryDigest }).lean();
    const owner = directory?.signed.directory.members.find((member) => member.userId === directory.signed.directory.ownerId);
    if (!directory || !owner || owner.userId !== userId || directory.signed.directory.server !== server) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Verify the workspace key directory before preparing its snapshot." });
    const readerIds = readers.map((row) => row.manifest.readerId).sort();
    if (new Set(readerIds).size !== readerIds.length || canonicalJson(readerIds) !== canonicalJson(directory.signed.directory.members.map((m) => m.userId).sort())) throw new TRPCError({ code: "BAD_REQUEST", message: "Every member needs exactly one signed initial snapshot." });
    for (const signed of readers) {
      const manifest = signed.manifest;
      if (manifest.server !== server || manifest.workspaceId !== workspaceId || manifest.migrationId !== migrationId || manifest.directoryDigest !== directory.digest || manifest.signerId !== userId) throw new TRPCError({ code: "BAD_REQUEST", message: "Initial snapshot belongs to another scope." });
      await verifyPrivateChange(owner.signingPublicKey, manifest, signed.signature);
    }
    const existing = await PrivateSnapshotReader.find({ workspaceId, migrationId }).lean();
    if (existing.length) {
      if (existing.length !== readers.length || readers.some((row) => canonicalJson(existing.find((prior) => prior.userId === row.manifest.readerId)?.signed.manifest) !== canonicalJson(row.manifest)) || new Set(existing.map((row) => row.fullRecordsDigest)).size !== 1) throw new TRPCError({ code: "CONFLICT", message: "The initial snapshot was already prepared with different data." });
      return { migrationId, recordsDigest: existing[0]!.fullRecordsDigest };
    }
    if (mode.state !== "migrating" || await PrivateSnapshotChunk.exists({ workspaceId, migrationId })) throw incomplete();
    const latest = await PrivateDirectory.findOne({ workspaceId }).sort({ revision: -1 }).lean();
    if (latest?.digest !== directory.digest) throw new TRPCError({ code: "CONFLICT", message: "Workspace sharing keys changed." });
    const members = await WorkspaceMember.find({ workspaceId }).sort({ userId: 1 }).lean();
    const actual = members.map((m) => ({ userId: m.userId, role: m.role, canViewOthersTime: m.role === "owner" || m.canViewOthersTime, canViewOthersMoney: m.role === "owner" || m.canViewOthersMoney }));
    const expected = directory.signed.directory.members.map(({ userId: id, role, canViewOthersTime, canViewOthersMoney }) => ({ userId: id, role, canViewOthersTime, canViewOthersMoney }));
    if (canonicalJson(actual) !== canonicalJson(expected)) throw new TRPCError({ code: "CONFLICT", message: "Workspace permissions changed." });
    if (await PrivateRecord.exists({ workspaceId, deleted: true })) throw new TRPCError({ code: "CONFLICT", message: "An initial snapshot cannot contain deleted staged records." });
    const records: EncryptedRecord[] = [];
    let bytes = 2;
    const cursor = PrivateRecord.find({ workspaceId }).lean().cursor({ batchSize: 10 });
    try {
      for await (const row of cursor) {
        const record = encryptedRecordSchema.parse({ id: row.id, kind: row.kind, authorId: row.authorId, revision: row.revision, box: row.box, grants: row.grants });
        bytes += size(record) + 1;
        if (bytes > PRIVATE_SNAPSHOT_MAX_BYTES || records.length >= 400_000) throw new TRPCError({ code: "PAYLOAD_TOO_LARGE" });
        const audience = record.grants.map((grant) => grant.userId).sort();
        if (record.revision !== 1 || new Set(audience).size !== audience.length || canonicalJson(audience) !== canonicalJson(privateReaders(record.kind, record.authorId, members))) throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid initial snapshot revision or audience." });
        records.push(record);
      }
    } finally { await cursor.close(); }
    records.sort((a, b) => address(a) < address(b) ? -1 : address(a) > address(b) ? 1 : 0);
    const chunks: EncryptedRecord[][] = [];
    let chunk: EncryptedRecord[] = [], chunkBytes = 2;
    for (const row of records) {
      const rowBytes = size(row) + 1;
      if (rowBytes > PRIVATE_SNAPSHOT_PAGE_MAX_BYTES - 4096) throw new TRPCError({ code: "PAYLOAD_TOO_LARGE" });
      if (chunk.length && (chunk.length >= 100 || chunkBytes + rowBytes > PRIVATE_SNAPSHOT_PAGE_MAX_BYTES - 4096)) { chunks.push(chunk); chunk = []; chunkBytes = 2; }
      chunk.push(row); chunkBytes += rowBytes;
    }
    if (chunk.length) chunks.push(chunk);
    const fullRecordsDigest = createHash("sha256").update(canonicalJson(records)).digest("hex");
    const root = await privateInitialSnapshotRoot({ server, workspaceId, migrationId, directoryDigest: directory.digest }, Buffer.from(fullRecordsDigest, "hex").toString("base64url"));
    const storedReaders = [];
    for (const signed of readers) {
      const projection = privateInitialSnapshotProjection(records, signed.manifest.readerId);
      if (signed.manifest.root !== root || projection.length !== signed.manifest.recordCount || await privateRecordDigest(projection) !== signed.manifest.recordsDigest) throw new TRPCError({ code: "BAD_REQUEST", message: "Initial snapshot does not match its signed delivery manifest." });
      let before = 0;
      const locations: { chunk: number; before: number; count: number }[] = [];
      for (let index = 0; index < chunks.length; index++) {
        const count = chunks[index]!.filter((row) => row.grants.some((grant) => grant.userId === signed.manifest.readerId)).length;
        if (count) { locations.push({ chunk: index, before, count }); before += count; }
      }
      storedReaders.push({ workspaceId, migrationId, userId: signed.manifest.readerId, fullRecordsDigest, signed, locations });
    }
    for (let index = 0; index < chunks.length; index++) await PrivateSnapshotChunk.create({ workspaceId, migrationId, index, records: chunks[index] });
    await PrivateSnapshotReader.insertMany(storedReaders);
    return { migrationId, recordsDigest: fullRecordsDigest };
  });
}

export async function privateInitialSnapshotManifest(workspaceId: string, userId: string): Promise<SignedPrivateInitialSnapshot> {
  if (!await WorkspaceMember.exists({ workspaceId, userId })) throw new TRPCError({ code: "NOT_FOUND" });
  const mode = await PrivateWorkspace.findOne({ workspaceId }).lean();
  if (!mode) throw new TRPCError({ code: "PRECONDITION_FAILED" });
  const reader = await PrivateSnapshotReader.findOne({ workspaceId, migrationId: mode.migrationId, userId }).lean();
  if (!reader) throw incomplete();
  return reader.signed;
}

export async function privateInitialSnapshotPage(workspaceId: string, userId: string, migrationId: string, offset: number) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new TRPCError({ code: "BAD_REQUEST" });
  if (!await WorkspaceMember.exists({ workspaceId, userId })) throw new TRPCError({ code: "NOT_FOUND" });
  const reader = await PrivateSnapshotReader.findOne({ workspaceId, migrationId, userId }).lean();
  if (!reader || !await PrivateWorkspace.exists({ workspaceId, migrationId })) throw new TRPCError({ code: "NOT_FOUND" });
  const count = reader.signed.manifest.recordCount;
  if (offset > count) throw new TRPCError({ code: "BAD_REQUEST" });
  if (offset === count) return { offset, next: null, records: [] };
  const start = reader.locations.findIndex((location) => location.before <= offset && offset < location.before + location.count);
  if (start < 0) throw incomplete();
  const records: EncryptedRecord[] = [];
  let bytes = 128, scanned = 0;
  for (const location of reader.locations.slice(start)) {
    if (records.length && scanned >= 8 * 1024 * 1024) break;
    const chunk = await PrivateSnapshotChunk.findOne({ workspaceId, migrationId, index: location.chunk }).lean();
    if (!chunk) throw incomplete();
    scanned += size(chunk.records);
    const projection = privateInitialSnapshotProjection(chunk.records, userId), skip = Math.max(0, offset - location.before);
    if (projection.length !== location.count || location.before + skip !== offset + records.length) throw incomplete();
    for (const row of projection.slice(skip)) {
      const rowBytes = size(row) + 1;
      if (records.length && (records.length >= 100 || bytes + rowBytes > PRIVATE_SNAPSHOT_PAGE_MAX_BYTES)) return { offset, next: offset + records.length, records };
      if (bytes + rowBytes > PRIVATE_SNAPSHOT_PAGE_MAX_BYTES) throw new TRPCError({ code: "PAYLOAD_TOO_LARGE" });
      records.push(row); bytes += rowBytes;
    }
  }
  if (!records.length || offset + records.length > count) throw incomplete();
  return { offset, next: offset + records.length < count ? offset + records.length : null, records };
}
