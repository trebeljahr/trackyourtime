import assert from "node:assert/strict";
import { it } from "node:test";
import { createPrivateStorage, PrivateStorageLockedError } from "../privacy/storage.js";
import { segmentedPrivateStorage } from "../privacy/segmented-storage.js";
import { randomSecret } from "../privacy/crypto.js";
import type { KeyValueStorage } from "../storage.js";
async function fixture() {
  const map = new Map<string, string>(); let open = true, generation = 0;
  const key = randomSecret(), scope = { server: "https://api.example.test", userId: "owner", workspaceId: "workspace" };
  const backing: KeyValueStorage = { getItem: async (key) => map.get(key) ?? null, setItem: async (key, value) => { map.set(key, value); }, removeItem: async (key) => { map.delete(key); } };
  const encrypted = await createPrivateStorage({ storage: backing, scope, resolveKey: () => { const at = generation; return open ? { key, current: () => open && at === generation } : null; } });
  const capture = () => { const at = generation; return () => { if (!open || at !== generation) throw new PrivateStorageLockedError(); }; };
  const storage = segmentedPrivateStorage(encrypted, capture);
  const pointer = "segments:replica:manifest";
  return { map, backing, encrypted, storage, pointer, capture, lock: () => { open = false; generation++; }, unlock: () => { open = true; generation++; } };
}
it("round-trips a multi-byte value beyond the old 8 MiB limit as bounded encrypted parts", async () => {
  const f = await fixture(), value = "€".repeat(3_000_000);
  await f.storage.setItem("replica", value);
  assert.equal(await f.storage.getItem("replica"), value);
  const pointer = JSON.parse((await f.encrypted.getItem(f.pointer))!);
  assert.equal(pointer.active.bytes, 9_000_000); assert.ok(pointer.active.parts > 1);
  assert.ok([...f.map.values()].every((raw) => raw.length < 700_000 && !raw.includes("€€")));
  await f.storage.removeItem("replica"); assert.equal(f.map.size, 0);
});
it("keeps the previous value readable after interrupted staging, then cleans the incomplete generation on retry", async () => {
  const f = await fixture(); await f.storage.setItem("replica", "original");
  let fail = true;
  const interrupted = segmentedPrivateStorage({ ...f.encrypted, setItem: async (key, value) => { if (fail && key.endsWith(":1")) throw new Error("Power lost"); await f.encrypted.setItem(key, value); } }, f.capture);
  await assert.rejects(interrupted.setItem("replica", "new".repeat(200_000)), /Power lost/);
  assert.equal(await interrupted.getItem("replica"), "original");
  const pointer = JSON.parse((await f.encrypted.getItem(f.pointer))!); assert.ok(pointer.staging);
  const stagedPart = `segments:replica:${pointer.staging.id}:0`;
  assert.notEqual(await f.encrypted.getItem(stagedPart), null);
  fail = false; await interrupted.setItem("replica", "complete");
  assert.equal(await interrupted.getItem("replica"), "complete"); assert.equal(await f.encrypted.getItem(stagedPart), null);
});
it("does not replace a corrupt active generation or a newer manifest", async () => {
  const f = await fixture(); await f.storage.setItem("replica", "original");
  const original = (await f.encrypted.getItem(f.pointer))!, pointer = JSON.parse(original);
  const activeKey = `segments:replica:${pointer.active.id}:0`;
  await f.encrypted.setItem(activeKey, "dGFtcGVyZWQ");
  await assert.rejects(f.storage.getItem("replica"), /wrong length|verification/);
  await assert.rejects(f.storage.setItem("replica", "replacement"), /wrong length|verification/);
  assert.equal(await f.encrypted.getItem(f.pointer), original);
  const newer = JSON.stringify({ ...pointer, v: 2 }); await f.encrypted.setItem(f.pointer, newer);
  await assert.rejects(f.storage.setItem("replica", "replacement"), /Unsupported/);
  assert.equal(await f.encrypted.getItem(f.pointer), newer);
});
it("preserves and upgrades the earlier encrypted single-value format only after complete verification", async () => {
  const f = await fixture(); await f.encrypted.setItem("replica", "old bounded value");
  assert.equal(await f.storage.getItem("replica"), "old bounded value");
  const interrupted = segmentedPrivateStorage({ ...f.encrypted, setItem: async (key, value) => { if (key.endsWith(":0")) throw new Error("Disk full"); await f.encrypted.setItem(key, value); } }, f.capture);
  await assert.rejects(interrupted.setItem("replica", "replacement"), /Disk full/);
  assert.equal(await f.storage.getItem("replica"), "old bounded value"); assert.equal(await f.encrypted.getItem("replica"), "old bounded value");
  await f.storage.setItem("replica", "verified replacement");
  assert.equal(await f.storage.getItem("replica"), "verified replacement"); assert.equal(await f.encrypted.getItem("replica"), null);
});
it("retains cleanup metadata after a committed save and retries cleanup before another generation", async () => {
  const f = await fixture(); await f.storage.setItem("replica", "original");
  const old = JSON.parse((await f.encrypted.getItem(f.pointer))!).active;
  let fail = true;
  const interrupted = segmentedPrivateStorage({ ...f.encrypted, removeItem: async (key) => { if (fail && key.includes(old.id)) throw new Error("Cleanup failed"); await f.encrypted.removeItem(key); } }, f.capture);
  await interrupted.setItem("replica", "committed"); assert.equal(await interrupted.getItem("replica"), "committed");
  const current = JSON.parse((await f.encrypted.getItem(f.pointer))!); assert.equal(current.garbage[0].id, old.id);
  await assert.rejects(interrupted.setItem("replica", "blocked"), /Cleanup failed/);
  assert.equal(await interrupted.getItem("replica"), "committed");
  fail = false; await interrupted.setItem("replica", "next");
  assert.equal(await f.encrypted.getItem(`segments:replica:${old.id}:0`), null); assert.equal(await interrupted.getItem("replica"), "next");
});
it("a lock followed by a quick unlock cannot resume a staged write from the old session", async () => {
  const f = await fixture(); await f.storage.setItem("replica", "original");
  let triggered = false;
  const interrupted = segmentedPrivateStorage({ ...f.encrypted, setItem: async (key, value) => { await f.encrypted.setItem(key, value); if (!triggered && key.endsWith(":0")) { triggered = true; f.lock(); f.unlock(); } } }, f.capture);
  await assert.rejects(interrupted.setItem("replica", "late value"), PrivateStorageLockedError);
  assert.equal(await f.storage.getItem("replica"), "original");
});
