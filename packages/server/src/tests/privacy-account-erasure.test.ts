import assert from "node:assert/strict";
import { before, beforeEach, after, describe, it } from "node:test";
import { createKeyPair, createSigningPair, randomSecret, seal, signPrivateChange } from "@starter/core";
import { PrivateAccount, PrivateDeviceRequest } from "../models/PrivateData.js";
import { PrivateAccountErasureFence } from "../models/PrivateAccountErasureFence.js";
import { beginPrivateAccountErasure, fencePrivateAccount } from "../services/privacy/account-erasure-fence.js";
import { createPrivateDeviceRequest } from "../services/privacy/devices.js";
import { mongooseRowStore } from "../services/account-deletion/stores.js";
import { withBusinessTransaction } from "../services/business-transaction.js";
import { privacyRouter } from "../trpc/routers/privacy.js";
import type { Context } from "../trpc/context.js";
import { connectTestDatabase, clearTestDatabase, dropTestDatabase, skipWithoutDatabase } from "./support/test-database.js";
const caller = (id: string) => privacyRouter.createCaller({ user: { id }, session: { user: { id } } } as unknown as Context);
const erased = { code: "PRECONDITION_FAILED", message: "Account erasure has started. Private writes are refused." };
async function fixture() {
  const pair = await createKeyPair(), signing = await createSigningPair();
  return { identity: { publicKey: pair.publicKey, signingPublicKey: signing.publicKey, recovery: await seal(randomSecret(), { master: "Disposable account root" }, "synthetic"), passkeys: [] }, signing };
}
describe("private account erasure write barrier", { skip: skipWithoutDatabase }, () => {
  before(() => connectTestDatabase("privacy-account-erasure", [PrivateAccount, PrivateDeviceRequest, PrivateAccountErasureFence] as never));
  beforeEach(clearTestDatabase); after(dropTestDatabase);
  it("refuses already-authenticated delayed enrollment and device requests after keys are erased, without blocking another account", async () => {
    const stale = caller("owner"), other = caller("colleague"), f = await fixture();
    await stale.enroll({ identity: f.identity }); await other.enroll({ identity: (await fixture()).identity });
    await beginPrivateAccountErasure("owner");
    assert.equal(await mongooseRowStore.deleteMany("privateAccounts", { userId: "owner" }), 1);
    await assert.rejects(stale.enroll({ identity: f.identity }), erased);
    await assert.rejects(stale.createDeviceUnlock({ requestId: crypto.randomUUID(), publicKey: f.identity.publicKey }), erased);
    await assert.rejects(createPrivateDeviceRequest("owner", crypto.randomUUID(), f.identity.publicKey), erased);
    assert.equal(await PrivateAccount.countDocuments({ userId: "owner" }), 0); assert.equal(await PrivateDeviceRequest.countDocuments(), 0);
    assert.deepEqual(await other.enroll({ identity: (await PrivateAccount.findOne({ userId: "colleague" }).lean())!.identity }), { revision: 1 });
    const marker = (await PrivateAccountErasureFence.findOne({ erased: true }).lean())!;
    assert.match(marker._id, /^[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys(marker).sort(), ["_id", "erased", "serial"]);
    assert.doesNotMatch(JSON.stringify(marker), /owner|colleague|publicKey|recovery|Disposable/);
  });
  it("retries an old transaction snapshot against the erased marker and never recreates root keys", async () => {
    const f = await fixture(); await caller("owner").enroll({ identity: f.identity });
    await mongooseRowStore.deleteMany("privateAccounts", { userId: "owner" });
    let enter!: () => void, release!: () => void, attempts = 0;
    const ready = new Promise<void>((resolve) => { enter = resolve; }), wait = new Promise<void>((resolve) => { release = resolve; });
    const pending = withBusinessTransaction(async () => {
      attempts++; await PrivateAccountErasureFence.findOne({ erased: false }).lean();
      if (attempts === 1) { enter(); await wait; }
      await fencePrivateAccount("owner");
      await PrivateAccount.create({ userId: "owner", identity: f.identity });
    });
    await ready;
    try { await beginPrivateAccountErasure("owner"); } finally { release(); }
    await assert.rejects(pending, erased);
    assert.ok(attempts >= 2); assert.equal(await PrivateAccount.countDocuments(), 0);
  });
  it("holds the account fence until a key writer commits, so the erasure marker orders cleanup after it", async () => {
    const f = await fixture();
    let enter!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => { enter = resolve; }), wait = new Promise<void>((resolve) => { release = resolve; });
    const writer = withBusinessTransaction(async () => { await fencePrivateAccount("owner"); enter(); await wait; await PrivateAccount.create({ userId: "owner", identity: f.identity }); });
    await ready; const deletion = beginPrivateAccountErasure("owner"); release();
    await writer; await deletion;
    assert.equal(await PrivateAccount.countDocuments(), 1);
    await mongooseRowStore.deleteMany("privateAccounts", { userId: "owner" });
    await assert.rejects(caller("owner").enroll({ identity: f.identity }), erased);
    assert.equal(await PrivateAccount.countDocuments(), 0);
  });
  it("rolls failed private mutations back and never resets an existing erasure marker on retry", async () => {
    const f = await fixture(), owner = caller("owner");
    await assert.rejects(owner.enroll({ identity: f.identity, userId: "other" }), { code: "NOT_FOUND" });
    assert.equal(await PrivateAccountErasureFence.countDocuments(), 0);
    await owner.enroll({ identity: f.identity });
    const marker = (await PrivateAccountErasureFence.findOne().lean())!;
    const action = { userId: "owner", revision: 1, identity: f.identity };
    await assert.rejects(owner.updateIdentity({ ...action, signature: await signPrivateChange((await createSigningPair()).privateKey, action) }), { code: "FORBIDDEN" });
    assert.equal((await PrivateAccountErasureFence.findById(marker._id).lean())!.serial, marker.serial);
    await beginPrivateAccountErasure("owner"); await beginPrivateAccountErasure("owner");
    await assert.rejects(owner.enroll({ identity: f.identity }), erased);
    assert.equal((await PrivateAccountErasureFence.findById(marker._id).lean())!.erased, true);
    await assert.rejects(fencePrivateAccount("owner"), /require MongoDB transactions/);
  });
});
