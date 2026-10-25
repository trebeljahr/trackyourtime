import assert from "node:assert/strict";
import { it } from "node:test";
import { BSON, ObjectId } from "mongodb";
import { createKeyPair, encryptPrivateRecord, type PlainPrivateRecord, type PrivateRecipient } from "@starter/core";
import { estimatePrivateMigrationStorage } from "../services/privacy/migration-preflight.js";
const WS = "workspace";
async function people(count: number): Promise<PrivateRecipient[]> {
  const pair = await createKeyPair();
  return Array.from({ length: count }, (_, index) => ({ userId: index ? `Reader \u0000€${index}` : "owner", role: index ? "member" as const : "owner" as const, canViewOthersTime: false, canViewOthersMoney: false, publicKey: pair.publicKey }));
}
it("bounds real UTF-8 ciphertext, every recipient envelope and materialized BSON without encrypting source during sizing", async () => {
  const members = await people(4);
  const plain: PlainPrivateRecord[] = [
    { id: "tag", kind: "tags", authorId: null, value: { workspaceId: WS, name: 'Exact € 漢字 \\" '.repeat(1000) } },
    { id: "favorite", kind: "favorites", authorId: members[1]!.userId, value: { _id: "favorite", workspaceId: WS, userId: members[1]!.userId, description: "Private original" } },
  ];
  const estimate = estimatePrivateMigrationStorage(WS, plain, members), encrypted = [];
  for (const row of plain) encrypted.push(await encryptPrivateRecord(WS, row, members, 1));
  assert.equal(estimate.grants, 5);
  assert.ok(Buffer.byteLength(JSON.stringify(encrypted)) <= estimate.ciphertextBytes);
  const actual = encrypted.reduce((total, record) => total + Math.max(4096, BSON.calculateObjectSize({ ...record, workspaceId: WS, _id: new ObjectId(), deleted: false, createdAt: new Date(), updatedAt: new Date(), __v: 0 })), 0);
  assert.ok(actual <= estimate.stagedBytes);
  assert.ok(BSON.calculateObjectSize({ workspaceId: WS, migrationId: "x".repeat(36), index: 0, records: encrypted, _id: new ObjectId(), createdAt: new Date(), updatedAt: new Date(), __v: 0 }) <= estimate.snapshotBytes);
  assert.ok(estimate.additionalBytes > actual + estimate.snapshotBytes);
});
it("rejects recipient expansion beyond the complete snapshot cap before doing record encryption", async () => {
  const members = await people(200);
  const records: PlainPrivateRecord[] = Array.from({ length: 1500 }, (_, index) => ({ kind: "tags", id: `tag-${index}`, authorId: null, value: { workspaceId: WS, name: "Small original" } }));
  assert.throws(() => estimatePrivateMigrationStorage(WS, records, members), { code: "PAYLOAD_TOO_LARGE" });
});
it("rejects a single oversized payload, orphaned private originals and duplicate namespaces", async () => {
  const members = await people(1), tag: PlainPrivateRecord = { kind: "tags", id: "tag", authorId: null, value: { name: "x".repeat(1_500_000) } };
  assert.throws(() => estimatePrivateMigrationStorage(WS, [tag], members), { code: "PAYLOAD_TOO_LARGE" });
  const favorite: PlainPrivateRecord = { kind: "favorites", id: "private", authorId: "departed", value: { workspaceId: WS, userId: "departed" } };
  assert.throws(() => estimatePrivateMigrationStorage(WS, [favorite], members), /verified recipient/);
  assert.throws(() => estimatePrivateMigrationStorage(WS, [{ ...tag, value: {} }, { ...tag, value: {} }], members), { code: "BAD_REQUEST" });
});
