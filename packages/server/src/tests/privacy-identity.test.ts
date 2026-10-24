import assert from "node:assert/strict";
import { before, after, beforeEach, describe, it, test } from "node:test";
import { createKeyPair, createSigningPair, encodeSecret, randomSecret, seal, signPrivateChange } from "@starter/core";
import { PrivateAccount, PrivateWorkspace } from "../models/PrivateData.js";
import { WorkspaceMember } from "../models/WorkspaceMember.js";
import { WorkspaceWriteFence } from "../models/TimesheetApproval.js";
import { env } from "../config/env.js";
import { privacyRouter } from "../trpc/routers/privacy.js";
import type { Context } from "../trpc/context.js";
import { connectTestDatabase, clearTestDatabase, dropTestDatabase, skipWithoutDatabase } from "./support/test-database.js";
const context = (id: string) => ({ user: { id }, session: { user: { id } }, activeWorkspaceId: null }) as unknown as Context;
const owner = privacyRouter.createCaller(context("owner"));
const originalOrigin = env.BETTER_AUTH_URL;
const setOrigin = (value: string) => Object.defineProperty(env, "BETTER_AUTH_URL", { value, configurable: true, writable: true, enumerable: true });
async function fixture() {
  const pair = await createKeyPair(), signing = await createSigningPair(), key = randomSecret();
  const secret = { master: encodeSecret(randomSecret()), privateKey: pair.privateKey, signingPrivateKey: signing.privateKey };
  const identity = { publicKey: pair.publicKey, signingPublicKey: signing.publicKey, recovery: await seal(key, secret, "synthetic-identity"), passkeys: [] };
  return { identity, secret, signing };
}
describe("private identity enrollment and recovery boundaries", { skip: skipWithoutDatabase }, () => {
  before(() => connectTestDatabase("private-identity", [PrivateAccount, PrivateWorkspace, WorkspaceMember, WorkspaceWriteFence] as never));
  beforeEach(async () => { await clearTestDatabase(); setOrigin("https://api.example.test"); });
  after(async () => { setOrigin(originalOrigin); await dropTestDatabase(); });
  it("accepts transport workspace context but stores only the strict, encrypted identity", async () => {
    const { identity, secret } = await fixture();
    assert.deepEqual(await owner.enroll({ identity, workspaceId: "transport-context" } as never), { revision: 1 });
    const stored = await PrivateAccount.findOne({ userId: "owner" }).lean();
    assert.ok(stored && !("d" in stored.identity.publicKey));
    assert.ok(stored && !("d" in stored.identity.signingPublicKey));
    assert.ok(!JSON.stringify(stored).includes(secret.master));
    assert.ok(!JSON.stringify(stored).includes(secret.privateKey.d!));
    assert.deepEqual(await owner.enroll({ identity }), { revision: 1 });
    assert.equal(await PrivateAccount.countDocuments(), 1);
    await assert.rejects(owner.enroll({ identity: (await fixture()).identity }), { code: "CONFLICT" });
    assert.deepEqual((await owner.identity())?.identity, identity);
    assert.equal(await privacyRouter.createCaller(context("other")).identity(), null);
  });
  it("cannot reset or replace encryption with login access alone; valid changes use compare-and-swap", async () => {
    const { identity, signing } = await fixture(); await owner.enroll({ identity });
    const next = await fixture(), replacement = next.identity;
    const action = { userId: "owner", revision: 1, identity: replacement };
    const intruder = await createSigningPair();
    await assert.rejects(owner.updateIdentity({ ...action, signature: await signPrivateChange(intruder.privateKey, action) }), { code: "FORBIDDEN" });
    assert.equal((await owner.identity())?.revision, 1);
    const signature = await signPrivateChange(signing.privateKey, action);
    assert.deepEqual(await owner.updateIdentity({ identity: replacement, revision: 1, signature }), { revision: 2 });
    const stale = { userId: "owner", revision: 1, identity: replacement };
    await assert.rejects(owner.updateIdentity({ identity: replacement, revision: 1, signature: await signPrivateChange(next.signing.privateKey, stale) }), { code: "CONFLICT" });
    assert.equal((await owner.identity())?.revision, 2);
    const crossAccount = privacyRouter.createCaller(context("other"));
    await assert.rejects(crossAccount.updateIdentity({ identity: replacement, revision: 2, signature }), { code: "NOT_FOUND" });
  });
  it("rejects plaintext private keys and unauthenticated key lookup", async () => {
    const { identity, secret } = await fixture();
    await assert.rejects(owner.enroll({ identity: { ...identity, publicKey: secret.privateKey } }));
    assert.equal(await PrivateAccount.countDocuments(), 0);
    await assert.rejects(privacyRouter.createCaller({ user: null, session: null } as unknown as Context).identity(), { code: "UNAUTHORIZED" });
  });
  it("binds enrollment to the account and API origin before storing an identity", async () => {
    const { identity } = await fixture();
    await assert.rejects(owner.enroll({ identity, userId: "other" }), { code: "NOT_FOUND" });
    await assert.rejects(owner.enroll({ identity, server: "https://unrelated.example.test" }), { code: "NOT_FOUND" });
    assert.equal(await PrivateAccount.countDocuments(), 0);
    setOrigin("");
    await assert.rejects(owner.enroll({ identity, server: "https://api.example.test" }), { code: "PRECONDITION_FAILED" });
    setOrigin("https://api.example.test");
    assert.deepEqual(await owner.enroll({ identity, userId: "owner", server: new URL(env.BETTER_AUTH_URL).origin }), { revision: 1 });
  });
  it("keeps keys needed by encrypted workspaces while allowing recovery wrapper changes", async () => {
    const { identity, signing } = await fixture(); await owner.enroll({ identity });
    await WorkspaceMember.create({ workspaceId: "encrypted-workspace", userId: "owner", role: "owner", name: "Owner" });
    await PrivateWorkspace.create({ workspaceId: "encrypted-workspace", ownerId: "owner", state: "encrypted", migrationId: crypto.randomUUID(), sourceRevision: "synthetic", leaseUntil: new Date() });
    const replacement = (await fixture()).identity;
    const action = { userId: "owner", revision: 1, identity: replacement };
    await assert.rejects(owner.updateIdentity({ ...action, signature: await signPrivateChange(signing.privateKey, action) }), { code: "PRECONDITION_FAILED" });
    const wrapped = { ...identity, recovery: replacement.recovery };
    const recoveryAction = { userId: "owner", revision: 1, identity: wrapped };
    assert.deepEqual(await owner.updateIdentity({ ...recoveryAction, signature: await signPrivateChange(signing.privateKey, recoveryAction) }), { revision: 2 });
    assert.deepEqual((await owner.identity())?.identity.publicKey, identity.publicKey);
    assert.deepEqual((await owner.identity())?.identity.recovery, replacement.recovery);
  });
});


test("account deletion preview refuses another account before reading metadata", async () => {
  const caller = privacyRouter.createCaller({ user: { id: "owner" }, session: { user: { id: "owner" } } } as unknown as Context);
  await assert.rejects(caller.deletionPreview({ userId: "someone-else" }), { code: "NOT_FOUND" });
});
