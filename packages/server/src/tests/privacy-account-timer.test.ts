import assert from "node:assert/strict";
import { before, beforeEach, after, describe, it } from "node:test";
import { canonicalJson, createKeyPair, createSigningPair, decryptPrivateRecord, encodeSecret, encryptPrivateRecord, privateMemberKeyFingerprint, privateRecordDigest, privateTimerEditBindings, randomSecret, seal, signPrivateChainedWorkspaceEdit, signPrivateTimer, signPrivateWorkspaceDirectory, verifyPrivateWorkspaceDirectory, type VerifiedPrivateDirectory, type PlainPrivateRecord } from "@starter/core";
import type { PrivateTimerPointer, PrivateTimerTransition, SignedPrivateChainedEdit } from "@starter/shared";
import { PrivateAccount, PrivateDirectory, PrivateRecord, PrivateWorkspace, PrivateWorkspaceCommit } from "../models/PrivateData.js";
import { PrivateTimerVersion } from "../models/PrivateTimer.js";
import { TimeEntry } from "../models/TimeEntry.js";
import { EntryOperation } from "../models/EntryOperation.js";
import { WorkspaceMember } from "../models/WorkspaceMember.js";
import { allModels } from "../models/registry.js";
import { commitPrivateTimerTransition } from "../services/privacy/account-timer.js";
import { privateTimerCheckpoint } from "../services/privacy/timer-state.js";
import { currentEntry, personReach, workspaceReach } from "../services/entries/timer.js";
import { fencePrivateAccount } from "../services/privacy/account-erasure-fence.js";
import { withBusinessTransaction } from "../services/business-transaction.js";
import { clearTestDatabase, connectTestDatabase, dropTestDatabase, skipWithoutDatabase, testDatabaseTransactions } from "./support/test-database.js";
const scope = { server: "https://api.example.test", userId: "owner" }, standard = "standard", a = "private-a", b = "private-b";
const instant = "2026-10-01T12:00:00.000Z", privateDescription = "Private account timer description";
let encryption: Awaited<ReturnType<typeof createKeyPair>>, signing: Awaited<ReturnType<typeof createSigningPair>>;
let directories: Map<string, VerifiedPrivateDirectory>;
async function prepare(previous: PrivateTimerPointer | null, current: PrivateTimerPointer | null, standardStop?: { workspaceId: string; entryId: string }) {
  const checkpoint = await privateTimerCheckpoint(scope.userId), edits: SignedPrivateChainedEdit[] = [];
  const workspaces = [...new Set([previous?.workspaceId, current?.workspaceId].filter((id): id is string => !!id))].sort();
  for (const workspaceId of workspaces) {
    const mode = (await PrivateWorkspace.findOne({ workspaceId }).lean())!, directory = directories.get(workspaceId)!, records = [];
    const wanted = [previous, current].filter(pointer => pointer?.workspaceId === workspaceId), ids = new Set(wanted.map(pointer => pointer!.entryId));
    for (const id of ids) {
      const running = current?.workspaceId === workspaceId && current.entryId === id;
      const base = { _id: id, workspaceId, authorId: scope.userId, description: privateDescription, start: "2026-10-01T10:00:00.000Z", end: running ? null : instant };
      for (const row of [{ kind: "entries", id, authorId: scope.userId, value: base }, { kind: "entryMoney", id, authorId: scope.userId, value: { _id: id, hourlyRate: 95 } }] as PlainPrivateRecord[]) records.push(await encryptPrivateRecord(workspaceId, row, directory.signed.directory.members, mode.revision + 1));
    }
    edits.push(await signPrivateChainedWorkspaceEdit({ edit: { v: 1, workspaceId, userId: scope.userId, operationId: crypto.randomUUID(), expectedRevision: mode.revision, records, remove: [] }, directory, previousRoot: mode.head!, secrets: { privateKey: encryption.privateKey, signingPrivateKey: signing.privateKey }, current: () => true }));
  }
  const signed = await signPrivateTimer({ v: 1, protocol: "trackyourtime-private-account-timer-v1", ...scope, operationId: crypto.randomUUID(), revision: checkpoint.revision + 1, previousRoot: checkpoint.root, previous, current, standardStop: standardStop ?? null, edits: await privateTimerEditBindings(edits) }, signing.privateKey, () => true);
  return { signed, edits, ...(standardStop ? { standardStopEnd: instant } : {}) } satisfies PrivateTimerTransition;
}
const point = (workspaceId = a): PrivateTimerPointer => ({ workspaceId, entryId: crypto.randomUUID() });
const standardEntry = (end: Date | null = null) => TimeEntry.create({ workspaceId: standard, authorId: scope.userId, description: "Ordinary standard work", start: new Date("2026-10-01T10:00:00.000Z"), end });
const readEntry = async (pointer: PrivateTimerPointer) => {
  const row = (await PrivateRecord.findOne({ workspaceId: pointer.workspaceId, kind: "entries", id: pointer.entryId }).lean())!;
  const { id, kind, authorId, revision, keyCommitment, box, grants } = row;
  return decryptPrivateRecord(pointer.workspaceId, { id, kind, authorId, revision, keyCommitment, box, grants }, scope.userId, encryption.privateKey);
};
describe("atomic account-wide private timer coordination", { skip: skipWithoutDatabase }, () => {
  before(async () => { await connectTestDatabase("private-account-timer", allModels() as never); await testDatabaseTransactions(); });
  beforeEach(async () => {
    await clearTestDatabase(); encryption = await createKeyPair(); signing = await createSigningPair(); directories = new Map();
    await PrivateAccount.create({ userId: scope.userId, identity: { publicKey: encryption.publicKey, signingPublicKey: signing.publicKey, recovery: await seal(randomSecret(), {}, "synthetic"), passkeys: [] } });
    for (const workspaceId of [a, b, standard]) await WorkspaceMember.create({ workspaceId, userId: scope.userId, role: "owner", name: "Owner" });
    for (const workspaceId of [a, b]) {
      const actor = { userId: scope.userId, role: "owner" as const, canViewOthersTime: true, canViewOthersMoney: true, publicKey: encryption.publicKey, signingPublicKey: signing.publicKey };
      const signed = await signPrivateWorkspaceDirectory({ v: 1, server: scope.server, workspaceId, ownerId: scope.userId, revision: 1, previousDigest: null, members: [actor] }, signing.privateKey, null, new Map([[scope.userId, await privateMemberKeyFingerprint(scope.server, actor)]]));
      const directory = await verifyPrivateWorkspaceDirectory(signed, { ...scope, workspaceId }, { ownerId: scope.userId, signingPublicKey: signing.publicKey, revision: 0, digest: null }); directories.set(workspaceId, directory);
      await PrivateDirectory.create({ workspaceId, revision: 1, digest: directory.digest, signerPublicKey: signing.publicKey, signed });
      await PrivateWorkspace.create({ workspaceId, ownerId: scope.userId, state: "encrypted", revision: 1, head: encodeSecret(randomSecret()), directoryDigest: directory.digest, migrationId: crypto.randomUUID(), sourceRevision: "retired", leaseUntil: new Date() });
    }
  });
  after(dropTestDatabase);
  it("keeps claim metadata and workspace time atomic while retaining only encrypted business content", async () => {
    const pointer = point(), request = await prepare(null, pointer), saved = await commitPrivateTimerTransition(scope, request);
    assert.equal(saved.revision, 1); assert.deepEqual((await privateTimerCheckpoint(scope.userId)).current, pointer); assert.equal((await readEntry(pointer)).value.end, null);
    assert.equal(await TimeEntry.countDocuments(), 0); assert.equal(await PrivateWorkspaceCommit.countDocuments(), 1); assert.equal(await PrivateTimerVersion.countDocuments(), 1);
    assert.doesNotMatch(JSON.stringify([await PrivateAccount.find().lean(), await PrivateRecord.find().lean(), await PrivateTimerVersion.find().lean(), await PrivateWorkspaceCommit.find().lean()]), new RegExp(privateDescription));
    await assert.rejects(currentEntry({ userId: scope.userId, workspaceId: standard, visibility: { userId: scope.userId, canViewOthersTime: true, canViewOthersMoney: true } }, personReach), { code: "PRECONDITION_FAILED", message: "PRIVATE_WORKSPACE_REQUIRES_UNLOCK" });
    assert.equal(await currentEntry({ userId: scope.userId, workspaceId: standard, visibility: { userId: scope.userId, canViewOthersTime: true, canViewOthersMoney: true } }, workspaceReach(standard)), null);
  });
  it("refuses legacy starts and every manual reopen path until the private timer stops", async () => {
    const completed = await standardEntry(new Date(instant)), pointer = point(); await commitPrivateTimerTransition(scope, await prepare(null, pointer));
    for (const write of [() => standardEntry(), () => TimeEntry.updateOne({ _id: completed._id }, { $set: { end: null } }), () => TimeEntry.insertMany([{ workspaceId: standard, authorId: scope.userId, start: new Date(), end: null }]), async () => { completed.end = null; return completed.save(); }]) await assert.rejects(write(), { code: "CONFLICT" });
    assert.notEqual((await TimeEntry.findById(completed._id).lean())!.end, null);
    await TimeEntry.updateOne({ _id: completed._id }, { $set: { description: "Completed time stays editable", end: undefined } });
    assert.equal((await TimeEntry.findById(completed._id).lean())!.description, "Completed time stays editable");
    assert.notEqual((await TimeEntry.findById(completed._id).lean())!.end, null); assert.equal(await TimeEntry.countDocuments({ end: null }), 0);
    await assert.rejects(TimeEntry.updateOne({ _id: completed._id }, { $unset: { end: 1 } }), { code: "CONFLICT" });
    await assert.rejects(TimeEntry.updateOne({ _id: completed._id }, { $rename: { end: "legacyEnd" } }), { code: "BAD_REQUEST" });
    await assert.rejects(TimeEntry.updateOne({ _id: completed._id }, { $rename: { description: "end" } }), { code: "BAD_REQUEST" });
    const foreign = await TimeEntry.create({ workspaceId: standard, authorId: "another-author", description: "Another author", start: new Date(), end: null });
    await assert.rejects(TimeEntry.updateOne({ _id: foreign._id }, { $set: { authorId: scope.userId } }), { code: "CONFLICT" });
    const upsertId = crypto.randomUUID().replaceAll("-", "").slice(0, 24);
    await assert.rejects(TimeEntry.updateOne({ _id: upsertId, workspaceId: standard, authorId: scope.userId, end: new Date(instant) }, { $setOnInsert: { start: new Date("2026-10-01T10:00:00.000Z") }, $unset: { end: 1 } }, { upsert: true }), { code: "CONFLICT" });
    assert.equal(await TimeEntry.exists({ _id: upsertId }), null);
    await commitPrivateTimerTransition(scope, await prepare(pointer, null)); assert.equal((await readEntry(pointer)).value.end, instant); assert.equal((await privateTimerCheckpoint(scope.userId)).current, null);
    await standardEntry(); assert.equal(await TimeEntry.countDocuments({ authorId: scope.userId, end: null }), 1);
  });
  it("atomically switches between encrypted workspaces and keeps old operation retries from reviving a timer", async () => {
    const first = point(a), second = point(b), start = await prepare(null, first); await commitPrivateTimerTransition(scope, start);
    const switched = await prepare(first, second), saved = await commitPrivateTimerTransition(scope, switched); assert.equal(saved.revision, 2); assert.equal((await readEntry(first)).value.end, instant); assert.equal((await readEntry(second)).value.end, null);
    assert.deepEqual(await commitPrivateTimerTransition(scope, start), { revision: 1, root: await privateRecordDigest(start.signed.header) }); assert.deepEqual((await privateTimerCheckpoint(scope.userId)).current, second); assert.equal(await PrivateTimerVersion.countDocuments(), 2);
  });
  it("rolls back an earlier encrypted workspace change if the second edit signature fails", async () => {
    const first = point(a), second = point(b); await commitPrivateTimerTransition(scope, await prepare(null, first)); const before = await PrivateRecord.find().sort({ workspaceId: 1, kind: 1 }).lean();
    const request = await prepare(first, second); request.edits.find(edit => edit.edit.workspaceId === b)!.signature = "A".repeat(86);
    await assert.rejects(commitPrivateTimerTransition(scope, request), { code: "FORBIDDEN" }); assert.deepEqual(await PrivateRecord.find().sort({ workspaceId: 1, kind: 1 }).lean(), before); assert.deepEqual((await privateTimerCheckpoint(scope.userId)).current, first); assert.equal(await PrivateTimerVersion.countDocuments(), 1);
  });
  it("stops a standard timer in the same transaction without retaining its text or end time in account history", async () => {
    const running = await standardEntry(), pointer = point(), request = await prepare(null, pointer, { workspaceId: standard, entryId: String(running._id) });
    await commitPrivateTimerTransition(scope, request); assert.equal((await TimeEntry.findById(running._id).lean())!.end!.toISOString(), instant); assert.equal(await EntryOperation.countDocuments({ workspaceId: standard }), 1);
    const metadata = JSON.stringify(await PrivateTimerVersion.find().lean()); assert.doesNotMatch(metadata, /Ordinary standard work|2026-10-01T12:00:00/);
    await assert.rejects(commitPrivateTimerTransition(scope, { ...request, standardStopEnd: "2026-10-01T13:00:00.000Z" }), { code: "CONFLICT", message: "OPERATION_ID_REUSED" });
    await commitPrivateTimerTransition(scope, request); assert.equal(await PrivateTimerVersion.countDocuments(), 1);
  });
  it("rolls a standard stop and its durable receipt back when the encrypted edit fails", async () => {
    const running = await standardEntry(), request = await prepare(null, point(), { workspaceId: standard, entryId: String(running._id) }); request.edits[0]!.signature = "A".repeat(86);
    await assert.rejects(commitPrivateTimerTransition(scope, request), { code: "FORBIDDEN" }); assert.equal((await TimeEntry.findById(running._id).lean())!.end, null); assert.equal(await EntryOperation.countDocuments(), 0); assert.equal(await PrivateTimerVersion.countDocuments(), 0); assert.equal((await privateTimerCheckpoint(scope.userId)).current, null);
  });
  it("discards entry and money together and refuses a partial lifecycle plan", async () => {
    const pointer = point(); await commitPrivateTimerTransition(scope, await prepare(null, pointer));
    const request = await prepare(pointer, null), base = request.edits[0]!;
    const rebind = async (edit: typeof base.edit) => {
      const directory = directories.get(pointer.workspaceId)!, packet = await signPrivateChainedWorkspaceEdit({ edit, directory, previousRoot: base.chain.header.previousRoot, secrets: { privateKey: encryption.privateKey, signingPrivateKey: signing.privateKey }, current: () => true });
      return { signed: await signPrivateTimer({ ...request.signed.header, edits: await privateTimerEditBindings([packet]) }, signing.privateKey, () => true), edits: [packet] };
    };
    const incomplete = await rebind({ ...base.edit, records: base.edit.records.filter(row => row.kind !== "entryMoney") }); await assert.rejects(commitPrivateTimerTransition(scope, incomplete), { code: "BAD_REQUEST" });
    const refs = (["entries", "entryMoney"] as const).map(kind => ({ kind, id: pointer.entryId, authorId: scope.userId, readers: [scope.userId] }));
    const discard = await rebind({ ...base.edit, records: [], remove: refs }); await commitPrivateTimerTransition(scope, discard); assert.equal((await privateTimerCheckpoint(scope.userId)).current, null);
    assert.equal(await PrivateRecord.countDocuments({ id: pointer.entryId, deleted: true }), 2); await commitPrivateTimerTransition(scope, discard); assert.equal(await PrivateTimerVersion.countDocuments(), 2);
  });
  it("rejects a restored empty or stale checkpoint while newer signed history still exists", async () => {
    const first = point(), next = point(b); await commitPrivateTimerTransition(scope, await prepare(null, first)); await commitPrivateTimerTransition(scope, await prepare(first, null));
    const inactive = (await PrivateAccount.findOne({ userId: scope.userId }).lean())!; await commitPrivateTimerTransition(scope, await prepare(null, next));
    await PrivateAccount.updateOne({ userId: scope.userId }, { $set: { timerRevision: inactive.timerRevision, timerRoot: inactive.timerRoot, timerSigned: inactive.timerSigned } });
    await assert.rejects(standardEntry(), { code: "PRECONDITION_FAILED" }); assert.equal(await TimeEntry.countDocuments(), 0);
    await PrivateAccount.updateOne({ userId: scope.userId }, { $set: { timerRevision: 0, timerRoot: null, timerSigned: null } }); await assert.rejects(privateTimerCheckpoint(scope.userId), { code: "PRECONDITION_FAILED" });
    await PrivateAccount.deleteMany({ userId: scope.userId }); await assert.rejects(standardEntry(), { code: "PRECONDITION_FAILED" }); assert.equal(await TimeEntry.countDocuments(), 0); assert.equal(await PrivateTimerVersion.countDocuments(), 3);
  });
  it("preserves work when timer history reaches its metadata budget or its stored checkpoint is malformed", async () => {
    const request = await prepare(null, point()); await PrivateAccount.updateOne({ userId: scope.userId }, { $set: { timerBytes: 128 * 1024 * 1024 } });
    await assert.rejects(commitPrivateTimerTransition(scope, request), { code: "PRECONDITION_FAILED" }); assert.equal(await PrivateRecord.countDocuments(), 0); assert.equal(await PrivateTimerVersion.countDocuments(), 0);
    await PrivateAccount.updateOne({ userId: scope.userId }, { $set: { timerBytes: 0, timerRevision: 1 } }); await assert.rejects(standardEntry(), { code: "PRECONDITION_FAILED" }); assert.equal(await TimeEntry.countDocuments(), 0);
  });
  it("serializes a private winner with a standard start sharing the same account fence", async () => {
    const pointer = point(), request = await prepare(null, pointer); let entered!: () => void, resume!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { resume = resolve; });
    const privateStart = withBusinessTransaction(async () => { await fencePrivateAccount(scope.userId); entered(); await gate; return commitPrivateTimerTransition(scope, request); });
    await ready; const standardStart = standardEntry(); const settled = Promise.allSettled([privateStart, standardStart]); resume(); const results = await settled;
    assert.equal(results[0]!.status, "fulfilled"); assert.equal(results[1]!.status, "rejected"); assert.equal(await TimeEntry.countDocuments({ end: null }), 0); assert.deepEqual((await privateTimerCheckpoint(scope.userId)).current, pointer);
  });
  it("refuses a stale private proposal after a standard start wins the account fence", async () => {
    const request = await prepare(null, point()); let entered!: () => void, resume!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { resume = resolve; });
    const standardStart = withBusinessTransaction(async () => { const entry = await standardEntry(); entered(); await gate; return entry; });
    await ready; const privateStart = commitPrivateTimerTransition(scope, request), settled = Promise.allSettled([standardStart, privateStart]); resume(); const results = await settled;
    assert.equal(results[0]!.status, "fulfilled"); assert.equal(results[1]!.status, "rejected"); assert.equal(await TimeEntry.countDocuments({ end: null }), 1); assert.equal(await PrivateTimerVersion.countDocuments(), 0); assert.equal(await PrivateRecord.countDocuments(), 0);
  });
  it("refuses changed intent, unrelated encrypted records and forged account signatures without appending history", async () => {
    const pointer = point(), request = await prepare(null, pointer), forged = structuredClone(request); forged.signed.signature = "A".repeat(86);
    await assert.rejects(commitPrivateTimerTransition(scope, forged), { code: "FORBIDDEN" }); await assert.rejects(commitPrivateTimerTransition({ ...scope, server: "https://other.test" }, request), { code: "FORBIDDEN" });
    const mixed = structuredClone(request); mixed.edits[0]!.edit.records[0]!.kind = "tags"; await assert.rejects(commitPrivateTimerTransition(scope, mixed), { code: "BAD_REQUEST" });
    await commitPrivateTimerTransition(scope, request); const changed = await prepare(pointer, point(b)); changed.signed.header.operationId = request.signed.header.operationId; changed.signed = await signPrivateTimer(changed.signed.header, signing.privateKey, () => true);
    await assert.rejects(commitPrivateTimerTransition(scope, changed), { code: "CONFLICT" }); assert.equal(await PrivateTimerVersion.countDocuments(), 1); assert.deepEqual((await privateTimerCheckpoint(scope.userId)).current, pointer);
    assert.equal(canonicalJson((await PrivateTimerVersion.findOne().lean())!.signed.header), canonicalJson(request.signed.header));
  });
});
