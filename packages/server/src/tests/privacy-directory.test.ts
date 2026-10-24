import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { createKeyPair, createSigningPair, randomSecret, seal, signPrivateChange, verifyPrivateWorkspaceDirectory, type PrivateDirectoryTrust } from "@starter/core";
import type { PrivateDirectoryMember, PrivateWorkspaceDirectory } from "@starter/shared";
import { PrivateAccount, PrivateDirectory, PrivateWorkspace } from "../models/PrivateData.js";
import { WorkspaceMember } from "../models/WorkspaceMember.js";
import { WorkspaceWriteFence } from "../models/TimesheetApproval.js";
import { commitPrivateDirectory, privateDirectoryPage } from "../services/privacy/directories.js";
import { privacyRouter } from "../trpc/routers/privacy.js";
import type { Context } from "../trpc/context.js";
import { clearTestDatabase, connectTestDatabase, dropTestDatabase, skipWithoutDatabase } from "./support/test-database.js";

const scope = { server: "https://api.example.test", workspaceId: "workspace", userId: "owner" };
let signing: Awaited<ReturnType<typeof createSigningPair>>, successor: Awaited<ReturnType<typeof createSigningPair>>, people: PrivateDirectoryMember[];
const signed = async (directory: PrivateWorkspaceDirectory, signerId = "owner", privateKey = signing.privateKey) => ({ directory, signerId, signature: await signPrivateChange(privateKey, { protocol: "trackyourtime-workspace-directory-v1", directory, signerId }) });
const directory = (revision = 1, previousDigest: string | null = null): PrivateWorkspaceDirectory => ({ v: 1, server: scope.server, workspaceId: scope.workspaceId, ownerId: "owner", revision, previousDigest, members: structuredClone(people) });
describe("signed workspace key directory transport", { skip: skipWithoutDatabase }, () => {
  before(() => connectTestDatabase("private-directory", [PrivateAccount, PrivateDirectory, PrivateWorkspace, WorkspaceMember, WorkspaceWriteFence] as never));
  beforeEach(async () => {
    await clearTestDatabase(); signing = await createSigningPair(); successor = await createSigningPair();
    people = [
      { userId: "member", role: "member", canViewOthersTime: false, canViewOthersMoney: false, publicKey: (await createKeyPair()).publicKey, signingPublicKey: successor.publicKey },
      { userId: "owner", role: "owner", canViewOthersTime: true, canViewOthersMoney: true, publicKey: (await createKeyPair()).publicKey, signingPublicKey: signing.publicKey },
    ];
    for (const member of people) {
      await WorkspaceMember.create({ workspaceId: scope.workspaceId, ...member, name: member.userId });
      await PrivateAccount.create({ userId: member.userId, identity: { publicKey: member.publicKey, signingPublicKey: member.signingPublicKey, recovery: await seal(randomSecret(), {}, "synthetic"), passkeys: [] } });
    }
  });
  after(dropTestDatabase);
  it("commits public history, retries after later revisions and independently verifies paged responses", async () => {
    const first = await signed(directory()), receipt = await commitPrivateDirectory(scope, first);
    await commitPrivateDirectory(scope, await signed(directory(2, receipt.digest)));
    assert.deepEqual(await commitPrivateDirectory(scope, first), receipt);
    const page = await privateDirectoryPage(scope.workspaceId, "member", 0);
    let trust: PrivateDirectoryTrust = { ownerId: "owner", signingPublicKey: signing.publicKey, revision: 0, digest: null };
    for (const row of page.directories) { const verified = await verifyPrivateWorkspaceDirectory(row.signed, scope, trust); assert.equal(verified.digest, row.digest); trust = verified.trust; }
    assert.equal(trust.revision, 2); assert.equal(page.through, 2); assert.equal(page.next, null);
    assert.doesNotMatch(JSON.stringify(page), /recovery|passkeys|privateKey/);
    const forged = structuredClone(first); forged.signature = "A".repeat(86);
    await assert.rejects(commitPrivateDirectory(scope, forged), { code: "FORBIDDEN" });
    const fork = directory(); fork.members[0]!.canViewOthersMoney = true;
    await assert.rejects(commitPrivateDirectory(scope, await signed(fork)), { code: "CONFLICT" });
    await assert.rejects(privateDirectoryPage(scope.workspaceId, "stranger", 0), { code: "NOT_FOUND" });
  });
  it("rejects key substitution, changed permissions, wrong scopes, missing enrollment and forged owners atomically", async () => {
    const keySwap = directory(); keySwap.members[0]!.publicKey = (await createKeyPair()).publicKey;
    await assert.rejects(commitPrivateDirectory(scope, await signed(keySwap)), { code: "CONFLICT" });
    const permissions = directory(); permissions.members[0]!.canViewOthersTime = true;
    await assert.rejects(commitPrivateDirectory(scope, await signed(permissions)), { code: "CONFLICT" });
    await assert.rejects(commitPrivateDirectory(scope, await signed({ ...directory(), server: "https://other.test" })), { code: "BAD_REQUEST" });
    await assert.rejects(commitPrivateDirectory(scope, await signed({ ...directory(), workspaceId: "another" })), { code: "BAD_REQUEST" });
    await assert.rejects(commitPrivateDirectory(scope, await signed(directory(), "owner", successor.privateKey)), { code: "FORBIDDEN" });
    await assert.rejects(commitPrivateDirectory({ ...scope, userId: "member" }, await signed(directory())), { code: "FORBIDDEN" });
    await PrivateAccount.deleteOne({ userId: "member" });
    await assert.rejects(commitPrivateDirectory(scope, await signed(directory())), { code: "PRECONDITION_FAILED" });
    assert.equal(await PrivateDirectory.countDocuments(), 0);
    assert.equal((await PrivateAccount.findOne({ userId: "owner" }).lean())!.keySerial, 0);
  });
  it("accepts a previous owner's signed transfer relayed by the new owner, never a self-signed takeover", async () => {
    const receipt = await commitPrivateDirectory(scope, await signed(directory()));
    people = people.map((p) => ({ ...p, role: p.userId === "member" ? "owner" : "member", canViewOthersTime: p.userId === "member", canViewOthersMoney: p.userId === "member" }));
    const next = { ...directory(2, receipt.digest), ownerId: "member" };
    const approval = await signed(next); // prepared by the previous owner before leaving
    for (const p of people) await WorkspaceMember.updateOne({ workspaceId: scope.workspaceId, userId: p.userId }, { $set: { role: p.role, canViewOthersTime: p.canViewOthersTime, canViewOthersMoney: p.canViewOthersMoney } });
    await assert.rejects(commitPrivateDirectory({ ...scope, userId: "member" }, await signed(next, "member", successor.privateKey)), { code: "FORBIDDEN" });
    await commitPrivateDirectory({ ...scope, userId: "member" }, approval);
    const third = { ...directory(3, (await privateDirectoryPage(scope.workspaceId, "member", 1)).directories[0]!.digest), ownerId: "member" };
    await commitPrivateDirectory({ ...scope, userId: "member" }, await signed(third, "member", successor.privateKey));
    assert.equal(await PrivateDirectory.countDocuments(), 3);
  });
  it("keeps pagination bounds, detects missing history and serializes competing revisions", async () => {
    let digest: string | null = null;
    for (let revision = 1; revision <= 11; revision++) digest = (await commitPrivateDirectory(scope, await signed(directory(revision, digest)))).digest;
    const page = await privateDirectoryPage(scope.workspaceId, "owner", 0);
    assert.equal(page.directories.length, 10); assert.equal(page.next, 10); assert.equal(page.through, 11);
    const concurrent = await signed(directory(12, digest));
    const attempts = await Promise.all([commitPrivateDirectory(scope, concurrent), commitPrivateDirectory(scope, concurrent)]);
    assert.deepEqual(attempts[0], attempts[1]);
    assert.equal(await PrivateDirectory.countDocuments(), 12);
    const last = await privateDirectoryPage(scope.workspaceId, "owner", page.next!, page.through);
    assert.equal(last.directories.length, 1); assert.equal(last.through, 11); assert.equal(last.next, null);
    await assert.rejects(privateDirectoryPage(scope.workspaceId, "owner", 0, 99), { code: "CONFLICT" });
    await PrivateDirectory.deleteOne({ revision: 11 });
    await assert.rejects(privateDirectoryPage(scope.workspaceId, "owner", 10), { code: "PRECONDITION_FAILED" });
  });
  it("holds directory changes once migration starts and keeps public preparation closed", async () => {
    const first = await signed(directory()), receipt = await commitPrivateDirectory(scope, first);
    await PrivateWorkspace.create({ workspaceId: scope.workspaceId, ownerId: "owner", state: "migrating", leaseUntil: new Date(), migrationId: crypto.randomUUID(), sourceRevision: "synthetic" });
    assert.deepEqual(await commitPrivateDirectory(scope, first), receipt);
    await assert.rejects(commitPrivateDirectory(scope, await signed(directory(2, receipt.digest))), { code: "NOT_IMPLEMENTED" });
    const caller = privacyRouter.createCaller({ user: { id: "owner" }, session: { user: { id: "owner" } } } as unknown as Context);
    await assert.rejects(caller.prepareDirectory({ workspaceId: scope.workspaceId, signed: first }), { code: "NOT_IMPLEMENTED" });
    assert.equal((await caller.directory({ workspaceId: scope.workspaceId, after: 0 })).directories.length, 1);
  });
  it("cannot strand a prepared directory through account-key replacement", async () => {
    await commitPrivateDirectory(scope, await signed(directory()));
    const caller = privacyRouter.createCaller({ user: { id: "owner" }, session: { user: { id: "owner" } } } as unknown as Context);
    const current = (await caller.identity())!;
    const replacement = { ...current.identity, publicKey: (await createKeyPair()).publicKey };
    const action = { userId: "owner", identity: replacement, revision: current.revision };
    await assert.rejects(caller.updateIdentity({ ...action, signature: await signPrivateChange(signing.privateKey, action) }), { code: "PRECONDITION_FAILED" });
    assert.deepEqual((await caller.identity())!.identity, current.identity);
    assert.equal(await PrivateDirectory.countDocuments(), 1);
  });
});
