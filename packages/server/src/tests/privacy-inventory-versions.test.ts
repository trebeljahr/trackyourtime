import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { createKeyPair, createSigningPair, createPrivateAccountInventoryStore, encryptPrivateInventoryVersion, encodeSecret, memoryStorage, openPrivateInventoryVersion, randomSecret, seal, signPrivateAccountInventory, signPrivateChange, type PrivateAccountWorkspace, type VerifiedPrivateAccountInventory } from "@starter/core";
import { PrivateAccount } from "../models/PrivateData.js";
import { PrivateAccountErasureFence } from "../models/PrivateAccountErasureFence.js";
import { PrivateInventoryVersion } from "../models/PrivateInventoryVersion.js";
import { beginPrivateAccountErasure } from "../services/privacy/account-erasure-fence.js";
import { commitPrivateInventoryVersion, privateInventoryVersions, PRIVATE_INVENTORY_HISTORY_MAX_BYTES } from "../services/privacy/inventory-versions.js";
import { mongooseRowStore } from "../services/account-deletion/stores.js";
import { privacyRouter } from "../trpc/routers/privacy.js";
import type { Context } from "../trpc/context.js";
import { env } from "../config/env.js";
import { connectTestDatabase, clearTestDatabase, dropTestDatabase, skipWithoutDatabase } from "./support/test-database.js";
const scope = { server: "https://api.example.test", userId: "owner" };
const originalOrigin = env.BETTER_AUTH_URL;
const setOrigin = (value: string) => Object.defineProperty(env, "BETTER_AUTH_URL", { value, configurable: true, writable: true, enumerable: true });
async function fixture(userId = "owner") {
  const keys = await createKeyPair(), signing = await createSigningPair(), master = randomSecret(), ownScope = { ...scope, userId };
  const identity = { publicKey: keys.publicKey, signingPublicKey: signing.publicKey, recovery: await seal(randomSecret(), { master: encodeSecret(master), privateKey: keys.privateKey, signingPrivateKey: signing.privateKey }, "synthetic-identity"), passkeys: [] };
  await PrivateAccount.create({ userId, identity });
  const store = await createPrivateAccountInventoryStore({ ...ownScope, storage: memoryStorage(), signingPublicKey: signing.publicKey, exclusive: (work) => work(), resolveStorageKey: () => ({ key: master, current: () => true }), capture: () => () => {} });
  let inventory: VerifiedPrivateAccountInventory | null = null, previous = { revision: 0, root: null as string | null };
  const versions = [] as Awaited<ReturnType<typeof encryptPrivateInventoryVersion>>[];
  const next = async (operationId = crypto.randomUUID()) => {
    const workspaces: PrivateAccountWorkspace[] = [{ workspaceId: `${userId}-confidential-workspace`, mode: "standard" }, ...Array.from({ length: versions.length }, (_, index) => ({ workspaceId: `added-${index}`, mode: "standard" as const }))];
    const signed = await signPrivateAccountInventory({ ...ownScope, workspaces, previous: inventory, signingPrivateKey: signing.privateKey, current: () => true });
    inventory = inventory ? await store.accept(signed) : await store.enroll(signed);
    const version = await encryptPrivateInventoryVersion({ inventory, previous, operationId, master, signingPrivateKey: signing.privateKey, current: () => true });
    versions.push(version); previous = version.checkpoint; return version;
  };
  return { scope: ownScope, identity, keys, signing, master, store, next, versions };
}
describe("blind account inventory persistence", { skip: skipWithoutDatabase }, () => {
  before(() => connectTestDatabase("privacy-inventory-versions", [PrivateAccount, PrivateInventoryVersion, PrivateAccountErasureFence] as never));
  beforeEach(async () => { await clearTestDatabase(); setOrigin(scope.server); });
  after(async () => { setOrigin(originalOrigin); await dropTestDatabase(); });
  it("exposes authenticated no-store ciphertext endpoints and binds every write to the actual account", async () => {
    const f = await fixture(), first = await f.next(); await fixture("other");
    const headers = new Map<string, unknown>();
    const context = (userId: string) => ({ user: { id: userId }, session: { user: { id: userId } }, res: { headersSent: false, setHeader: (name: string, value: unknown) => headers.set(name, value) } }) as unknown as Context;
    const rpc = privacyRouter.createCaller(context("owner")), other = privacyRouter.createCaller(context("other"));
    assert.deepEqual(await rpc.inventoryWrite({ signed: first.signed }), first.checkpoint);
    const page = await rpc.inventoryVersions({ after: 0 });
    assert.equal(page.versions.length, 1); assert.equal(headers.get("Cache-Control"), "no-store");
    assert.doesNotMatch(JSON.stringify(page), /identity|publicKey|recovery|"master"|confidential-workspace/);
    assert.deepEqual(await other.inventoryVersions({ after: 0 }), { through: 0, root: null, next: null, versions: [] });
    await assert.rejects(other.inventoryWrite({ signed: first.signed }), { code: "NOT_FOUND" });
    await assert.rejects(rpc.inventoryWrite({ signed: { ...first.signed, privateKey: f.signing.privateKey } } as never), { code: "BAD_REQUEST" });
    await assert.rejects(privacyRouter.createCaller({ user: null, session: null } as unknown as Context).inventoryVersions({ after: 0 }), { code: "UNAUTHORIZED" });
  });
  it("preserves the first ciphertext/signature across lost responses and retries after later revisions", async () => {
    const f = await fixture(), first = await f.next();
    assert.deepEqual(await commitPrivateInventoryVersion(scope, first.signed), first.checkpoint);
    const stored = JSON.stringify(await PrivateInventoryVersion.find().lean()), second = await f.next();
    await commitPrivateInventoryVersion(scope, second.signed);
    assert.deepEqual(await commitPrivateInventoryVersion(scope, first.signed), first.checkpoint);
    const resigned = structuredClone(first.signed); resigned.signature = await signPrivateChange(f.signing.privateKey, { header: resigned.header, box: resigned.box });
    assert.deepEqual(await commitPrivateInventoryVersion(scope, resigned), first.checkpoint);
    assert.equal(JSON.stringify(await PrivateInventoryVersion.find({ revision: 1 }).lean()), stored);
    assert.equal(await PrivateInventoryVersion.countDocuments(), 2);
    const account = (await PrivateAccount.findOne().lean())!;
    assert.equal(account.revision, 1); assert.equal(account.inventoryRevision, 2); assert.equal(account.inventoryRoot, second.checkpoint.root);
    assert.doesNotMatch(JSON.stringify(await PrivateInventoryVersion.find().lean()), /confidential-workspace|workspaces|signingPrivateKey|"master"/);
    assert.equal(JSON.stringify(await PrivateInventoryVersion.find().lean()).includes(encodeSecret(f.master)), false);
    await PrivateInventoryVersion.updateOne({ revision: 1 }, { $set: { "signed.signature": "A".repeat(86) } });
    await assert.rejects(commitPrivateInventoryVersion(scope, first.signed), /incomplete or inconsistent/);
  });
  it("pins bounded page boundaries while newer versions arrive and delivers a fully authenticated consecutive chain", async () => {
    const f = await fixture();
    for (let index = 0; index < 6; index++) await commitPrivateInventoryVersion(scope, (await f.next()).signed);
    const page = await privateInventoryVersions(scope, 0); assert.equal(page.versions.length, 4); assert.equal(page.next, 4); assert.equal(page.through, 6);
    await commitPrivateInventoryVersion(scope, (await f.next()).signed);
    const end = await privateInventoryVersions(scope, page.next!, page.through); assert.equal(end.versions.length, 2); assert.equal(end.next, null); assert.equal(end.root, page.root);
    let previous = { revision: 0, root: null as string | null };
    for (const signed of [...page.versions, ...end.versions]) {
      const opened = await openPrivateInventoryVersion({ signed, previous, scope, master: f.master, signingPublicKey: f.signing.publicKey, current: () => true });
      assert.equal(opened.inventory.inventory.revision, previous.revision + 1); previous = opened.checkpoint;
    }
    assert.equal(previous.root, page.root);
    assert.equal((await privateInventoryVersions(scope, 6)).versions[0]!.header.revision, 7);
    await assert.rejects(privateInventoryVersions(scope, 8), { code: "CONFLICT" });
  });
  it("serializes competing commits, isolates accounts and refuses forged signatures or operation-ID replacement", async () => {
    const f = await fixture(), other = await fixture("other"), first = await f.next();
    const profile = await f.store.read();
    const competing = await encryptPrivateInventoryVersion({ inventory: profile, previous: { revision: 0, root: null }, operationId: crypto.randomUUID(), master: f.master, signingPrivateKey: f.signing.privateKey, current: () => true });
    const results = await Promise.allSettled([commitPrivateInventoryVersion(scope, first.signed), commitPrivateInventoryVersion(scope, competing.signed)]);
    assert.equal(results.filter((row) => row.status === "fulfilled").length, 1); assert.equal(await PrivateInventoryVersion.countDocuments(), 1);
    await assert.rejects(commitPrivateInventoryVersion(other.scope, first.signed), { code: "NOT_FOUND" });
    assert.deepEqual(await privateInventoryVersions(other.scope, 0), { through: 0, root: null, next: null, versions: [] });
    const winner = (await PrivateInventoryVersion.findOne().lean())!;
    const replaced = structuredClone(winner.signed); replaced.box.nonce = "A".repeat(16); replaced.signature = await signPrivateChange(f.signing.privateKey, { header: replaced.header, box: replaced.box });
    await assert.rejects(commitPrivateInventoryVersion(scope, replaced), { code: "CONFLICT" });
    const forged = structuredClone(winner.signed); forged.signature = await signPrivateChange(other.signing.privateKey, { header: forged.header, box: forged.box });
    await assert.rejects(commitPrivateInventoryVersion(scope, forged), { code: "FORBIDDEN" });
    assert.equal(await PrivateInventoryVersion.countDocuments(), 1);
  });
  it("retrofits legacy key rows without new metadata, and rolls a failed head update back with its ciphertext", async () => {
    const f = await fixture(), first = await f.next();
    await PrivateAccount.collection.updateOne({ userId: "owner" }, { $unset: { inventoryRevision: "", inventoryRoot: "", inventoryBytes: "" } });
    const failure = mock.method(PrivateAccount, "updateOne", async () => { throw new Error("Injected head acknowledgement failure"); });
    try { await assert.rejects(commitPrivateInventoryVersion(scope, first.signed), /Injected head/); } finally { failure.mock.restore(); }
    assert.equal(await PrivateInventoryVersion.countDocuments(), 0);
    assert.equal((await PrivateAccount.findOne().lean())!.inventoryRevision, undefined);
    assert.deepEqual(await commitPrivateInventoryVersion(scope, first.signed), first.checkpoint);
    const account = (await PrivateAccount.findOne().lean())!; assert.equal(account.inventoryRevision, 1); assert.ok(account.inventoryBytes >= 4096);
  });
  it("refuses exhausted metadata budgets and inconsistent history without changing the prior checkpoint", async () => {
    const f = await fixture(), first = await f.next(); await commitPrivateInventoryVersion(scope, first.signed);
    await PrivateInventoryVersion.updateOne({ userId: "owner" }, { $set: { bytes: PRIVATE_INVENTORY_HISTORY_MAX_BYTES } });
    await PrivateAccount.updateOne({ userId: "owner" }, { $set: { inventoryBytes: PRIVATE_INVENTORY_HISTORY_MAX_BYTES } });
    await assert.rejects(commitPrivateInventoryVersion(scope, (await f.next()).signed), /metadata budget/);
    assert.equal(await PrivateInventoryVersion.countDocuments(), 1); assert.equal((await PrivateAccount.findOne().lean())!.inventoryRoot, first.checkpoint.root);
    await PrivateInventoryVersion.deleteMany({ userId: "owner" });
    await assert.rejects(privateInventoryVersions(scope, 0), /incomplete or inconsistent/);
    await assert.rejects(commitPrivateInventoryVersion(scope, first.signed), /incomplete or inconsistent/);
  });
  it("protects encrypted history during key rotation/re-enrollment and removes it on account erasure", async () => {
    const f = await fixture(), first = await f.next(); await commitPrivateInventoryVersion(scope, first.signed);
    const caller = privacyRouter.createCaller({ user: { id: "owner" }, session: { user: { id: "owner" } } } as unknown as Context);
    const replacement = { ...f.identity, signingPublicKey: (await createSigningPair()).publicKey };
    const action = { userId: "owner", revision: 1, identity: replacement };
    await assert.rejects(caller.updateIdentity({ ...action, signature: await signPrivateChange(f.signing.privateKey, action) }), /verified key transition/);
    await mongooseRowStore.deleteMany("privateAccounts", { userId: "owner" });
    await assert.rejects(caller.enroll({ identity: f.identity }), /needs recovery/);
    assert.equal(await PrivateInventoryVersion.countDocuments(), 1);
    await beginPrivateAccountErasure("owner");
    assert.equal(await mongooseRowStore.deleteMany("privateInventoryVersions", { userId: "owner" }), 1);
    await assert.rejects(commitPrivateInventoryVersion(scope, first.signed), /Account erasure has started/);
    assert.equal(await PrivateInventoryVersion.countDocuments(), 0);
  });
});
