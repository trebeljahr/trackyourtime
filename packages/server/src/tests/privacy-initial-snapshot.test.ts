import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { canonicalJson, createKeyPair, createSigningPair, createPrivateWorkspaceReplica, downloadPrivateInitialSnapshot, encryptPrivateRecord, memoryStorage, privateMemberKeyFingerprint, privateReplicaIdentityFromDirectory, randomSecret, seal, signPrivateChange, signPrivateInitialSnapshot, signPrivateWorkspaceDirectory, verifyPrivateWorkspaceDirectory, type VerifiedPrivateDirectory, type PublicKey } from "@starter/core";
import type { EncryptedRecord, PrivateDirectoryMember, SignedPrivateInitialSnapshot } from "@starter/shared";
import { PrivateAccount, PrivateDirectory, PrivateRecord, PrivateSnapshotChunk, PrivateSnapshotReader, PrivateWorkspace, PrivateWorkspaceCommit } from "../models/PrivateData.js";
import { WorkspaceMember } from "../models/WorkspaceMember.js";
import { WorkspaceWriteFence } from "../models/TimesheetApproval.js";
import { commitPrivateDirectory } from "../services/privacy/directories.js";
import { preparePrivateInitialSnapshot, privateInitialSnapshotManifest, privateInitialSnapshotPage } from "../services/privacy/initial-snapshots.js";
import { mongooseRowStore } from "../services/account-deletion/stores.js";
import { privacyRouter } from "../trpc/routers/privacy.js";
import type { Context } from "../trpc/context.js";
import { clearTestDatabase, connectTestDatabase, dropTestDatabase, skipWithoutDatabase } from "./support/test-database.js";

const base = { server: "https://api.example.test", workspaceId: "workspace", userId: "owner" };
let migrationId: string, directory: VerifiedPrivateDirectory, people: PrivateDirectoryMember[];
let owner: { privateKey: PublicKey; signingPrivateKey: PublicKey }, member: typeof owner;
let records: EncryptedRecord[], readers: readonly SignedPrivateInitialSnapshot[];
const scope = () => ({ ...base, migrationId });
const transport = (userId = "owner") => ({
  manifest: () => privateInitialSnapshotManifest(base.workspaceId, userId),
  page: ({ migrationId: id, offset }: { migrationId: string; offset: number }) => privateInitialSnapshotPage(base.workspaceId, userId, id, offset),
});
const options = (userId = "owner") => ({ scope: { ...base, userId }, directory, secrets: userId === "owner" ? owner : member, current: () => true, transport: transport(userId) });
const storeRecords = async (rows: readonly EncryptedRecord[]) => {
  if (rows.length) await PrivateRecord.insertMany(rows.map((row) => ({ workspaceId: base.workspaceId, ...row })));
};
async function signSnapshot() {
  readers = (await signPrivateInitialSnapshot({ records, migrationId, userId: "owner", directory, secrets: owner, current: () => true })).readers;
}
describe("immutable initial snapshot storage", { skip: skipWithoutDatabase }, () => {
  before(() => connectTestDatabase("private-initial-snapshot", [PrivateAccount, PrivateDirectory, PrivateRecord, PrivateSnapshotChunk, PrivateSnapshotReader, PrivateWorkspace, PrivateWorkspaceCommit, WorkspaceMember, WorkspaceWriteFence] as never));
  beforeEach(async () => {
    await clearTestDatabase(); migrationId = crypto.randomUUID();
    const encryption = await createKeyPair(), signing = await createSigningPair(), second = await createKeyPair(), secondSigning = await createSigningPair();
    owner = { privateKey: encryption.privateKey, signingPrivateKey: signing.privateKey };
    member = { privateKey: second.privateKey, signingPrivateKey: secondSigning.privateKey };
    people = [
      { userId: "member", role: "member", publicKey: second.publicKey, signingPublicKey: secondSigning.publicKey, canViewOthersTime: false, canViewOthersMoney: false },
      { userId: "owner", role: "owner", publicKey: encryption.publicKey, signingPublicKey: signing.publicKey, canViewOthersTime: true, canViewOthersMoney: true },
    ];
    for (const p of people) {
      await WorkspaceMember.create({ workspaceId: base.workspaceId, ...p, name: p.userId });
      await PrivateAccount.create({ userId: p.userId, identity: { publicKey: p.publicKey, signingPublicKey: p.signingPublicKey, recovery: await seal(randomSecret(), {}, "synthetic"), passkeys: [] } });
    }
    const confirmed = new Map(await Promise.all(people.map(async (p) => [p.userId, await privateMemberKeyFingerprint(base.server, p)] as const)));
    const signed = await signPrivateWorkspaceDirectory({ v: 1, server: base.server, workspaceId: base.workspaceId, ownerId: "owner", revision: 1, previousDigest: null, members: people }, owner.signingPrivateKey, null, confirmed);
    await commitPrivateDirectory(base, signed);
    directory = await verifyPrivateWorkspaceDirectory(signed, base, { ownerId: "owner", signingPublicKey: signing.publicKey, revision: 0, digest: null });
    await PrivateWorkspace.create({ workspaceId: base.workspaceId, migrationId, ownerId: "owner", state: "migrating", sourceRevision: "synthetic", leaseUntil: new Date() });
    records = await Promise.all([
      encryptPrivateRecord(base.workspaceId, { kind: "tags", id: "tag", authorId: null, value: { name: "Shared label" } }, people, 1),
      encryptPrivateRecord(base.workspaceId, { kind: "entries", id: "owner-entry", authorId: "owner", value: { description: "Owner private work" } }, people, 1),
      encryptPrivateRecord(base.workspaceId, { kind: "entries", id: "member-entry", authorId: "member", value: { description: "Member work" } }, people, 1),
      encryptPrivateRecord(base.workspaceId, { kind: "favorites", id: "owner-favorite", authorId: "owner", value: { label: "Owner private pin" } }, people, 1),
      encryptPrivateRecord(base.workspaceId, { kind: "favorites", id: "member-favorite", authorId: "member", value: { label: "Member private pin" } }, people, 1),
    ]);
    await storeRecords(records); await signSnapshot();
  });
  after(dropTestDatabase);
  it("round-trips each signed projection through real storage without plaintext or another reader's private metadata", async () => {
    const receipt = await preparePrivateInitialSnapshot(scope(), readers);
    const expected = [...records].sort((a, b) => JSON.stringify([a.kind, a.id]) < JSON.stringify([b.kind, b.id]) ? -1 : 1);
    assert.equal(receipt.recordsDigest, createHash("sha256").update(canonicalJson(expected)).digest("hex"));
    assert.deepEqual(await preparePrivateInitialSnapshot(scope(), readers), receipt);
    const mine = await downloadPrivateInitialSnapshot(options()), colleague = await downloadPrivateInitialSnapshot(options("member"));
    assert.equal(mine.records.length, 4); assert.equal(colleague.records.length, 3);
    assert.doesNotMatch(JSON.stringify(colleague), /owner-entry|owner-favorite/);
    assert.doesNotMatch(JSON.stringify(await PrivateSnapshotChunk.find().lean()), /Owner private|Member private|Shared label/);
    assert.ok(colleague.records.every((row) => row.grants.length === 1 && row.grants[0]!.userId === "member"));
    const storageKey = randomSecret();
    const replica = await createPrivateWorkspaceReplica({ storage: memoryStorage(), scope: base, exclusive: (task) => task(), resolveStorageKey: () => ({ key: storageKey, current: () => true }), resolveIdentity: () => privateReplicaIdentityFromDirectory(directory, "owner", owner, () => true) });
    await replica.bootstrap(mine); assert.equal((await replica.read()).records.length, 4);
    await PrivateWorkspace.updateOne({ workspaceId: base.workspaceId }, { $set: { state: "encrypted", revision: 1 } });
    await PrivateRecord.updateOne({ id: "tag" }, { $set: { revision: 2 } }); // mutable current state cannot change the frozen copy
    assert.equal((await downloadPrivateInitialSnapshot(options())).records.length, 4);
    assert.deepEqual(await preparePrivateInitialSnapshot(scope(), readers), receipt);
  });
  it("refuses forged manifests, missing readers, wrong scopes and mismatched delivery hashes without writing snapshots", async () => {
    const forged = structuredClone(readers); forged[0]!.signature = "A".repeat(86);
    await assert.rejects(preparePrivateInitialSnapshot(scope(), forged), { code: "FORBIDDEN" });
    await assert.rejects(preparePrivateInitialSnapshot(scope(), readers.slice(1)), { code: "BAD_REQUEST" });
    await assert.rejects(preparePrivateInitialSnapshot({ ...scope(), userId: "member" }, readers), { code: "FORBIDDEN" });
    await assert.rejects(preparePrivateInitialSnapshot({ ...scope(), server: "https://other.test" }, readers), { code: "PRECONDITION_FAILED" });
    const omitted = structuredClone(readers); omitted[0]!.manifest.recordCount++;
    omitted[0]!.signature = await signPrivateChange(owner.signingPrivateKey, omitted[0]!.manifest);
    await assert.rejects(preparePrivateInitialSnapshot(scope(), omitted), { code: "BAD_REQUEST" });
    await WorkspaceMember.collection.updateOne({ workspaceId: base.workspaceId, userId: "member" }, { $set: { canViewOthersTime: true } });
    await assert.rejects(preparePrivateInitialSnapshot(scope(), readers), { code: "CONFLICT" });
    assert.equal(await PrivateSnapshotReader.countDocuments(), 0); assert.equal(await PrivateSnapshotChunk.countDocuments(), 0);
    assert.equal(await PrivateRecord.countDocuments(), 5);
  });
  it("serializes identical retries, refuses forks and rolls back chunks if publishing readers fails", async (t) => {
    const failure = t.mock.method(PrivateSnapshotReader, "insertMany", async () => { throw new Error("Injected reader publication failure"); });
    await assert.rejects(preparePrivateInitialSnapshot(scope(), readers), /publication failure/);
    assert.equal(await PrivateSnapshotChunk.countDocuments(), 0); assert.equal(await PrivateRecord.countDocuments(), 5);
    failure.mock.restore();
    const [a, b] = await Promise.all([preparePrivateInitialSnapshot(scope(), readers), preparePrivateInitialSnapshot(scope(), readers)]);
    assert.deepEqual(a, b); assert.equal(await PrivateSnapshotReader.countDocuments(), 2);
    const fork = structuredClone(readers); fork[0]!.manifest.recordsDigest = "A".repeat(43); fork[0]!.signature = await signPrivateChange(owner.signingPrivateKey, fork[0]!.manifest);
    await assert.rejects(preparePrivateInitialSnapshot(scope(), fork), { code: "CONFLICT" });
  });
  it("keeps logical pagination stable and detects missing or corrupted chunks", async () => {
    const extra = [];
    for (let i = 0; i < 103; i++) extra.push(await encryptPrivateRecord(base.workspaceId, { kind: "tags", id: `import-${i}`, authorId: null, value: { name: `Imported ${i}` } }, people, 1));
    records.push(...extra); await storeRecords(extra); await signSnapshot();
    await preparePrivateInitialSnapshot(scope(), readers);
    const page = await privateInitialSnapshotPage(base.workspaceId, "owner", migrationId, 0);
    assert.equal(page.records.length, 100); assert.equal(page.next, 100); assert.deepEqual(Object.keys(page).sort(), ["next", "offset", "records"]);
    assert.equal((await downloadPrivateInitialSnapshot(options())).records.length, 107);
    await assert.rejects(privateInitialSnapshotPage(base.workspaceId, "stranger", migrationId, 0), { code: "NOT_FOUND" });
    await assert.rejects(privateInitialSnapshotPage(base.workspaceId, "member", migrationId, 999), { code: "BAD_REQUEST" });
    const chunk = (await PrivateSnapshotChunk.findOne({ index: 0 }).lean())!;
    const changed = structuredClone(chunk.records); changed[0]!.box.nonce = "AAAAAAAAAAAAAAAA";
    await PrivateSnapshotChunk.updateOne({ _id: chunk._id }, { $set: { records: changed } });
    await assert.rejects(downloadPrivateInitialSnapshot(options()), /omitted or changed/);
    await PrivateSnapshotChunk.deleteOne({ index: 1 });
    await assert.rejects(privateInitialSnapshotPage(base.workspaceId, "owner", migrationId, 100), { code: "PRECONDITION_FAILED" });
  });
  it("erases a departing member's personal snapshot data while preserving another reader's signed projection", async () => {
    await preparePrivateInitialSnapshot(scope(), readers);
    const before = await downloadPrivateInitialSnapshot(options());
    await mongooseRowStore.deleteMany("workspaceMembers", { workspaceId: base.workspaceId, userId: "member" });
    await mongooseRowStore.erasePrivateUserData("member");
    await mongooseRowStore.deleteMany("privateAccounts", { userId: "member" });
    await mongooseRowStore.erasePrivateUserData("member");
    const after = await downloadPrivateInitialSnapshot(options());
    assert.deepEqual(after.records, before.records); assert.deepEqual(after.signed, before.signed);
    assert.equal(await PrivateSnapshotReader.countDocuments({ userId: "member" }), 0);
    assert.equal(await PrivateSnapshotChunk.countDocuments({ "records.id": "member-favorite" }), 0);
    assert.equal(await PrivateSnapshotChunk.countDocuments({ "records.id": "member-entry" }), 1);
    await assert.rejects(privateInitialSnapshotManifest(base.workspaceId, "member"), { code: "NOT_FOUND" });
  });
  it("splits large ciphertext into bounded pages without truncating the final reader projection", async () => {
    const extra = [];
    for (let i = 0; i < 3; i++) extra.push(await encryptPrivateRecord(base.workspaceId, { kind: "tags", id: `bulk-${i}`, authorId: null, value: { name: "x".repeat(1024 * 1024) } }, people, 1));
    records.push(...extra); await storeRecords(extra); await signSnapshot();
    await preparePrivateInitialSnapshot(scope(), readers);
    let calls = 0;
    const good = transport();
    const snapshot = await downloadPrivateInitialSnapshot({ ...options(), transport: { ...good, page: async (input) => {
      const page = await good.page(input); calls++;
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 4 * 1024 * 1024);
      return page;
    } } });
    assert.ok(calls > 1); assert.equal(snapshot.records.length, 7);
    assert.ok(await PrivateSnapshotChunk.countDocuments() > 1);
  });
  it("supports an authenticated empty initial state and keeps the public snapshot endpoints closed", async () => {
    await PrivateRecord.deleteMany(); records = []; await signSnapshot();
    await preparePrivateInitialSnapshot(scope(), readers);
    assert.equal((await downloadPrivateInitialSnapshot(options())).records.length, 0);
    assert.equal(await PrivateSnapshotChunk.countDocuments(), 0);
    const caller = privacyRouter.createCaller({ user: { id: "owner" }, session: { user: { id: "owner" } } } as unknown as Context);
    await assert.rejects(caller.initialSnapshot({ workspaceId: base.workspaceId }), { code: "NOT_IMPLEMENTED" });
    await assert.rejects(caller.initialSnapshotPage({ workspaceId: base.workspaceId, migrationId, offset: 0 }), { code: "NOT_IMPLEMENTED" });
  });
});
