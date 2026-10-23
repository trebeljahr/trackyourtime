import assert from "node:assert/strict";
import { it } from "node:test";
import { createPrivateStorage, PrivateStorageIntegrityError, PrivateStorageLockedError, PrivateStorageWriteError } from "../privacy/storage.js";
import { randomSecret } from "../privacy/crypto.js";
import { memoryStorage, type KeyValueStorage } from "../storage.js";
import { createOfflineQueue } from "../offline-queue.js";
const scope = { server: "https://api.example.test", userId: "owner", workspaceId: "workspace" };

it("persists a durable offline queue as ciphertext and reopens the exact operation without storing its key", async () => {
  const backing = memoryStorage(), key = randomSecret();
  const encrypted = await createPrivateStorage({ storage: backing, scope, resolveKey: () => ({ key, current: () => true }) });
  const queue = createOfflineQueue({ storage: encrypted, durableEntries: true });
  const row = await queue.enqueue("entries.create", { input: { description: "Sensitive client work", start: "2026-10-23T00:00:00.000Z", end: "2026-10-23T01:00:00.000Z" } }, "owner", scope.server, scope.workspaceId);
  const raw = await backing.getItem(`${encrypted.namespace}trackyourtime.offline-queue`);
  assert.ok(raw); assert.doesNotMatch(raw, /Sensitive client work|2026-10-23|entries.create/);
  assert.ok(!raw.includes(Buffer.from(key).toString("base64url")));
  const reopened = createOfflineQueue({ storage: await createPrivateStorage({ storage: backing, scope, resolveKey: () => ({ key, current: () => true }) }), durableEntries: true });
  assert.deepEqual(await reopened.list(), [row]);
  assert.equal(await backing.getItem("trackyourtime.offline-queue"), null);
});

it("keeps account, server, workspace and logical-file boundaries even if ciphertext is copied", async () => {
  const backing = memoryStorage(), key = randomSecret();
  const first = await createPrivateStorage({ storage: backing, scope, resolveKey: () => ({ key, current: () => true }) });
  await first.setItem("replica", "private snapshot");
  const raw = (await backing.getItem(`${first.namespace}replica`))!;
  for (const change of [{ userId: "other" }, { workspaceId: "other" }, { server: "https://other.example.test" }]) {
    const other = await createPrivateStorage({ storage: backing, scope: { ...scope, ...change }, resolveKey: () => ({ key, current: () => true }) });
    assert.notEqual(other.namespace, first.namespace);
    await backing.setItem(`${other.namespace}replica`, raw);
    await assert.rejects(other.getItem("replica"), PrivateStorageIntegrityError);
  }
  await backing.setItem(`${first.namespace}another`, raw);
  await assert.rejects(first.getItem("another"), PrivateStorageIntegrityError);
});

it("keeps ciphertext unchanged when locked, given the wrong key, corrupted, or stored in a newer format", async () => {
  const backing = memoryStorage(), key = randomSecret();
  let open = true, activeKey = key;
  const encrypted = await createPrivateStorage({ storage: backing, scope, resolveKey: () => open ? { key: activeKey, current: () => open } : null });
  await encrypted.setItem("queue", "unsent work");
  const target = `${encrypted.namespace}queue`, original = (await backing.getItem(target))!;
  open = false;
  for (const operation of [() => encrypted.getItem("queue"), () => encrypted.setItem("queue", "lost"), () => encrypted.removeItem("queue")]) await assert.rejects(operation(), PrivateStorageLockedError);
  assert.equal(await backing.getItem(target), original);
  open = true; activeKey = randomSecret();
  await assert.rejects(encrypted.setItem("queue", "lost"), PrivateStorageIntegrityError);
  activeKey = key;
  for (const malformed of ["truncated", JSON.stringify({ ...JSON.parse(original), v: 2 })]) {
    await backing.setItem(target, malformed);
    await assert.rejects(encrypted.getItem("queue"), PrivateStorageIntegrityError);
    await assert.rejects(encrypted.setItem("queue", "lost"), PrivateStorageIntegrityError);
    await assert.rejects(encrypted.removeItem("queue"), PrivateStorageIntegrityError);
    assert.equal(await backing.getItem(target), malformed);
  }
});

it("rejects silent failed writes before a durable queue sends anything", async () => {
  const backing = memoryStorage(), key = randomSecret();
  const dropsWrites: KeyValueStorage = { ...backing, setItem: async () => {} };
  const encrypted = await createPrivateStorage({ storage: dropsWrites, scope, resolveKey: () => ({ key, current: () => true }) });
  const queue = createOfflineQueue({ storage: encrypted, durableEntries: true });
  let sent = false;
  await assert.rejects(queue.submit("entries.create", { input: { description: "Unsent" } }, { owner: "owner", server: scope.server, workspaceId: scope.workspaceId }, async () => { sent = true; }), PrivateStorageWriteError);
  assert.equal(sent, false);
});

it("rejects operations that lock before encrypted persistence or decryption finishes", async () => {
  const backing = memoryStorage(), key = randomSecret();
  let open = true;
  const encrypted = await createPrivateStorage({ storage: backing, scope, resolveKey: () => ({ key, current: () => open }) });
  await encrypted.setItem("queue", "unsent work");
  const reading = encrypted.getItem("queue"); open = false;
  await assert.rejects(reading, PrivateStorageLockedError);
  open = true;
  const writing = encrypted.setItem("queue", "late work"); open = false;
  await assert.rejects(writing, PrivateStorageLockedError);
  open = true; assert.equal(await encrypted.getItem("queue"), "unsent work");
});

it("retains concurrent queued operations when replica callers share their exclusive lock", async () => {
  const backing = memoryStorage(), key = randomSecret();
  let pending = Promise.resolve();
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const result = pending.then(work, work);
    pending = result.then(() => undefined, () => undefined);
    return result;
  };
  const encrypted = await createPrivateStorage({ storage: backing, scope, resolveKey: () => ({ key, current: () => true }) });
  const first = createOfflineQueue({ storage: encrypted, exclusive }), second = createOfflineQueue({ storage: encrypted, exclusive });
  const rows = await Promise.all(Array.from({ length: 6 }, (_, i) => (i % 2 ? first : second).enqueue("entries.create", { description: `Private work ${i}` }, "owner", scope.server, scope.workspaceId)));
  assert.deepEqual((await first.list()).map((row) => row.id), rows.map((row) => row.id));
});

it("releases temporary resolver keys on successful reads and refused access", async () => {
  const backing = memoryStorage(), master = randomSecret();
  let temporary: Uint8Array | undefined, open = true;
  const encrypted = await createPrivateStorage({ storage: backing, scope, resolveKey: () => {
    const key = new Uint8Array(master); temporary = key;
    return { key, current: () => open, release: () => key.fill(0) };
  } });
  assert.equal(await encrypted.getItem("empty"), null);
  assert.ok(temporary?.every((value) => value === 0));
  open = false;
  await assert.rejects(encrypted.getItem("empty"), PrivateStorageLockedError);
  assert.ok(temporary?.every((value) => value === 0));
  assert.ok(master.some((value) => value !== 0));
});
