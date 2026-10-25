import assert from "node:assert/strict";
import { before, after, beforeEach, describe, it } from "node:test";
import { createKeyPair, createSigningPair, createPrivateWorkspaceReplica, memoryStorage, encryptPrivateRecord, randomSecret, seal, signPrivateWorkspaceEdit, verifyPrivateWorkspaceChange } from "@starter/core";
import { PrivateAccount, PrivateRecord, PrivateWorkspace, PrivateWorkspaceCommit } from "../models/PrivateData.js";
import { WorkspaceMember } from "../models/WorkspaceMember.js";
import { WorkspaceWriteFence } from "../models/TimesheetApproval.js";
import { mongooseRowStore } from "../services/account-deletion/stores.js";
import { commitPrivateWorkspaceEdit, privateWorkspaceChanges } from "../services/privacy/workspace-edits.js";
import { connectTestDatabase, clearTestDatabase, dropTestDatabase, skipWithoutDatabase } from "./support/test-database.js";
import { privacyRouter } from "../trpc/routers/privacy.js";
import type { Context } from "../trpc/context.js";
import type { PrivateWorkspaceEdit } from "@starter/shared";
const WS = "workspace", OWNER = "owner", MEMBER = "member";
let ownerKey: Awaited<ReturnType<typeof createKeyPair>>, signing: Awaited<ReturnType<typeof createSigningPair>>, members: Parameters<typeof encryptPrivateRecord>[2];
async function edit(revision: number, id: string, kind: "entries" | "tags" = "entries", authorId: string | null = OWNER) {
  const row = await encryptPrivateRecord(WS, { kind, id, authorId, value: { description: `secret-${id}` } }, members, revision + 1);
  return signPrivateWorkspaceEdit({ v: 1, workspaceId: WS, userId: OWNER, operationId: crypto.randomUUID(), expectedRevision: revision, records: [row], remove: [] }, signing.privateKey, members.map((row) => row.userId));
}
describe("signed private workspace journal", { skip: skipWithoutDatabase }, () => {
  before(() => connectTestDatabase("private-workspace-edits", [PrivateAccount, PrivateRecord, PrivateWorkspace, PrivateWorkspaceCommit, WorkspaceMember, WorkspaceWriteFence] as never));
  beforeEach(async () => {
    await clearTestDatabase();
    signing = await createSigningPair(); const key = ownerKey = await createKeyPair();
    await PrivateAccount.create({ userId: OWNER, identity: { publicKey: key.publicKey, signingPublicKey: signing.publicKey, recovery: await seal(randomSecret(), {}, "test-root"), passkeys: [] } });
    await WorkspaceMember.create([{ workspaceId: WS, userId: OWNER, role: "owner", name: "Owner" }, { workspaceId: WS, userId: MEMBER, role: "member", name: "Member" }]);
    members = [{ userId: OWNER, role: "owner", canViewOthersTime: true, canViewOthersMoney: true, publicKey: key.publicKey }, { userId: MEMBER, role: "member", canViewOthersTime: false, canViewOthersMoney: false, publicKey: (await createKeyPair()).publicKey }];
    await PrivateWorkspace.create({ workspaceId: WS, ownerId: OWNER, state: "encrypted", revision: 0, leaseUntil: new Date(), migrationId: crypto.randomUUID(), sourceRevision: "synthetic" });
  });
  after(dropTestDatabase);
  it("refuses a signed new edit without its record-key binding before changing stored state", async () => {
    const input = await edit(0, "missing-binding"), { keyCommitment: _key, ...legacyShape } = input.edit.records[0]!;
    const stripped = await signPrivateWorkspaceEdit({ ...input.edit, records: [legacyShape] }, signing.privateKey, members.map((row) => row.userId));
    await assert.rejects(commitPrivateWorkspaceEdit(OWNER, stripped), { code: "BAD_REQUEST", message: "New private edits require committed record keys." });
    assert.equal(await PrivateRecord.countDocuments(), 0); assert.equal(await PrivateWorkspaceCommit.countDocuments(), 0);
    assert.equal((await PrivateWorkspace.findOne().lean())!.revision, 0);
  });
  it("commits atomically, persists only ciphertext, retries after later saves, and refuses operation-ID reuse", async () => {
    const first = await edit(0, "first");
    assert.deepEqual(await commitPrivateWorkspaceEdit(OWNER, first), { revision: 1 });
    assert.deepEqual(await commitPrivateWorkspaceEdit(OWNER, await edit(1, "second")), { revision: 2 });
    assert.deepEqual(await commitPrivateWorkspaceEdit(OWNER, first), { revision: 1 });
    const changed = await edit(2, "replacement"); changed.edit.operationId = first.edit.operationId;
    await assert.rejects(commitPrivateWorkspaceEdit(OWNER, changed), { code: "CONFLICT" });
    assert.equal(await PrivateWorkspaceCommit.countDocuments(), 2);
    assert.doesNotMatch(JSON.stringify(await PrivateWorkspaceCommit.find().lean()), /secret-first|secret-second/);
    const feed = await privateWorkspaceChanges(WS, OWNER, 0);
    for (let n = 0; n < feed.changes.length; n++) await verifyPrivateWorkspaceChange(feed.changes[n], { workspaceId: WS, userId: OWNER, after: n }, signing.publicKey);
    assert.equal(feed.through, 2); assert.equal(feed.next, null);
  });
  it("fixes pagination bounds, filters ciphertext by recipient and keeps deletion history after concurrent edits", async () => {
    await commitPrivateWorkspaceEdit(OWNER, await edit(0, "first"));
    await commitPrivateWorkspaceEdit(OWNER, await edit(1, "shared-tag", "tags", null));
    const page = await privateWorkspaceChanges(WS, MEMBER, 0, undefined, 1);
    assert.equal(page.through, 2); assert.equal(page.next, 1); assert.equal(page.changes[0]!.records.length, 0);
    assert.equal(page.changes[0]!.manifest.records.length, 0);
    assert.doesNotMatch(JSON.stringify(page.changes[0]), /first|entries/);
    await verifyPrivateWorkspaceChange(page.changes[0], { workspaceId: WS, userId: MEMBER, after: 0 }, signing.publicKey);
    const deletion: PrivateWorkspaceEdit = { v: 1, workspaceId: WS, userId: OWNER, operationId: crypto.randomUUID(), expectedRevision: 2, records: [], remove: [{ kind: "entries", id: "first", authorId: OWNER, readers: [OWNER] }] };
    await commitPrivateWorkspaceEdit(OWNER, await signPrivateWorkspaceEdit(deletion, signing.privateKey, members.map((row) => row.userId)));
    const next = await privateWorkspaceChanges(WS, MEMBER, page.next!, page.through, 1);
    assert.equal(next.through, 2); assert.equal(next.next, null); assert.equal(next.changes[0]!.records[0]!.id, "shared-tag");
    await verifyPrivateWorkspaceChange(next.changes[0], { workspaceId: WS, userId: MEMBER, after: 1 }, signing.publicKey);
    const last = await privateWorkspaceChanges(WS, OWNER, 2);
    await verifyPrivateWorkspaceChange(last.changes[0], { workspaceId: WS, userId: OWNER, after: 2 }, signing.publicKey);
    assert.equal(last.changes[0]!.manifest.remove[0]!.id, "first");
    const tombstone = await PrivateRecord.findOne({ id: "first" }).lean(); assert.equal(tombstone?.deleted, true); assert.equal(tombstone?.revision, 1);
  });
  it("rejects forged signatures and audiences and rolls back invalid batches", async () => {
    const valid = await edit(0, "first");
    const forged = structuredClone(valid); forged.signature = "A".repeat(86);
    await assert.rejects(commitPrivateWorkspaceEdit(OWNER, forged), { code: "FORBIDDEN" });
    await assert.rejects(commitPrivateWorkspaceEdit(MEMBER, valid), { code: "FORBIDDEN" });
    const wrongReader = structuredClone(valid); wrongReader.readerSignatures[0]!.signature = "A".repeat(86);
    await assert.rejects(commitPrivateWorkspaceEdit(OWNER, wrongReader), { code: "FORBIDDEN" });
    const missingReader = structuredClone(valid); missingReader.readerSignatures.pop();
    await assert.rejects(commitPrivateWorkspaceEdit(OWNER, missingReader), { code: "BAD_REQUEST" });
    const bad = structuredClone(valid.edit); bad.records[0]!.grants.push({ ...bad.records[0]!.grants[0]!, userId: MEMBER });
    await assert.rejects(commitPrivateWorkspaceEdit(OWNER, await signPrivateWorkspaceEdit(bad, signing.privateKey, members.map((row) => row.userId))), { code: "BAD_REQUEST" });
    const missing = { ...valid.edit, remove: [{ kind: "entries" as const, id: "missing", authorId: OWNER, readers: [OWNER] }] };
    await assert.rejects(commitPrivateWorkspaceEdit(OWNER, await signPrivateWorkspaceEdit(missing, signing.privateKey, members.map((row) => row.userId))), { code: "CONFLICT" });
    assert.equal(await PrivateRecord.countDocuments(), 0); assert.equal(await PrivateWorkspaceCommit.countDocuments(), 0); assert.equal((await PrivateWorkspace.findOne().lean())!.revision, 0);
  });
  it("round-trips a durable encrypted client outbox through the real database journal", async () => {
    const storageKey = randomSecret();
    const replica = await createPrivateWorkspaceReplica({ storage: memoryStorage(), scope: { server: "https://api.example.test", userId: OWNER, workspaceId: WS }, exclusive: (task) => task(), resolveStorageKey: () => ({ key: storageKey, current: () => true }), resolveIdentity: () => ({ directoryDigest: "verified-test-directory", privateKey: ownerKey.privateKey, signingPrivateKey: signing.privateKey, recipients: members, signingKey: () => signing.publicKey, current: () => true }) });
    const transport = { commit: (input: Parameters<typeof commitPrivateWorkspaceEdit>[1]) => commitPrivateWorkspaceEdit(OWNER, input), changes: (input: { after: number; through?: number }) => privateWorkspaceChanges(WS, OWNER, input.after, input.through) };
    await replica.enqueue({ records: [{ kind: "entries", id: "roundtrip", authorId: OWNER, value: { description: "Never on server in plaintext" } }] });
    assert.deepEqual(await replica.flushOne(transport), { revision: 1, pending: 0 });
    assert.equal((await replica.read()).records[0]!.value.description, "Never on server in plaintext");
    assert.doesNotMatch(JSON.stringify(await PrivateRecord.find().lean()), /Never on server in plaintext/);
    await replica.enqueue({ records: [], remove: [{ kind: "entries", id: "roundtrip", authorId: OWNER }] });
    await replica.flushOne(transport); assert.equal((await replica.read()).records.length, 0);
  });
  it("erases favorites from mixed journals without invalidating another member's signed feed", async () => {
    const records = await Promise.all([
      encryptPrivateRecord(WS, { kind: "tags", id: "shared", authorId: null, value: { name: "Shared tag" } }, members, 1),
      encryptPrivateRecord(WS, { kind: "entries", id: "work", authorId: OWNER, value: { description: "Retained shared work" } }, members, 1),
      encryptPrivateRecord(WS, { kind: "favorites", id: "private", authorId: OWNER, value: { label: "Private pin" } }, members, 1),
    ]);
    const signed = await signPrivateWorkspaceEdit({ v: 1, workspaceId: WS, userId: OWNER, operationId: crypto.randomUUID(), expectedRevision: 0, records, remove: [] }, signing.privateKey, members.map((row) => row.userId));
    await commitPrivateWorkspaceEdit(OWNER, signed);
    const before = await privateWorkspaceChanges(WS, MEMBER, 0);
    const manifest = (await PrivateWorkspaceCommit.findOne().lean())!.manifest;
    await mongooseRowStore.deleteMany("workspaceMembers", { workspaceId: WS, userId: OWNER });
    await mongooseRowStore.erasePrivateUserData(OWNER);
    await mongooseRowStore.deleteMany("privateAccounts", { userId: OWNER });
    await mongooseRowStore.erasePrivateUserData(OWNER); // idempotent retry
    assert.deepEqual((await PrivateRecord.find().lean()).map((row) => row.id).sort(), ["shared", "work"]);
    const journal = (await PrivateWorkspaceCommit.findOne().lean())!;
    assert.deepEqual(journal.records.map((row) => row.id).sort(), ["shared", "work"]);
    assert.deepEqual(journal.manifest, manifest);
    assert.equal(journal.readerSignatures.some((row) => row.userId === OWNER), false);
    const after = await privateWorkspaceChanges(WS, MEMBER, 0);
    assert.deepEqual(after, before);
    await verifyPrivateWorkspaceChange(after.changes[0]!, { workspaceId: WS, userId: MEMBER, after: 0 }, signing.publicKey);
    assert.equal(await PrivateAccount.countDocuments({ userId: OWNER }), 0);
    await assert.rejects(commitPrivateWorkspaceEdit(OWNER, signed), { code: "NOT_FOUND" });
  });
  it("keeps the public journal endpoints closed during the unfinished rollout", async () => {
    const caller = privacyRouter.createCaller({ user: { id: OWNER }, session: { user: { id: OWNER } } } as unknown as Context);
    await assert.rejects(caller.signedWrite({ workspaceId: WS, ...await edit(0, "disabled") }), { code: "NOT_IMPLEMENTED" });
    await assert.rejects(caller.changes({ workspaceId: WS, after: 0 }), { code: "NOT_IMPLEMENTED" });
    assert.equal(await PrivateWorkspaceCommit.countDocuments(), 0);
  });
  it("serializes competing edits and refuses missing journal revisions", async () => {
    const attempts = await Promise.allSettled([commitPrivateWorkspaceEdit(OWNER, await edit(0, "a")), commitPrivateWorkspaceEdit(OWNER, await edit(0, "b"))]);
    assert.equal(attempts.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(await PrivateWorkspaceCommit.countDocuments(), 1);
    await PrivateWorkspaceCommit.deleteMany();
    await assert.rejects(privateWorkspaceChanges(WS, OWNER, 0), /journal is incomplete/);
    await assert.rejects(privateWorkspaceChanges(WS, "stranger", 0), { code: "NOT_FOUND" });
  });
});
