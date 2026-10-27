import assert from "node:assert/strict";
import { it } from "node:test";
import { type SignedPrivateInventoryVersion } from "@starter/shared";
import { canonicalJson, createSigningPair, deriveSecret, randomSecret, seal, signPrivateChange } from "../privacy/crypto.js";
import { accountWorkspacePolicy, PRIVATE_ACCOUNT_INVENTORY_SCOPE, PrivateAccountInventoryMissingError, signPrivateAccountInventory, type PrivateAccountWorkspace } from "../privacy/account-inventory.js";
import { authenticatePrivateInventoryVersion } from "../privacy/inventory-version.js";
import { createPrivateAccountInventorySync, PrivateInventoryConflictError, type PrivateInventoryTransport } from "../privacy/inventory-sync.js";
import { createPrivateStorage, PrivateStorageLockedError } from "../privacy/storage.js";
import type { KeyValueStorage } from "../storage.js";
import { privateRecordDigest } from "../privacy/workspace-edits.js";
const scope = { server: "https://api.example.test", userId: "owner" };
const rows: PrivateAccountWorkspace[] = [{ workspaceId: "secret-workspace", mode: "standard" }];
async function fixture() {
  const signing = await createSigningPair(), master = randomSecret(), files = new Map<string, string>();
  const state = { open: true, generation: 0, writeFault: "" }, released: Uint8Array[] = [];
  let lock = Promise.resolve();
  const exclusive = <T>(work: () => Promise<T>) => {
    const result = lock.then(work); lock = result.then(() => {}, () => {}); return result;
  };
  const capture = () => {
    const at = state.generation;
    return () => { if (!state.open || state.generation !== at) throw new PrivateStorageLockedError(); };
  };
  const current = () => state.open;
  const storage: KeyValueStorage = {
    getItem: async (name) => files.get(name) ?? null,
    setItem: async (name, value) => {
      if (state.writeFault && !name.endsWith("manifest")) {
        if (state.writeFault === "throw") throw new Error("Disk full");
        if (state.writeFault === "drop") return;
      }
      files.set(name, value);
    },
    removeItem: async (name) => { files.delete(name); },
  };
  const options = { ...scope, storage, exclusive, capture,
    resolveStorageKey: () => state.open ? { key: master, current } : null,
    resolveIdentity: () => {
      if (!state.open) return null;
      const check = capture(), key = new Uint8Array(master);
      return { master: key, signingPrivateKey: signing.privateKey, signingPublicKey: signing.publicKey,
        current: () => { try { check(); return true; } catch { return false; } }, release: () => { key.fill(0); released.push(key); } };
    },
  };
  const create = () => createPrivateAccountInventorySync(options);
  const sync = await create(), signed = await signPrivateAccountInventory({ ...scope, workspaces: rows, previous: null, signingPrivateKey: signing.privateKey, current });
  const versions: SignedPrivateInventoryVersion[] = [], requests: SignedPrivateInventoryVersion[] = [];
  let head = { revision: 0, root: null as string | null };
  const transport: PrivateInventoryTransport = {
    commit: async (input) => {
      requests.push(structuredClone(input));
      const prior = versions.findIndex((v) => v.header.operationId === input.header.operationId);
      if (prior >= 0) {
        const first = versions[prior]!;
        assert.equal(canonicalJson({ header: first.header, box: first.box }), canonicalJson({ header: input.header, box: input.box }));
        return { revision: prior + 1, root: (await authenticatePrivateInventoryVersion({ signed: first, scope, previous: { revision: prior, root: first.header.previousRoot }, signingPublicKey: signing.publicKey, current })).checkpoint.root! };
      }
      const checked = await authenticatePrivateInventoryVersion({ signed: input, scope, previous: head, signingPublicKey: signing.publicKey, current });
      versions.push(structuredClone(input)); head = checked.checkpoint;
      return { revision: head.revision, root: head.root! };
    },
    versions: async ({ after, through = head.revision }) => {
      assert.ok(after <= through && through <= head.revision);
      const page = versions.slice(after, Math.min(through, after + 4));
      const root = through === 0 ? null : (await authenticatePrivateInventoryVersion({ signed: versions[through - 1]!, scope, previous: { revision: through - 1, root: versions[through - 1]!.header.previousRoot }, signingPublicKey: signing.publicKey, current })).checkpoint.root;
      return { through, root, next: after + page.length < through ? after + page.length : null, versions: structuredClone(page) };
    },
  };
  const enroll = () => sync.enroll(signed);
  const peer = async () => {
    const deviceFiles = new Map<string, string>(), device = await createPrivateAccountInventorySync({ ...options, storage: {
      getItem: async (name) => deviceFiles.get(name) ?? null,
      setItem: async (name, value) => { deviceFiles.set(name, value); },
      removeItem: async (name) => { deviceFiles.delete(name); },
    } });
    const local = await sync.read();
    await device.restore(versions.at(-1), { inventory: local.inventory.checkpoint, transport: local.checkpoint });
    return device;
  };
  return { sync, create, enroll, signed, options, files, state, master, signing, transport, versions, requests, released, peer };
}
it("publishes encrypted intent before sending and reopens exact pending versions after restart", async () => {
  const f = await fixture();
  await assert.rejects(f.sync.read(), PrivateAccountInventoryMissingError);
  await assert.rejects(f.sync.enroll(structuredClone(f.signed)), PrivateAccountInventoryMissingError);
  await f.enroll(); await f.enroll();
  const first = await f.sync.exportPending();
  await f.sync.update([...rows, { workspaceId: "new-secret", mode: "standard" }]);
  assert.equal(f.requests.length, 0);
  for (const raw of f.files.values()) assert.doesNotMatch(raw, /secret-workspace|new-secret|signingPrivateKey|workspaces|"d":/);
  const restarted = await f.create();
  assert.equal((await restarted.read()).inventory.checkpoint.revision, 2);
  assert.deepEqual((await restarted.exportPending()).pending[0], first.pending[0]);
  assert.equal((await restarted.flushOne(f.transport)).pending, 1);
  assert.equal((await restarted.read()).inventory.checkpoint.revision, 2);
  assert.equal((await restarted.flushOne(f.transport)).pending, 0);
  assert.equal((await restarted.status()).checkpoint.revision, 2);
  assert.equal(f.versions.length, 2);
  assert.ok(f.released.length && f.released.every((key) => key.every((byte) => byte === 0)));
  assert.ok(f.master.some((byte) => byte !== 0));
});
it("reserves independent new standard workspace ids atomically and preserves them across reopening", async () => {
  const f = await fixture(); await f.enroll();
  const [first, second] = await Promise.all([f.sync.prepareStandardWorkspace(), f.sync.prepareStandardWorkspace()]);
  assert.match(first.workspaceId, /^[0-9a-f-]{36}$/); assert.notEqual(first.workspaceId, second.workspaceId);
  const reopened = await f.create(), profile = await reopened.read();
  assert.equal(profile.pending, 3); assert.equal(profile.inventory.signed.inventory.revision, 3);
  for (const id of ["secret-workspace", first.workspaceId, second.workspaceId]) assert.equal(accountWorkspacePolicy(profile.inventory, scope, id).mode, "standard");
  assert.equal(f.requests.length, 0);
});
it("does not acknowledge a new standard workspace when its durable inventory write fails", async () => {
  const f = await fixture(); await f.enroll(); const before = await f.sync.exportRecovery(); f.state.writeFault = "drop";
  await assert.rejects(f.sync.prepareStandardWorkspace()); f.state.writeFault = "";
  assert.deepEqual(await f.sync.exportRecovery(), before); assert.equal(f.requests.length, 0);
});
it("retries the same envelope after a lost commit response without duplicating a revision", async () => {
  const f = await fixture(); await f.enroll();
  await assert.rejects(f.sync.flushOne({ ...f.transport, commit: async (signed) => { await f.transport.commit(signed); throw new Error("Reply lost"); } }), /Reply lost/);
  assert.equal((await f.sync.status()).pending, 1);
  const restarted = await f.create();
  await restarted.flushOne(f.transport);
  assert.deepEqual(f.requests[0], f.requests[1]); assert.equal(f.versions.length, 1);
  assert.equal((await restarted.status()).pending, 0);
});
it("keeps pending versions on a false acknowledgement, missing feed or invalid page boundary", async () => {
  const f = await fixture(); await f.enroll(); const saved = await f.sync.exportPending();
  await assert.rejects(f.sync.flushOne({ ...f.transport, commit: async () => ({ revision: 1, root: "A".repeat(43) }) }), /acknowledgement/);
  await assert.rejects(f.sync.flushOne({ ...f.transport, versions: async () => ({ through: 1, root: "A".repeat(43), next: 0, versions: [] }) }), /omitted revisions/);
  await assert.rejects(f.sync.pull({ ...f.transport, versions: async () => ({ through: 1, root: "A".repeat(43), next: null, versions: f.versions }) }), /changed its root/);
  assert.deepEqual(await f.sync.exportPending(), saved); assert.equal((await f.sync.status()).checkpoint.revision, 0);
  await f.sync.flushOne(f.transport); assert.equal((await f.sync.status()).pending, 0);
});
it("isolates submitted payloads from transport mutation", async () => {
  const f = await fixture(); await f.enroll(); const saved = await f.sync.exportPending();
  await assert.rejects(f.sync.flushOne({ ...f.transport, commit: async (input) => { input.box.data = "broken"; input.header.operationId = crypto.randomUUID(); throw new Error("Network failed"); } }), /Network failed/);
  assert.deepEqual(await f.sync.exportPending(), saved);
  await f.sync.flushOne(f.transport);
});
it("preserves the last verified local state when staging fails", async () => {
  const f = await fixture(); await f.enroll(); const before = await f.sync.exportPending();
  for (const fault of ["drop", "throw"]) {
    f.state.writeFault = fault;
    await assert.rejects(f.sync.update([...rows, { workspaceId: "unsaved", mode: "standard" }]));
    f.state.writeFault = "";
    const reopened = await f.create(); assert.deepEqual(await reopened.exportPending(), before);
    assert.equal((await reopened.read()).inventory.checkpoint.revision, 1);
  }
  assert.equal(f.requests.length, 0);
  await f.sync.update(rows); assert.equal((await f.sync.status()).pending, 2);
});
it("retains the exact request when local checkpoint publication fails after the server committed", async () => {
  const f = await fixture(); await f.enroll(); const saved = await f.sync.exportPending();
  await assert.rejects(f.sync.flushOne({ ...f.transport, commit: async (signed) => {
    const ack = await f.transport.commit(signed); f.state.writeFault = "throw"; return ack;
  } }), /Disk full/);
  f.state.writeFault = "";
  const reopened = await f.create(); assert.deepEqual(await reopened.exportPending(), saved);
  assert.equal((await reopened.status()).checkpoint.revision, 0);
  await reopened.flushOne(f.transport);
  assert.deepEqual(f.requests[0], f.requests[1]); assert.equal(f.versions.length, 1);
});
it("accepts consecutive remote updates but quarantines a competing device without losing local intent", async () => {
  const f = await fixture(); await f.enroll(); await f.sync.flushOne(f.transport);
  const peer = await f.peer();
  await peer.update([...rows, { workspaceId: "remote", mode: "standard" }]); await peer.flushOne(f.transport);
  await f.sync.pull(f.transport);
  assert.equal(accountWorkspacePolicy((await f.sync.read()).inventory, scope, "remote").mode, "standard");
  await f.sync.update([...rows, { workspaceId: "local-unsent", mode: "standard" }]);
  const pending = (await f.sync.exportPending()).pending;
  await peer.update([...rows, { workspaceId: "remote-again", mode: "standard" }]); await peer.flushOne(f.transport);
  await assert.rejects(f.sync.pull(f.transport), PrivateInventoryConflictError);
  const restarted = await f.create();
  assert.deepEqual((await restarted.exportPending()).pending, pending);
  assert.deepEqual((await restarted.exportPending()).conflict, f.versions.at(-1));
  assert.deepEqual(await restarted.status(), { checkpoint: { revision: 2, root: f.versions[2]!.header.previousRoot }, pending: 1, conflict: true });
  await assert.rejects(restarted.read(), PrivateInventoryConflictError);
  await assert.rejects(restarted.update(rows), PrivateInventoryConflictError);
  await assert.rejects(restarted.flushOne(f.transport), PrivateInventoryConflictError);
});
it("restores only an exact independent checkpoint and refuses replacement of pending work", async () => {
  const f = await fixture(); await f.enroll();
  await assert.rejects(f.peer()); // No server version or trusted confirmed checkpoint yet.
  await f.sync.flushOne(f.transport);
  const local = await f.sync.read(), peer = await f.peer();
  await peer.restore(f.versions[0], { inventory: local.inventory.checkpoint, transport: local.checkpoint });
  await assert.rejects(peer.restore(f.versions[0], { inventory: { ...local.inventory.checkpoint, digest: "A".repeat(43) }, transport: local.checkpoint }), /trusted recovery checkpoint/);
  await assert.rejects(peer.restore(f.versions[0], { inventory: local.inventory.checkpoint, transport: { revision: 1, root: "A".repeat(43) } }), /trusted transport checkpoint/);
  await peer.update(rows);
  await assert.rejects(peer.restore(f.versions[0], { inventory: local.inventory.checkpoint, transport: local.checkpoint }), /pending work/);
});
it("invalidates in-flight and queued operations across lock/unlock while preserving pending work", async () => {
  const f = await fixture(); const enrolled = await f.enroll();
  await assert.rejects(f.sync.flushOne({ ...f.transport, commit: async (signed) => {
    const ack = await f.transport.commit(signed); f.state.open = false; f.state.generation++; return ack;
  } }), PrivateStorageLockedError);
  assert.throws(() => accountWorkspacePolicy(enrolled.inventory, scope, "secret-workspace"), /current verified/);
  f.state.open = true;
  assert.equal((await f.sync.status()).pending, 1);
  let resume!: () => void;
  const blocked = f.options.exclusive(() => new Promise<void>((resolve) => { resume = resolve; }));
  await Promise.resolve();
  const late = f.sync.update(rows); f.state.generation++; resume();
  await blocked; await assert.rejects(late, PrivateStorageLockedError);
  assert.equal((await f.sync.status()).pending, 1);
  await f.sync.flushOne(f.transport); assert.equal((await f.sync.status()).pending, 0);
});
it("bounds the outbox without truncating and snapshots queued input before crypto or lock waits", async () => {
  const f = await fixture(); await f.enroll();
  const input: PrivateAccountWorkspace[] = [...rows, { workspaceId: "original-intent", mode: "standard" }];
  const pending = f.sync.update(input); input[1]!.workspaceId = "mutated-intent"; await pending;
  assert.equal(accountWorkspacePolicy((await f.sync.read()).inventory, scope, "original-intent").mode, "standard");
  for (let index = 2; index < 8; index++) await f.sync.update(rows);
  const saved = await f.sync.exportPending();
  await assert.rejects(f.sync.update(rows), /queue is full/);
  assert.deepEqual(await f.sync.exportPending(), saved);
  for (let index = 0; index < 8; index++) await f.sync.flushOne(f.transport);
  assert.equal((await f.sync.status()).pending, 0);
});
it("refuses to overwrite or auto-import an existing local-only inventory", async () => {
  const f = await fixture(), encrypted = await createPrivateStorage({ storage: f.options.storage, scope: { ...scope, workspaceId: PRIVATE_ACCOUNT_INVENTORY_SCOPE }, resolveKey: f.options.resolveStorageKey });
  await encrypted.setItem("signed-account-inventory", JSON.stringify(f.signed));
  await assert.rejects(f.enroll(), /local account inventory already exists/);
  await assert.rejects(f.sync.status(), /local account inventory already exists/);
  assert.equal(await encrypted.getItem("signed-account-inventory"), JSON.stringify(f.signed));
});
it("keeps a verified page prefix when a later remote revision conflicts with pending intent", async () => {
  const f = await fixture(); await f.enroll(); await f.sync.flushOne(f.transport);
  const peer = await f.peer(); await f.sync.update(rows);
  const own = (await f.sync.exportPending()).pending[0]!;
  await f.transport.commit(own);
  // The peer follows this exact acknowledged envelope, then writes its update.
  await peer.pull(f.transport); await peer.update(rows); await peer.flushOne(f.transport);
  await f.sync.update([...rows, { workspaceId: "keep-this-intent", mode: "standard" }]);
  const tail = (await f.sync.exportPending()).pending[1]!;
  await assert.rejects(f.sync.pull(f.transport), PrivateInventoryConflictError);
  const reopened = await f.create();
  assert.equal((await reopened.status()).checkpoint.revision, 2);
  assert.deepEqual((await reopened.exportPending()).pending, [tail]);
  assert.deepEqual((await reopened.exportPending()).conflict, f.versions[2]);
});
it("pins paged downloads while newer remote revisions arrive", async () => {
  const f = await fixture(); await f.enroll(); await f.sync.flushOne(f.transport); const peer = await f.peer();
  for (let index = 0; index < 6; index++) { await peer.update(rows); await peer.flushOne(f.transport); }
  const first = await f.sync.pull(f.transport); assert.equal(first.next, 5); assert.equal(first.through, 7);
  await peer.update(rows); await peer.flushOne(f.transport);
  const end = await f.sync.pull(f.transport, first.through); assert.equal(end.next, null); assert.equal(end.revision, 7);
  assert.equal((await f.sync.pull(f.transport)).revision, 8);
});
it("quarantines a validly signed but nonconsecutive inner profile instead of trusting the outer transport", async () => {
  const f = await fixture(); await f.enroll(); await f.sync.flushOne(f.transport);
  const local = await f.sync.read(), inventory = structuredClone(local.inventory.signed.inventory);
  inventory.revision = 2; inventory.previousDigest = "A".repeat(43);
  const signed = { inventory, signature: await signPrivateChange(f.signing.privateKey, inventory) };
  const header = { ...f.versions[0]!.header, operationId: crypto.randomUUID(), revision: 2, previousRoot: local.checkpoint.root };
  const key = await deriveSecret(f.master, canonicalJson({ protocol: "trackyourtime-account-inventory-encryption-v1", ...scope }));
  try {
    assert.notEqual(inventory.previousDigest, await privateRecordDigest(local.inventory.signed.inventory));
    const box = await seal(key, signed, canonicalJson(header));
    await f.transport.commit({ header, box, signature: await signPrivateChange(f.signing.privateKey, { header, box }) });
  } finally { key.fill(0); }
  await assert.rejects(f.sync.pull(f.transport), PrivateInventoryConflictError);
  const reopened = await f.create();
  assert.deepEqual(await reopened.status(), { checkpoint: local.checkpoint, pending: 0, conflict: true });
  assert.deepEqual((await reopened.exportPending()).conflict, f.versions[1]);
});
