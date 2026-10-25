import assert from "node:assert/strict";
import { before, beforeEach, after, describe, it } from "node:test";
import mongoose from "mongoose";
import { createKeyPair, encryptPrivateRecord } from "@starter/core";
process.env.STORAGE_QUOTA_BYTES = "65536";
const { PrivateRecord, PrivateWorkspaceCommit, PrivateSnapshotChunk, PrivateSnapshotReader, PrivateWorkspace } = await import("../models/PrivateData.js");
const { WorkspaceMember } = await import("../models/WorkspaceMember.js");
const { TimeEntry } = await import("../models/TimeEntry.js");
const { StorageUsage, StorageFence } = await import("../models/StorageUsage.js");
const { withBusinessTransaction } = await import("../services/business-transaction.js");
const { clearTestDatabase, connectTestDatabase, dropTestDatabase, skipWithoutDatabase } = await import("./support/test-database.js");
const WS = "private-quota", USER = "owner";
const used = async (workspaceId = WS) => (await StorageUsage.findById(workspaceId).lean())?.bytes ?? 0;
const isQuota = (error: unknown) => error instanceof Error && "code" in error && error.code === "PRECONDITION_FAILED" && error.message.startsWith("Storage limit reached");
async function cipher(id: string, content = "Saved private work", recipients = 1, workspaceId = WS) {
  const pair = await createKeyPair();
  const people = Array.from({ length: recipients }, (_, index) => ({ userId: index ? `reader-${index}` : USER, role: "member" as const, canViewOthersTime: false, canViewOthersMoney: false, publicKey: pair.publicKey }));
  return encryptPrivateRecord(workspaceId, { kind: "tags", id, authorId: null, value: { workspaceId, name: content } }, people, 1);
}
describe("encrypted storage budgets", { skip: skipWithoutDatabase }, () => {
  before(() => connectTestDatabase("privacy-storage-quota", [PrivateRecord, PrivateWorkspaceCommit, PrivateSnapshotChunk, PrivateSnapshotReader, PrivateWorkspace, WorkspaceMember, TimeEntry, StorageUsage, StorageFence] as never));
  beforeEach(async () => {
    await clearTestDatabase();
    await WorkspaceMember.create({ workspaceId: WS, userId: USER, role: "owner", name: "Owner" });
    await PrivateWorkspace.create({ workspaceId: WS, ownerId: USER, state: "encrypted", revision: 1, migrationId: crypto.randomUUID(), sourceRevision: "retired", leaseUntil: new Date(0) });
  });
  after(dropTestDatabase);
  it("charges materialized ciphertext, immutable snapshot/journal duplicates and per-reader indexes", async () => {
    const row = await cipher("tag", "x".repeat(10_000));
    await PrivateRecord.create({ workspaceId: WS, ...row }); const materialized = await used();
    await PrivateSnapshotChunk.create({ workspaceId: WS, migrationId: "migration", index: 0, records: [row] }); const snapshot = await used();
    assert.ok(snapshot > materialized + 10_000);
    await PrivateSnapshotReader.create({ workspaceId: WS, migrationId: "migration", userId: USER, fullRecordsDigest: "opaque", signed: {}, locations: [] });
    assert.equal(await used(), snapshot + 4096);
    await PrivateWorkspaceCommit.create({ workspaceId: WS, userId: USER, operationId: crypto.randomUUID(), revision: 2, manifest: {}, signature: "opaque", readerSignatures: [], records: [row] });
    assert.ok(await used() > snapshot + 14_000);
    await assert.rejects(PrivateSnapshotChunk.create({ workspaceId: WS, migrationId: "migration", index: 1, records: [row] }), isQuota);
    assert.equal(await PrivateSnapshotChunk.countDocuments(), 1);
    await assert.rejects(TimeEntry.create({ workspaceId: WS, authorId: USER, description: "No plaintext fallback", start: new Date(), end: new Date() }), { code: "PRECONDITION_FAILED", message: "PRIVATE_WORKSPACE_REQUIRES_UNLOCK" });
  });
  it("counts grant expansion and rolls an oversized batch back without changing existing data or usage", async () => {
    const row = await cipher("many-readers", "small", 200), before = await used();
    await assert.rejects(PrivateRecord.create({ workspaceId: WS, ...row }), isQuota);
    assert.equal(await PrivateRecord.countDocuments(), 0); assert.equal(await used(), before);
    const small = await cipher("one");
    await assert.rejects(withBusinessTransaction(async () => {
      await PrivateRecord.create({ workspaceId: WS, ...small });
      await PrivateRecord.create({ workspaceId: WS, ...await cipher("large", "x".repeat(60_000)) });
    }), isQuota);
    assert.equal(await PrivateRecord.countDocuments(), 0); assert.equal(await used(), before);
  });
  it("rebaselines version-one ledgers from actual private BSON and allows shrinking over-budget data", async () => {
    const row = await cipher("legacy", "x".repeat(60_000));
    await PrivateRecord.collection.insertOne({ workspaceId: WS, ...row });
    await StorageUsage.updateOne({ _id: WS }, { $set: { version: 1, bytes: 4096 } });
    await assert.rejects(PrivateRecord.create({ workspaceId: WS, ...await cipher("new") }), isQuota);
    assert.equal(await PrivateRecord.countDocuments(), 1);
    await PrivateRecord.deleteOne({ workspaceId: WS, id: "legacy" });
    assert.equal(await used(), 8192); assert.equal((await StorageUsage.findById(WS).lean())!.version, 3);
  });
  it("serializes encrypted growth across workspaces owned by the same account", async () => {
    const other = "private-quota-other";
    await WorkspaceMember.create({ workspaceId: other, userId: USER, role: "owner", name: "Owner" });
    const row = await cipher("first", "x".repeat(23_000));
    const otherRow = await cipher("second", "x".repeat(23_000), 1, other);
    const results = await Promise.allSettled([PrivateRecord.create({ workspaceId: WS, ...row }), PrivateRecord.create({ workspaceId: other, ...otherRow })]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.ok(isQuota((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason));
    assert.ok(await used() + await used(other) <= 65536);
    assert.equal(await mongoose.connection.db!.collection("privaterecords").countDocuments(), 1);
  });
});
