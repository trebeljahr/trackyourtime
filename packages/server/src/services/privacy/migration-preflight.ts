import { BSON, ObjectId } from "mongodb";
import { TRPCError } from "@trpc/server";
import { readersForPrivateRecord, type PlainPrivateRecord, type PrivateRecipient } from "@starter/core";
import { PRIVATE_SNAPSHOT_MAX_BYTES, PRIVATE_SNAPSHOT_PAGE_MAX_BYTES } from "@starter/shared";

/** Conservative sizing only, never content approval. GCM adds 16 bytes;
 * unpadded base64url expands the payload. Recipient envelopes use fixed-width
 * P-256 coordinates and a wrapped 32-byte key. Two unused key_ops entries give
 * the prototype headroom over the generated public JWK's empty key_ops array.
 * Real writes remain subject to the quota and snapshot/page checks. */
export function estimatePrivateMigrationStorage(workspaceId: string, records: readonly PlainPrivateRecord[], members: readonly PrivateRecipient[]) {
  if (!workspaceId || workspaceId.length > 100 || records.length > 400_000 || !members.length || members.length > 200 || new Set(members.map((m) => m.userId)).size !== members.length) throw new TRPCError({ code: "BAD_REQUEST" });
  const tooLarge = () => new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "Encrypted migration exceeds supported snapshot limits. Original data was kept." });
  const nonce = "A".repeat(16), keyBox = { v: 1, nonce, data: "A".repeat(82) };
  const ephemeral = { kty: "EC", crv: "P-256", x: "A".repeat(43), y: "A".repeat(43), ext: true, key_ops: ["deriveBits", "deriveKey"] };
  const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  let ciphertextBytes = 2, stagedBytes = 0, snapshotRecordsBytes = 0, grants = 0;
  const seen = new Set<string>();
  for (const row of records) {
    const address = JSON.stringify([row.kind, row.id]);
    if (seen.has(address) || !row.id || row.id.length > 100) throw new TRPCError({ code: "BAD_REQUEST" });
    seen.add(address);
    const recipients = readersForPrivateRecord(row.kind, row.authorId, members);
    if (!recipients.length) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Every private original needs a verified recipient. Source data was kept." });
    const payload = Math.ceil((size(row.value) + 16) * 4 / 3);
    if (payload > 2_000_000) throw tooLarge();
    const prototype = { id: row.id, kind: row.kind, authorId: row.authorId, revision: 1, box: { v: 1, nonce, data: "" }, grants: recipients.map((recipient) => ({ userId: recipient.userId, envelope: { v: 1, ephemeral, box: keyBox } })) };
    const json = size(prototype) + payload + 1;
    ciphertextBytes += json; grants += recipients.length;
    if (json > PRIVATE_SNAPSHOT_PAGE_MAX_BYTES - 4096 || ciphertextBytes > PRIVATE_SNAPSHOT_MAX_BYTES) throw tooLarge();
    const bson = BSON.calculateObjectSize(prototype) + payload;
    stagedBytes += Math.max(4096, BSON.calculateObjectSize({ ...prototype, workspaceId, _id: new ObjectId("000000000000000000000000"), deleted: false, createdAt: new Date(0), updatedAt: new Date(0), __v: 0 }) + payload);
    snapshotRecordsBytes += bson + 16;
  }
  // A closed size-limited chunk and its next record exceed the page bound;
  // charge up to twice the total/page plus the count-limited chunk bound.
  // This stays conservative regardless of record ordering/packing changes.
  const maxChunks = records.length ? Math.ceil(records.length / 100) + Math.ceil(2 * ciphertextBytes / (PRIVATE_SNAPSHOT_PAGE_MAX_BYTES - 4096)) : 0;
  const snapshotBytes = snapshotRecordsBytes + maxChunks * 4096;
  // Reserve worst-case reader locations plus one temporary receipt per member
  // and a mode row. Directory history is already charged before preparation.
  const metadataBytes = members.length * (16_384 + maxChunks * 80) + 8192;
  return { records: records.length, grants, maxChunks, ciphertextBytes, stagedBytes, snapshotBytes, metadataBytes, additionalBytes: stagedBytes + snapshotBytes + metadataBytes };
}
