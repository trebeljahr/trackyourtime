import { Tag } from "../models/Tag.js";
import { standardContinueTimerInput } from "../services/privacy/standard-timer-continue.js";
import assert from "node:assert/strict";
import { before, beforeEach, after, describe, it } from "node:test";
import { canonicalJson, createKeyPair, createSigningPair, decryptPrivateRecord, encodeSecret, encryptPrivateRecord, privateMemberKeyFingerprint, privateRecordDigest, privateTimerEditBindings, privateTimerWitnessFromPacket, verifyPrivateTimerCurrentWitness, randomSecret, seal, signPrivateChainedWorkspaceEdit, signPrivateTimer, signPrivateWorkspaceDirectory, verifyPrivateWorkspaceDirectory, type VerifiedPrivateDirectory, type PlainPrivateRecord } from "@starter/core";
import type { PrivateTimerPointer, PrivateTimerTransition, SignedPrivateChainedEdit, PrivateStandardTimerStartInput } from "@starter/shared";
import { PrivateAccount, PrivateDirectory, PrivateRecord, PrivateWorkspace, PrivateWorkspaceCommit } from "../models/PrivateData.js";
import { PrivateTimerVersion } from "../models/PrivateTimer.js";
import { TimeEntry } from "../models/TimeEntry.js";
import { EntryOperation } from "../models/EntryOperation.js";
import { WorkspaceMember } from "../models/WorkspaceMember.js";
import { allModels } from "../models/registry.js";
import { commitPrivateTimerTransition } from "../services/privacy/account-timer.js";
import { privateTimerCheckpoint } from "../services/privacy/timer-state.js";
import { privateStandardTimerResult } from "../services/privacy/standard-timer-result.js";
import { standardAccountCurrentTimer } from "../services/privacy/standard-timer-current.js";
import { privateTimerVersions } from "../services/privacy/timer-versions.js";
import { privacyRouter } from "../trpc/routers/privacy.js";
import type { Context } from "../trpc/context.js";
import { env } from "../config/env.js";
import { currentEntry, personReach, workspaceReach } from "../services/entries/timer.js";
import { fencePrivateAccount } from "../services/privacy/account-erasure-fence.js";
import { withBusinessTransaction } from "../services/business-transaction.js";
import { clearTestDatabase, connectTestDatabase, dropTestDatabase, skipWithoutDatabase, testDatabaseTransactions } from "./support/test-database.js";
const scope = { server: "https://api.example.test", userId: "owner" }, standard = "standard", a = "private-a", b = "private-b";
const instant = "2026-10-01T12:00:00.000Z", privateDescription = "Private account timer description";
let encryption: Awaited<ReturnType<typeof createKeyPair>>, signing: Awaited<ReturnType<typeof createSigningPair>>;
let directories: Map<string, VerifiedPrivateDirectory>;
async function prepare(previous: PrivateTimerPointer | null, current: PrivateTimerPointer | null, standardStop?: { workspaceId: string; entryId: string }, standardStart?: { workspaceId: string; entryId: string; input: PrivateStandardTimerStartInput }) {
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
  const signed = await signPrivateTimer({ v: 1, protocol: "trackyourtime-private-account-timer-v1", ...scope, operationId: crypto.randomUUID(), revision: checkpoint.revision + 1, previousRoot: checkpoint.root, previous, current, standardStop: standardStop ?? null, ...(standardStart ? { standardStart: { workspaceId: standardStart.workspaceId, entryId: standardStart.entryId } } : {}), edits: await privateTimerEditBindings(edits) }, signing.privateKey, () => true);
  return { signed, edits, ...(standardStop ? { standardStopEnd: instant } : {}), ...(standardStart ? { standardStartInput: standardStart.input } : {}) } satisfies PrivateTimerTransition;
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
  it("prepares continuation fields without closing private time or copying old financial snapshots", async () => {
    const pointer = point(); await commitPrivateTimerTransition(scope, await prepare(null, pointer));
    const tag = await Tag.create({ workspaceId: standard, name: "Retained", createdBy: scope.userId });
    const source = await standardEntry(new Date(instant));
    await TimeEntry.updateOne({ _id: source._id }, { $set: { billable: true, hourlyRate: 999, timeZone: "Europe/Berlin", tagIds: [String(tag._id), crypto.randomUUID().replaceAll("-", "").slice(0, 24)] } });
    const before = await privateTimerCheckpoint(scope.userId), original = await TimeEntry.findById(source._id).lean();
    const result = await standardContinueTimerInput(scope.userId, { workspaceId: standard, id: String(source._id), at: instant, timeZone: "Australia/Sydney", originId: "continuation-test" });
    assert.equal(result.description, source.description); assert.equal(result.start, instant); assert.equal(result.timeZone, "Australia/Sydney"); assert.equal(result.originId, "continuation-test"); assert.equal(result.billable, true); assert.deepEqual(result.tagIds, [String(tag._id)]);
    assert.equal("hourlyRate" in result, false); assert.equal("authorId" in result, false); assert.equal("end" in result, false);
    assert.deepEqual(await TimeEntry.findById(source._id).lean(), original); assert.deepEqual(await privateTimerCheckpoint(scope.userId), before);
    assert.equal(await EntryOperation.countDocuments(), 0); assert.equal(await TimeEntry.countDocuments(), 1);
  });
  it("checks fresh continuation source visibility, membership and standard storage mode", async () => {
    const source = await TimeEntry.create({ workspaceId: standard, authorId: "colleague", description: "Visible colleague source", start: new Date("2026-10-01T10:00:00.000Z"), end: new Date(instant) }), request = { workspaceId: standard, id: String(source._id), at: instant };
    await assert.rejects(standardContinueTimerInput(scope.userId, request), { code: "NOT_FOUND" });
    await WorkspaceMember.updateOne({ workspaceId: standard, userId: scope.userId }, { $set: { canViewOthersTime: true } });
    assert.equal((await standardContinueTimerInput(scope.userId, request)).description, source.description);
    await assert.rejects(standardContinueTimerInput(scope.userId, { ...request, workspaceId: a }), { code: "PRECONDITION_FAILED" });
    await WorkspaceMember.deleteOne({ workspaceId: standard, userId: scope.userId });
    await assert.rejects(standardContinueTimerInput(scope.userId, request), { code: "NOT_FOUND" });
    assert.equal(await TimeEntry.countDocuments(), 1); assert.equal(await EntryOperation.countDocuments(), 0);
  });

  async function receiptPacket(request: PrivateTimerTransition, receiptOperationId = request.signed.header.operationId) {
    const original = request.edits[0]!, directory = directories.get(original.edit.workspaceId)!;
    const receipt = await encryptPrivateRecord(original.edit.workspaceId, { kind: "imports", id: `entryoperations:${receiptOperationId}`, authorId: scope.userId, value: { _id: receiptOperationId, workspaceId: original.edit.workspaceId, userId: scope.userId, protocol: "trackyourtime-private-timer-operation-v1", result: { description: "Encrypted original retry result" } } }, directory.signed.directory.members, original.edit.expectedRevision + 1);
    const edit = await signPrivateChainedWorkspaceEdit({ edit: { ...original.edit, records: [...original.edit.records, receipt] }, directory, previousRoot: original.chain.header.previousRoot, secrets: { privateKey: encryption.privateKey, signingPrivateKey: signing.privateKey }, current: () => true });
    const edits = request.edits.map(row => row === original ? edit : row), signed = await signPrivateTimer({ ...request.signed.header, edits: await privateTimerEditBindings(edits) }, signing.privateKey, () => true);
    return { ...request, signed, edits };
  }
  it("atomically stores an encrypted author-owned retry receipt at the signed timer operation address", async () => {
    const pointer = point(), request = await receiptPacket(await prepare(null, pointer));
    await commitPrivateTimerTransition(scope, request);
    assert.equal(await PrivateRecord.countDocuments({ workspaceId: a, kind: "imports", id: `entryoperations:${request.signed.header.operationId}`, authorId: scope.userId }), 1);
    assert.doesNotMatch(JSON.stringify(await PrivateRecord.find().lean()), /Encrypted original retry result/);
    const witness = await privateTimerWitnessFromPacket(request);
    await verifyPrivateTimerCurrentWitness(witness, request.signed, { scope, signingPublicKey: signing.publicKey, current: () => true });
    await commitPrivateTimerTransition(scope, request); assert.equal(await PrivateWorkspaceCommit.countDocuments(), 1);
  });
  it("refuses another operation's receipt address without advancing either history", async () => {
    const request = await receiptPacket(await prepare(null, point()), crypto.randomUUID());
    await assert.rejects(commitPrivateTimerTransition(scope, request), { code: "BAD_REQUEST" });
    assert.equal(await PrivateRecord.countDocuments(), 0); assert.equal(await PrivateTimerVersion.countDocuments(), 0); assert.equal((await privateTimerCheckpoint(scope.userId)).revision, 0);
  });
  it("reads the exact original standard handoff result after later stops without creating any time", async () => {
    const pointer = point(), entryId = crypto.randomUUID().replaceAll("-", "").slice(0, 24), input = { start: instant, description: "Original standard handoff result", source: "desktop" as const };
    await commitPrivateTimerTransition(scope, await prepare(null, pointer));
    const request = await prepare(pointer, null, undefined, { workspaceId: standard, entryId, input }); await commitPrivateTimerTransition(scope, request);
    const lookup = { workspaceId: standard, entryId, operationId: request.signed.header.operationId, input }, original = await privateStandardTimerResult(scope, lookup);
    assert.equal(original.id, entryId); assert.equal(original.description, input.description); assert.equal(original.end, null);
    await TimeEntry.updateOne({ _id: entryId }, { $set: { end: new Date("2026-10-01T13:00:00.000Z") } });
    await commitPrivateTimerTransition(scope, await prepare(null, point(b)));
    const before = { entries: await TimeEntry.countDocuments(), versions: await PrivateTimerVersion.countDocuments(), receipts: await EntryOperation.countDocuments() };
    assert.deepEqual(await privateStandardTimerResult(scope, lookup), original); assert.notEqual((await TimeEntry.findById(entryId).lean())!.end, null);
    await assert.rejects(privateStandardTimerResult(scope, { ...lookup, input: { ...input, description: "Changed request" } }), { code: "CONFLICT" });
    await assert.rejects(privateStandardTimerResult({ ...scope, userId: "other" }, lookup), { code: "NOT_FOUND" });
    await assert.rejects(privateStandardTimerResult(scope, { ...lookup, entryId: "b".repeat(24) }), { code: "NOT_FOUND" });
    await WorkspaceMember.deleteMany({ workspaceId: standard, userId: scope.userId }); await assert.rejects(privateStandardTimerResult(scope, lookup), { code: "NOT_FOUND" });
    assert.deepEqual({ entries: await TimeEntry.countDocuments(), versions: await PrivateTimerVersion.countDocuments(), receipts: await EntryOperation.countDocuments() }, before);
  });
  it("refuses standard result recovery after conversion or loss of the original receipt", async () => {
    const pointer = point(), entryId = crypto.randomUUID().replaceAll("-", "").slice(0, 24), input = { start: instant };
    await commitPrivateTimerTransition(scope, await prepare(null, pointer)); const request = await prepare(pointer, null, undefined, { workspaceId: standard, entryId, input }); await commitPrivateTimerTransition(scope, request);
    const lookup = { workspaceId: standard, entryId, operationId: request.signed.header.operationId, input };
    await PrivateWorkspace.create({ workspaceId: standard, ownerId: scope.userId, state: "encrypted", revision: 1, head: encodeSecret(randomSecret()), directoryDigest: encodeSecret(randomSecret()), migrationId: crypto.randomUUID(), sourceRevision: "retired", leaseUntil: new Date() });
    await assert.rejects(privateStandardTimerResult(scope, lookup), { code: "PRECONDITION_FAILED" }); await PrivateWorkspace.deleteMany({ workspaceId: standard });
    await EntryOperation.deleteMany({ operation: "private:timer:standardStart" });
    await assert.rejects(privateStandardTimerResult(scope, lookup), { code: "CONFLICT" });
    assert.equal(await EntryOperation.countDocuments({ operation: "private:timer:standardStart" }), 0); assert.equal(await TimeEntry.countDocuments({ _id: entryId }), 1);
  });
  it("keeps claim metadata and workspace time atomic while retaining only encrypted business content", async () => {
    const pointer = point(), request = await prepare(null, pointer), saved = await commitPrivateTimerTransition(scope, request);
    assert.equal(saved.revision, 1); assert.deepEqual((await privateTimerCheckpoint(scope.userId)).current, pointer); assert.equal((await readEntry(pointer)).value.end, null);
    assert.equal(await TimeEntry.countDocuments(), 0); assert.equal(await PrivateWorkspaceCommit.countDocuments(), 1); assert.equal(await PrivateTimerVersion.countDocuments(), 1);
    await assert.rejects(standardAccountCurrentTimer(scope.userId), { code: "PRECONDITION_FAILED", message: "PRIVATE_WORKSPACE_REQUIRES_UNLOCK" });
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
  it("atomically closes private time and starts a fixed-identity standard timer without retaining standard content in account metadata", async () => {
    const pointer = point(); await commitPrivateTimerTransition(scope, await prepare(null, pointer));
    const target = { workspaceId: standard, entryId: crypto.randomUUID().replaceAll("-", "").slice(0, 24), input: { description: "Standard transition content", start: instant, source: "desktop" as const, timeZone: "UTC" } };
    const packet = await prepare(pointer, null, undefined, target);
    const missingBody = structuredClone(packet); delete missingBody.standardStartInput; await assert.rejects(commitPrivateTimerTransition(scope, missingBody), { code: "BAD_REQUEST" });
    await assert.rejects(commitPrivateTimerTransition(scope, { ...packet, standardStartInput: { description: "Missing timestamp" } }), { code: "BAD_REQUEST" });
    assert.deepEqual((await privateTimerCheckpoint(scope.userId)).current, pointer);
    const saved = await commitPrivateTimerTransition(scope, packet);
    assert.equal(saved.revision, 2); assert.equal((await privateTimerCheckpoint(scope.userId)).current, null); assert.equal((await readEntry(pointer)).value.end, instant);
    const row = (await TimeEntry.findById(target.entryId).lean())!; assert.equal(row.description, target.input.description); assert.equal(row.end, null); assert.equal(row.start.toISOString(), instant);
    const metadata = JSON.stringify([await PrivateAccount.find().lean(), await PrivateTimerVersion.find().lean()]); assert.doesNotMatch(metadata, /Standard transition content|2026-10-01T12:00:00|standardStartInput/);
    const receipt = (await EntryOperation.findOne({ userId: scope.userId, operation: "private:timer:standardStart" }).lean())!; assert.equal(receipt.workspaceId, standard); assert.match(JSON.stringify(receipt.result), /Standard transition content/);
    assert.deepEqual(await commitPrivateTimerTransition(scope, packet), saved); assert.equal(await TimeEntry.countDocuments(), 1);
    await assert.rejects(commitPrivateTimerTransition(scope, { ...packet, standardStartInput: { ...target.input, description: "Changed standard content" } }), { code: "CONFLICT" });
    await TimeEntry.updateOne({ _id: target.entryId }, { $set: { end: new Date(Date.parse(instant) + 60_000) } });
    assert.deepEqual(await commitPrivateTimerTransition(scope, packet), saved); assert.notEqual((await TimeEntry.findById(target.entryId).lean())!.end, null);
    await EntryOperation.deleteOne({ _id: receipt._id });
    await assert.rejects(commitPrivateTimerTransition(scope, packet), { code: "CONFLICT" }); assert.notEqual((await TimeEntry.findById(target.entryId).lean())!.end, null); assert.equal(await PrivateTimerVersion.countDocuments(), 2);
  });
  it("rolls the private close and account head back when standard references, membership, identity or storage mode refuse the handoff", async () => {
    const pointer = point(); await commitPrivateTimerTransition(scope, await prepare(null, pointer)); const before = await privateTimerCheckpoint(scope.userId);
    for (const failure of ["references", "membership", "identity", "private"] as const) {
      const target = { workspaceId: failure === "private" ? b : standard, entryId: crypto.randomUUID().replaceAll("-", "").slice(0, 24), input: { description: "Standard transition content", start: instant, ...(failure === "references" ? { projectId: "f".repeat(24) } : {}) } };
      if (failure === "membership") await WorkspaceMember.deleteOne({ workspaceId: standard, userId: scope.userId });
      if (failure === "identity") await TimeEntry.create({ _id: target.entryId, workspaceId: "foreign", authorId: "other", description: "Unrelated completed time", start: new Date("2026-10-01T10:00:00.000Z"), end: new Date(instant) });
      const packet = await prepare(pointer, null, undefined, target);
      await assert.rejects(commitPrivateTimerTransition(scope, packet), { code: failure === "private" ? "PRECONDITION_FAILED" : failure === "identity" ? "CONFLICT" : "NOT_FOUND" });
      if (failure === "membership") await WorkspaceMember.create({ workspaceId: standard, userId: scope.userId, role: "owner", name: "Owner" });
      const after = await privateTimerCheckpoint(scope.userId); assert.equal(after.root, before.root); assert.deepEqual(after.current, pointer); assert.equal((await readEntry(pointer)).value.end, null);
      assert.equal(await TimeEntry.countDocuments({ authorId: scope.userId }), 0); assert.equal(await EntryOperation.countDocuments(), 0); assert.equal(await PrivateTimerVersion.countDocuments(), 1); assert.equal(await PrivateWorkspaceCommit.countDocuments(), 1);
    }
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
  it("keeps metadata headroom for one final stop while refusing a new start or switch", async () => {
    const pointer = point(); await commitPrivateTimerTransition(scope, await prepare(null, pointer));
    await PrivateAccount.updateOne({ userId: scope.userId }, { $set: { timerBytes: 128 * 1024 * 1024 } });
    await assert.rejects(commitPrivateTimerTransition(scope, await prepare(pointer, point(b))), { code: "PRECONDITION_FAILED" });
    assert.deepEqual((await privateTimerCheckpoint(scope.userId)).current, pointer); assert.equal(await PrivateTimerVersion.countDocuments(), 1);
    await assert.rejects(commitPrivateTimerTransition(scope, await prepare(pointer, null, undefined, { workspaceId: standard, entryId: crypto.randomUUID().replaceAll("-", "").slice(0, 24), input: { start: instant } })), { code: "PRECONDITION_FAILED" });
    await commitPrivateTimerTransition(scope, await prepare(pointer, null));
    assert.equal((await privateTimerCheckpoint(scope.userId)).current, null); assert.equal((await readEntry(pointer)).value.end, instant);
    const used = (await PrivateAccount.findOne({ userId: scope.userId }).lean())!.timerBytes;
    assert.ok(used > 128 * 1024 * 1024 && used <= 128 * 1024 * 1024 + 64 * 1024);
    await assert.rejects(commitPrivateTimerTransition(scope, await prepare(null, point())), { code: "PRECONDITION_FAILED" }); assert.equal(await PrivateTimerVersion.countDocuments(), 2);
    await standardEntry(); assert.equal(await TimeEntry.countDocuments({ authorId: scope.userId, end: null }), 1);
  });
  it("serves only authenticated account metadata within an immutable requested history boundary", async () => {
    assert.deepEqual(await privateTimerVersions(scope, 0), { through: 0, root: null, next: null, versions: [] });
    const first = point(), second = point(b), start = await prepare(null, first); await commitPrivateTimerTransition(scope, start);
    const change = await prepare(first, second); await commitPrivateTimerTransition(scope, change);
    const stop = await prepare(second, null); await commitPrivateTimerTransition(scope, stop);
    const page = await privateTimerVersions(scope, 0, 2);
    assert.deepEqual(page.versions, [start.signed, change.signed]); assert.equal(page.root, await privateRecordDigest(change.signed.header)); assert.equal(page.next, null); assert.equal(page.through, 2);
    assert.deepEqual(Object.keys(page).sort(), ["next", "root", "through", "versions"]);
    assert.doesNotMatch(JSON.stringify(page), /Private account timer description|hourlyRate|2026-10-01|identity|recovery/);
    assert.deepEqual((await privateTimerVersions(scope, 2)).versions, [stop.signed]); assert.deepEqual((await privateTimerVersions(scope, 3)).versions, []);
    await assert.rejects(privateTimerVersions(scope, 4), { code: "CONFLICT" }); await assert.rejects(privateTimerVersions(scope, 0, 4), { code: "CONFLICT" });
    await assert.rejects(privateTimerVersions(scope, 0.5), { code: "BAD_REQUEST" });
    await assert.rejects(privateTimerVersions({ ...scope, userId: "other" }, 0), { code: "PRECONDITION_FAILED" });
    await assert.rejects(privateTimerVersions({ ...scope, server: "https://other.test" }, 0), { code: "PRECONDITION_FAILED" });
  });
  it("keeps public timer writes closed and confines metadata reads to the authenticated account", async t => {
    const originalOrigin = env.BETTER_AUTH_URL; Reflect.set(env, "BETTER_AUTH_URL", scope.server); t.after(() => { Reflect.set(env, "BETTER_AUTH_URL", originalOrigin); });
    const caller = privacyRouter.createCaller({ user: { id: scope.userId }, session: { user: { id: scope.userId } } } as unknown as Context);
    const continuation = { workspaceId: standard, id: "000000000000000000000001", at: instant };
    await assert.rejects(caller.standardContinueTimerInput(continuation), { code: "NOT_FOUND" });
    await assert.rejects(privacyRouter.createCaller({ user: null, session: null } as unknown as Context).standardContinueTimerInput(continuation), { code: "UNAUTHORIZED" });
    await assert.rejects(caller.standardContinueTimerInput({ ...continuation, userId: "other" } as never), { code: "BAD_REQUEST" });
    assert.deepEqual(await caller.timerVersions({ after: 0 }), { through: 0, root: null, next: null, versions: [] });
    await assert.rejects(caller.timerWrite(await prepare(null, point())), { code: "NOT_IMPLEMENTED" });
    assert.equal(await PrivateRecord.countDocuments(), 0); assert.equal(await PrivateTimerVersion.countDocuments(), 0);
    const other = privacyRouter.createCaller({ user: { id: "other" }, session: { user: { id: "other" } } } as unknown as Context);
    await assert.rejects(other.timerVersions({ after: 0 }), { code: "PRECONDITION_FAILED" });
    const anonymous = privacyRouter.createCaller({ user: null, session: null } as unknown as Context);
    await assert.rejects(anonymous.timerVersions({ after: 0 }), { code: "UNAUTHORIZED" });
    const missingResult = { operationId: crypto.randomUUID(), workspaceId: standard, entryId: "a".repeat(24), input: { start: instant } };
    await assert.rejects(caller.standardTimerResult(missingResult), { code: "NOT_FOUND" });
    await assert.rejects(anonymous.standardTimerResult(missingResult), { code: "UNAUTHORIZED" });
    await assert.rejects(caller.standardTimerResult({ ...missingResult, userId: "other" } as never), { code: "BAD_REQUEST" });

  });
  it("paginates a fixed timer root without including later account operations", async () => {
    const pointer = point(); await commitPrivateTimerTransition(scope, await prepare(null, pointer));
    for (let revision = 2; revision <= 18; revision++) await commitPrivateTimerTransition(scope, await prepare(pointer, pointer));
    const first = await privateTimerVersions(scope, 0); assert.equal(first.versions.length, 16); assert.equal(first.next, 16); assert.equal(first.through, 18);
    await commitPrivateTimerTransition(scope, await prepare(pointer, null));
    const last = await privateTimerVersions(scope, first.next!, first.through); assert.equal(last.through, 18); assert.equal(last.root, first.root); assert.equal(last.next, null); assert.deepEqual(last.versions.map(row => row.header.revision), [17, 18]);
    assert.equal((await privateTimerVersions(scope, 18)).versions[0]!.header.revision, 19);
  });
  it("refuses missing or corrupted retained timer versions without publishing a partial page", async () => {
    const pointer = point(); await commitPrivateTimerTransition(scope, await prepare(null, pointer)); await commitPrivateTimerTransition(scope, await prepare(pointer, pointer)); await commitPrivateTimerTransition(scope, await prepare(pointer, null));
    const middle = (await PrivateTimerVersion.findOne({ userId: scope.userId, revision: 2 }).lean())!;
    await PrivateTimerVersion.updateOne({ _id: middle._id }, { $set: { "signed.signature": "A".repeat(86) } });
    await assert.rejects(privateTimerVersions(scope, 0), { code: "PRECONDITION_FAILED" });
    await PrivateTimerVersion.updateOne({ _id: middle._id }, { $set: { signed: middle.signed } }); await PrivateTimerVersion.deleteOne({ _id: middle._id });
    await assert.rejects(privateTimerVersions(scope, 0), { code: "PRECONDITION_FAILED" }); await assert.rejects(privateTimerVersions(scope, 2), { code: "PRECONDITION_FAILED" });
    assert.equal((await privateTimerCheckpoint(scope.userId)).revision, 3); assert.equal(await PrivateTimerVersion.countDocuments(), 2);
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
