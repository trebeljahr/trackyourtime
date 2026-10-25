import assert from "node:assert/strict";
import { it } from "node:test";
import { canonicalJson, createSigningPair, deriveSecret, randomSecret, seal, signPrivateChange } from "../privacy/crypto.js";
import { accountWorkspacePolicy, createPrivateAccountInventoryStore, PrivateAccountInventoryMissingError, signPrivateAccountInventory } from "../privacy/account-inventory.js";
import { authenticatePrivateInventoryVersion, encryptPrivateInventoryVersion, openPrivateInventoryVersion } from "../privacy/inventory-version.js";
import { memoryStorage } from "../storage.js";
const scope = { server: "https://api.example.test", userId: "owner" }, initial = { revision: 0, root: null };
async function fixture() {
  const signing = await createSigningPair(), master = randomSecret(), state = { open: true }, current = () => state.open;
  const storeOptions = { ...scope, storage: memoryStorage(), signingPublicKey: signing.publicKey, exclusive: <T>(work: () => Promise<T>) => work(), resolveStorageKey: () => ({ key: master, current }), capture: () => () => { if (!current()) throw new Error("Locked inventory"); } };
  const store = await createPrivateAccountInventoryStore(storeOptions);
  const signed = await signPrivateAccountInventory({ ...scope, workspaces: [{ workspaceId: "private-customer-id", mode: "standard" }], previous: null, signingPrivateKey: signing.privateKey, current });
  const inventory = await store.enroll(signed);
  const encrypted = await encryptPrivateInventoryVersion({ inventory, previous: initial, operationId: crypto.randomUUID(), master, signingPrivateKey: signing.privateKey, current });
  return { signing, master, state, current, store, storeOptions, signed, inventory, encrypted,
    open: (input = encrypted.signed, previous = initial as { revision: number; root: string | null }) => openPrivateInventoryVersion({ signed: input, previous, scope, master, signingPublicKey: signing.publicKey, current }),
  };
}
it("round-trips consecutive encrypted inventory versions and requires a trusted local checkpoint after delivery", async () => {
  const f = await fixture(), first = await f.open();
  const authenticated = await authenticatePrivateInventoryVersion({ signed: f.encrypted.signed, scope, previous: initial, signingPublicKey: f.signing.publicKey, current: f.current });
  assert.deepEqual(authenticated.checkpoint, f.encrypted.checkpoint); assert.equal("inventory" in authenticated, false);
  const resigned = structuredClone(f.encrypted.signed); resigned.signature = await signPrivateChange(f.signing.privateKey, { header: resigned.header, box: resigned.box });
  assert.equal((await authenticatePrivateInventoryVersion({ signed: resigned, scope, previous: initial, signingPublicKey: f.signing.publicKey, current: f.current })).checkpoint.root, authenticated.checkpoint.root);
  assert.equal(first.checkpoint.root, f.encrypted.checkpoint.root); assert.deepEqual(first.inventory, f.signed);
  assert.doesNotMatch(JSON.stringify(f.encrypted), /private-customer-id|workspaces|previousDigest|account-workspace-inventory/);
  assert.throws(() => accountWorkspacePolicy(first.inventory as never, scope, "private-customer-id"), /current verified/);
  const device = await createPrivateAccountInventoryStore({ ...f.storeOptions, storage: memoryStorage() });
  await assert.rejects(device.enroll(first.inventory), PrivateAccountInventoryMissingError);
  await device.restore(first.inventory, f.inventory.checkpoint);
  const secondSigned = await signPrivateAccountInventory({ ...scope, workspaces: [...f.signed.inventory.workspaces, { workspaceId: "new-standard", mode: "standard" }], previous: f.inventory, signingPrivateKey: f.signing.privateKey, current: f.current });
  const second = await f.store.accept(secondSigned);
  const envelope = await encryptPrivateInventoryVersion({ inventory: second, previous: f.encrypted.checkpoint, operationId: crypto.randomUUID(), master: f.master, signingPrivateKey: f.signing.privateKey, current: f.current });
  const decoded = await f.open(envelope.signed, f.encrypted.checkpoint);
  await device.accept(decoded.inventory); assert.equal((await device.read()).checkpoint.revision, 2);
  await assert.rejects(f.open(envelope.signed), /checkpoint changed/);
  await assert.rejects(f.open(f.encrypted.signed, envelope.checkpoint), /checkpoint changed/);
});
it("refuses changed scope, keys, prior roots, ciphertext and signatures before accepting any inventory", async () => {
  const f = await fixture(), other = await createSigningPair();
  await assert.rejects(openPrivateInventoryVersion({ signed: f.encrypted.signed, scope: { ...scope, server: "https://other.example.test" }, previous: initial, master: f.master, signingPublicKey: f.signing.publicKey, current: f.current }), /scope, key or checkpoint changed/);
  await assert.rejects(openPrivateInventoryVersion({ signed: f.encrypted.signed, scope, previous: initial, master: f.master, signingPublicKey: other.publicKey, current: f.current }), /scope, key or checkpoint changed/);
  await assert.rejects(openPrivateInventoryVersion({ signed: f.encrypted.signed, scope, previous: initial, master: randomSecret(), signingPublicKey: f.signing.publicKey, current: f.current }));
  const forged = structuredClone(f.encrypted.signed); forged.signature = await signPrivateChange(other.privateKey, { header: forged.header, box: forged.box });
  await assert.rejects(f.open(forged), /signature did not match/);
  const changed = structuredClone(f.encrypted.signed); changed.header.operationId = crypto.randomUUID(); changed.signature = await signPrivateChange(f.signing.privateKey, { header: changed.header, box: changed.box });
  await assert.rejects(f.open(changed)); // Authenticated header also binds AES-GCM.
  const broken = structuredClone(f.encrypted.signed); broken.box.data = (broken.box.data[0] === "A" ? "B" : "A") + broken.box.data.slice(1);
  await assert.rejects(f.open(broken), /signature did not match/);
});
it("checks the decrypted signed inventory revision and snapshots operation intent before awaiting crypto", async () => {
  const f = await fixture();
  const secondSigned = await signPrivateAccountInventory({ ...scope, workspaces: f.signed.inventory.workspaces, previous: f.inventory, signingPrivateKey: f.signing.privateKey, current: f.current });
  const key = await deriveSecret(f.master, canonicalJson({ protocol: "trackyourtime-account-inventory-encryption-v1", ...scope }));
  try {
    const header = f.encrypted.signed.header, box = await seal(key, secondSigned, canonicalJson(header));
    const signature = await signPrivateChange(f.signing.privateKey, { header, box });
    await assert.rejects(f.open({ header, box, signature }), /revision differs/);
  } finally { key.fill(0); }
  const operationId = crypto.randomUUID(), options = { inventory: f.inventory, previous: initial, operationId, master: f.master, signingPrivateKey: f.signing.privateKey, current: f.current };
  const pending = encryptPrivateInventoryVersion(options); options.operationId = crypto.randomUUID();
  assert.equal((await pending).signed.header.operationId, operationId);
});
it("refuses late encryption/delivery after locking and invalid checkpoints without changing the saved inventory", async () => {
  const f = await fixture();
  await assert.rejects(encryptPrivateInventoryVersion({ inventory: f.inventory, previous: { revision: 1, root: null }, operationId: crypto.randomUUID(), master: f.master, signingPrivateKey: f.signing.privateKey, current: f.current }), /Invalid account inventory transport checkpoint/);
  const pending = encryptPrivateInventoryVersion({ inventory: f.inventory, previous: initial, operationId: crypto.randomUUID(), master: f.master, signingPrivateKey: f.signing.privateKey, current: f.current });
  f.state.open = false; await assert.rejects(pending, /changed during inventory encryption/);
  f.state.open = true; const delivery = f.open(); f.state.open = false;
  await assert.rejects(delivery, /changed during inventory delivery/);
  f.state.open = true; assert.equal((await f.store.read()).checkpoint.revision, 1);
});
