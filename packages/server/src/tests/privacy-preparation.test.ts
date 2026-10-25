import assert from "node:assert/strict";
import { before, beforeEach, after, describe, it, mock } from "node:test";
import mongoose from "mongoose";
import { canonicalJson, createKeyPair, createSigningPair, encryptPrivateRecord, partitionPrivateRecovery, privateMemberKeyFingerprint, randomSecret, seal, signPrivateWorkspaceDirectory } from "@starter/core";
import type { PrivateDirectoryMember } from "@starter/shared";
import { PrivateAccount, PrivateDirectory, PrivateMigrationReceipt, PrivateRecord, PrivateSnapshotChunk, PrivateSnapshotReader, PrivateWorkspace, PrivateWorkspaceCommit } from "../models/PrivateData.js";
import { WorkspaceMember } from "../models/WorkspaceMember.js";
import { Client } from "../models/Client.js";
import { WorkspaceWriteFence } from "../models/TimesheetApproval.js";
import { StorageFence, StorageUsage } from "../models/StorageUsage.js";
import { commitPrivateDirectory } from "../services/privacy/directories.js";
import { capturePrivateMigrationSupplement } from "../services/privacy/recovery-supplement.js";
import { workspaceRecovery } from "../services/privacy/recovery.js";
import { env } from "../config/env.js";
import { stagePrivateMigrationBatch } from "../services/privacy/migration.js";
import { discardPrivatePreparation } from "../services/privacy/preparation.js";
import { privacyRouter } from "../trpc/routers/privacy.js";
import type { Context } from "../trpc/context.js";
import { assertStandardWorkspace } from "../services/privacy/access.js";
import { withBusinessTransaction } from "../services/business-transaction.js";
import { mongooseRowStore } from "../services/account-deletion/stores.js";
import { connectTestDatabase, clearTestDatabase, dropTestDatabase, skipWithoutDatabase } from "./support/test-database.js";
const scope = { server: "https://api.example.test", workspaceId: "preparation", userId: "owner" };
let migrationId: string;
const gate = () => {
  let ready!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => { ready = resolve; }), continued = new Promise<void>((resolve) => { release = resolve; });
  const encrypt: typeof encryptPrivateRecord = async (...args) => { ready(); await continued; return encryptPrivateRecord(...args); };
  return { entered, release, encrypt };
};
describe("bounded private workspace preparation", { skip: skipWithoutDatabase }, () => {
  before(() => connectTestDatabase("privacy-preparation", [PrivateAccount, PrivateDirectory, PrivateMigrationReceipt, PrivateRecord, PrivateSnapshotChunk, PrivateSnapshotReader, PrivateWorkspace, PrivateWorkspaceCommit, WorkspaceMember, Client, WorkspaceWriteFence, StorageFence, StorageUsage] as never));
  beforeEach(async () => {
    await clearTestDatabase(); migrationId = crypto.randomUUID();
    const pair = await createKeyPair(), signing = await createSigningPair();
    const member: PrivateDirectoryMember = { userId: "owner", role: "owner", canViewOthersTime: true, canViewOthersMoney: true, publicKey: pair.publicKey, signingPublicKey: signing.publicKey };
    await WorkspaceMember.create({ workspaceId: scope.workspaceId, userId: "owner", role: "owner", name: "Owner" });
    await PrivateAccount.create({ userId: "owner", identity: { publicKey: pair.publicKey, signingPublicKey: signing.publicKey, recovery: await seal(randomSecret(), {}, "synthetic"), passkeys: [] } });
    const confirmed = new Map([["owner", await privateMemberKeyFingerprint(scope.server, member)]]);
    const signed = await signPrivateWorkspaceDirectory({ v: 1, server: scope.server, workspaceId: scope.workspaceId, ownerId: "owner", revision: 1, previousDigest: null, members: [member] }, signing.privateKey, null, confirmed);
    await commitPrivateDirectory(scope, signed);
    await mongoose.connection.db!.collection<{ _id: string; workspaceId: string; name: string }>("tags").insertMany(Array.from({ length: 55 }, (_, index) => ({ _id: `tag-${index}`, workspaceId: scope.workspaceId, name: `Original ${index}` })));
    const source = await workspaceRecovery(scope.workspaceId, "owner", true);
    await PrivateWorkspace.create({ workspaceId: scope.workspaceId, ownerId: "owner", state: "migrating", migrationId, sourceRevision: source.sourceRevision, leaseUntil: new Date(Date.now() + 3600000) });
  });
  after(dropTestDatabase);
  const batch = (offset = 0, encrypt = encryptPrivateRecord) => stagePrivateMigrationBatch(scope.workspaceId, "owner", migrationId, offset, encrypt);
  it("refuses insufficient temporary headroom before invoking encryption and keeps all source records", async () => {
    const previous = env.STORAGE_QUOTA_BYTES; let calls = 0;
    // Native legacy originals must be counted even with a current ledger.
    const encrypt: typeof encryptPrivateRecord = async (...args) => { calls++; return encryptPrivateRecord(...args); };
    try {
      Object.defineProperty(env, "STORAGE_QUOTA_BYTES", { value: 384 * 1024 });
      await assert.rejects(batch(0, encrypt), /Storage limit reached/);
      assert.equal(calls, 0); assert.equal(await PrivateRecord.countDocuments(), 0);
      assert.equal(await mongoose.connection.db!.collection("tags").countDocuments(), 55);
    } finally { Object.defineProperty(env, "STORAGE_QUOTA_BYTES", { value: previous }); }
    await batch(); assert.equal(await PrivateRecord.countDocuments(), 50);
  });
  it("stages bounded pages and preserves exact ciphertext on lost replies and concurrent retries", async () => {
    const total = partitionPrivateRecovery(await workspaceRecovery(scope.workspaceId, "owner", true)).length;
    assert.deepEqual(await batch(), { next: 50, total });
    const first = canonicalJson(await PrivateRecord.find().sort({ kind: 1, id: 1 }).lean());
    await Promise.all([batch(), batch()]);
    assert.equal(canonicalJson(await PrivateRecord.find().sort({ kind: 1, id: 1 }).lean()), first);
    assert.deepEqual(await batch(50), { next: null, total }); assert.equal(await PrivateRecord.countDocuments(), total);
    assert.equal(await mongoose.connection.db!.collection("tags").countDocuments(), 55);
  });
  it("cannot recreate a canceled preparation after slow encryption finishes", async () => {
    const g = gate(), pending = batch(0, g.encrypt);
    await g.entered;
    try { assert.equal(await discardPrivatePreparation(scope.workspaceId, migrationId), true); } finally { g.release(); }
    await assert.rejects(pending, { code: "NOT_FOUND" });
    assert.equal(await PrivateWorkspace.countDocuments(), 0); assert.equal(await PrivateRecord.countDocuments(), 0);
    assert.equal(await mongoose.connection.db!.collection("tags").countDocuments(), 55);
    assert.equal(await PrivateDirectory.countDocuments(), 1);
  });
  it("cannot publish into a replacement lease even when its migration ID was reused", async () => {
    const hold = gate(), pending = batch(0, hold.encrypt); await hold.entered;
    const mode = (await PrivateWorkspace.findOne().lean())!;
    await discardPrivatePreparation(scope.workspaceId, migrationId);
    await PrivateWorkspace.create({ workspaceId: scope.workspaceId, ownerId: "owner", state: "migrating", migrationId, sourceRevision: mode.sourceRevision, leaseUntil: new Date(Date.now() + 3600000) });
    hold.release(); await assert.rejects(pending, { code: "CONFLICT" });
    assert.equal(await PrivateRecord.countDocuments(), 0); assert.equal(await mongoose.connection.db!.collection("tags").countDocuments(), 55);
  });
  it("cannot publish into a replacement migration or after source data changes during encryption", async () => {
    const g = gate(), pending = batch(0, g.encrypt); await g.entered;
    try { await PrivateWorkspace.updateOne({}, { $set: { migrationId: crypto.randomUUID() } }); } finally { g.release(); }
    await assert.rejects(pending, { code: "NOT_FOUND" }); assert.equal(await PrivateRecord.countDocuments(), 0);
    await PrivateWorkspace.updateOne({}, { $set: { migrationId } });
    const h = gate(), changed = batch(0, h.encrypt); await h.entered;
    try { await mongoose.connection.db!.collection("tags").updateOne({ _id: "tag-0" } as never, { $set: { name: "Changed original" } }); } finally { h.release(); }
    await assert.rejects(changed, { code: "CONFLICT" }); assert.equal(await PrivateRecord.countDocuments(), 0);
  });
  it("rejects supplemental changes during encryption and never commits a partial stale batch", async () => {
    const db = mongoose.connection.db!;
    await db.collection("webhooksubscriptions").insertOne({ workspaceId: scope.workspaceId, createdBy: "owner", secret: "Original signing secret" });
    const source = await capturePrivateMigrationSupplement(scope.workspaceId, "owner");
    await PrivateWorkspace.updateOne({}, { $set: { supplementRevision: source.sourceRevision } });
    const g = gate(), pending = batch(0, g.encrypt); await g.entered;
    try { await db.collection("webhooksubscriptions").updateOne({ workspaceId: scope.workspaceId }, { $set: { secret: "Changed signing secret" } }); } finally { g.release(); }
    await assert.rejects(pending, { code: "CONFLICT" }); assert.equal(await PrivateRecord.countDocuments(), 0);
    assert.equal(await db.collection("webhooksubscriptions").countDocuments(), 1);
  });
  it("expires preparation on ordinary access without deleting originals, keys or public directory history", async () => {
    await batch(); await PrivateWorkspace.updateOne({}, { $set: { leaseUntil: new Date(0) } });
    await assertStandardWorkspace(scope.workspaceId);
    assert.equal(await PrivateRecord.countDocuments(), 0); assert.equal(await PrivateWorkspace.countDocuments(), 0);
    assert.equal(await PrivateDirectory.countDocuments(), 1); assert.equal(await PrivateAccount.countDocuments(), 1);
    assert.equal(await mongoose.connection.db!.collection("tags").countDocuments(), 55);
    await Client.create({ workspaceId: scope.workspaceId, name: "Standard again" });
  });
  it("rolls expiry cleanup back if the ordinary write fails, then resumes atomically on a successful write", async () => {
    await batch(); await PrivateWorkspace.updateOne({}, { $set: { leaseUntil: new Date(0) } });
    await assert.rejects(withBusinessTransaction(async () => { await Client.create({ workspaceId: scope.workspaceId, name: "Aborted" }); throw new Error("Injected failure"); }), /Injected failure/);
    assert.equal(await PrivateWorkspace.countDocuments(), 1); assert.equal(await PrivateRecord.countDocuments(), 50); assert.equal(await Client.countDocuments(), 0);
    await Client.create({ workspaceId: scope.workspaceId, name: "Committed" });
    assert.equal(await PrivateWorkspace.countDocuments(), 0); assert.equal(await PrivateRecord.countDocuments(), 0); assert.equal(await Client.countDocuments(), 1);
  });
  it("cancels live preparation on account departure and promptly restores standard access", async () => {
    await batch();
    assert.equal(await mongooseRowStore.deleteMany("workspaceMembers", { workspaceId: scope.workspaceId, userId: "owner" }), 1);
    assert.equal(await PrivateWorkspace.countDocuments(), 0); assert.equal(await PrivateRecord.countDocuments(), 0);
    assert.equal(await PrivateDirectory.countDocuments(), 1); assert.equal(await PrivateAccount.countDocuments(), 1);
    assert.equal(await mongoose.connection.db!.collection("tags").countDocuments(), 55);
    await assertStandardWorkspace(scope.workspaceId);
    await Client.create({ workspaceId: scope.workspaceId, name: "Available immediately" });
  });
  it("rolls preparation cancellation back with a failed account-erasure write", async () => {
    await batch();
    await assert.rejects(withBusinessTransaction(async () => {
      await mongooseRowStore.deleteMany("workspaceMembers", { workspaceId: scope.workspaceId, userId: "owner" });
      throw new Error("Injected erasure failure");
    }), /Injected erasure failure/);
    assert.equal(await PrivateWorkspace.countDocuments(), 1); assert.equal(await PrivateRecord.countDocuments(), 50);
    assert.equal(await WorkspaceMember.countDocuments(), 1);
    await assert.rejects(assertStandardWorkspace(scope.workspaceId), { code: "PRECONDITION_FAILED" });
    assert.equal(await mongooseRowStore.deleteMany("workspaceMembers", { workspaceId: scope.workspaceId, userId: "owner" }), 1);
    assert.equal(await PrivateWorkspace.countDocuments(), 0); assert.equal(await PrivateRecord.countDocuments(), 0);
  });
  it("preserves encrypted shared ciphertext and refuses erasure of inconsistent preparation before deleting membership", async () => {
    await batch();
    await PrivateWorkspaceCommit.collection.insertOne({ workspaceId: scope.workspaceId, revision: 1 });
    await assert.rejects(mongooseRowStore.deleteMany("workspaceMembers", { workspaceId: scope.workspaceId, userId: "owner" }), { code: "CONFLICT" });
    assert.equal(await WorkspaceMember.countDocuments(), 1); assert.equal(await PrivateRecord.countDocuments(), 50);
    await PrivateWorkspaceCommit.deleteMany({ workspaceId: scope.workspaceId });
    await PrivateWorkspace.updateOne({}, { $set: { head: "unexpected" } });
    await assert.rejects(mongooseRowStore.deleteMany("workspaceMembers", { workspaceId: scope.workspaceId, userId: "owner" }), { code: "CONFLICT" });
    assert.equal(await WorkspaceMember.countDocuments(), 1); assert.equal(await PrivateRecord.countDocuments(), 50);
    await PrivateWorkspace.updateOne({}, { $set: { state: "encrypted", revision: 1 } });
    assert.equal(await mongooseRowStore.deleteMany("workspaceMembers", { workspaceId: scope.workspaceId, userId: "owner" }), 1);
    assert.equal(await PrivateWorkspace.countDocuments(), 1); assert.equal(await PrivateRecord.countDocuments(), 50);
    assert.equal(await PrivateDirectory.countDocuments(), 1);
  });
  it("never expires encrypted workspaces, live preparations or unexpected committed history", async () => {
    assert.equal(await discardPrivatePreparation(scope.workspaceId, migrationId, true), false);
    await PrivateWorkspace.updateOne({}, { $set: { state: "encrypted", revision: 1, leaseUntil: new Date(0) } });
    assert.equal(await discardPrivatePreparation(scope.workspaceId, migrationId), false);
    await assert.rejects(assertStandardWorkspace(scope.workspaceId), { code: "PRECONDITION_FAILED" });
    assert.equal(await PrivateWorkspace.countDocuments(), 1);
    await PrivateWorkspace.updateOne({}, { $set: { state: "migrating", revision: 0 } });
    await PrivateWorkspaceCommit.collection.insertOne({ workspaceId: scope.workspaceId, revision: 1 });
    await assert.rejects(discardPrivatePreparation(scope.workspaceId, migrationId, true), { code: "CONFLICT" });
    assert.equal(await PrivateWorkspace.countDocuments(), 1);
  });
  it("refuses expired staging and any new records after the initial snapshot freezes", async () => {
    await PrivateWorkspace.updateOne({}, { $set: { leaseUntil: new Date(0) } });
    await assert.rejects(batch(), /preparation expired/);
    await PrivateWorkspace.updateOne({}, { $set: { leaseUntil: new Date(Date.now() + 3600000) } });
    await PrivateSnapshotReader.collection.insertOne({ workspaceId: scope.workspaceId, migrationId, userId: "owner" });
    await assert.rejects(batch(), /already frozen/);
    assert.equal(await PrivateRecord.countDocuments(), 0);
  });
  it("rejects a batch that expires while encryption is running", async () => {
    const g = gate(), pending = batch(0, g.encrypt); await g.entered;
    try { await PrivateWorkspace.updateOne({}, { $set: { leaseUntil: new Date(0) } }); } finally { g.release(); }
    await assert.rejects(pending, /preparation expired/);
    assert.equal(await PrivateRecord.countDocuments(), 0); assert.equal(await mongoose.connection.db!.collection("tags").countDocuments(), 55);
  });
  it("rolls failed cancellation back and erases snapshot/receipt copies only on successful cleanup", async () => {
    await batch();
    await PrivateSnapshotChunk.collection.insertOne({ workspaceId: scope.workspaceId, migrationId, index: 0, records: [] });
    await PrivateSnapshotReader.collection.insertOne({ workspaceId: scope.workspaceId, migrationId, userId: "owner" });
    await PrivateMigrationReceipt.create({ workspaceId: scope.workspaceId, migrationId, userId: "owner", kind: "owner", proof: { synthetic: true }, signature: "synthetic" });
    const injected = mock.method(PrivateSnapshotChunk, "deleteMany", async () => { throw new Error("Injected cleanup failure"); });
    try { await assert.rejects(discardPrivatePreparation(scope.workspaceId, migrationId), /Injected cleanup failure/); } finally { injected.mock.restore(); }
    assert.equal(await PrivateRecord.countDocuments(), 50); assert.equal(await PrivateWorkspace.countDocuments(), 1);
    assert.equal(await PrivateSnapshotReader.countDocuments(), 1); assert.equal(await PrivateMigrationReceipt.countDocuments(), 1);
    assert.equal(await discardPrivatePreparation(scope.workspaceId, migrationId), true);
    for (const model of [PrivateRecord, PrivateSnapshotChunk, PrivateSnapshotReader, PrivateMigrationReceipt, PrivateWorkspace]) assert.equal(await model.countDocuments(), 0);
    assert.equal(await mongoose.connection.db!.collection("tags").countDocuments(), 55);
  });

  it("reports standard mode after status polling retires expired preparation, and never retires encrypted mode", async () => {
    const caller = privacyRouter.createCaller({ user: { id: "owner" }, session: { user: { id: "owner" } } } as unknown as Context);
    await batch(); await PrivateWorkspace.updateOne({}, { $set: { leaseUntil: new Date(0) } });
    assert.deepEqual(await caller.status({ workspaceId: scope.workspaceId }), { mode: "standard", revision: 0, owner: true });
    assert.equal(await PrivateRecord.countDocuments(), 0); assert.equal(await PrivateWorkspace.countDocuments(), 0);
    await PrivateWorkspace.create({ workspaceId: scope.workspaceId, ownerId: "owner", state: "encrypted", revision: 1, migrationId, sourceRevision: "retired", leaseUntil: new Date(0) });
    assert.deepEqual(await caller.status({ workspaceId: scope.workspaceId }), { mode: "encrypted", revision: 1, owner: true });
    assert.equal(await PrivateWorkspace.countDocuments(), 1);
  });

});
