// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPrivateStorage, randomSecret, segmentedPrivateStorage } from "@starter/core";
import { erasePrivateIndexedStorage, openPrivateIndexedStorage, privateDatabaseName } from "./private-indexed-storage";
const scope = { server: "https://api.example.test", userId: "owner", workspaceId: "team" };
const closers: (() => void)[] = [];
beforeEach(() => { vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("indexedDB", new IDBFactory()); });
afterEach(() => { closers.splice(0).forEach((close) => close()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function fixture(s = scope, key = randomSecret()) {
  const host = await openPrivateIndexedStorage(s); closers.push(host.close);
  const encrypted = await createPrivateStorage({ storage: host.storage, scope: s, resolveKey: () => ({ key, current: () => true }) });
  return { host, encrypted, key, exclusive: host.exclusive(s.workspaceId) };
}
function open(name: string, version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => { const request = indexedDB.open(name, version); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
async function rawValues(s = scope) {
  const db = await open(await privateDatabaseName(s));
  try { return await new Promise<unknown[]>((resolve, reject) => { const tx = db.transaction("ciphertext"); const request = tx.objectStore("ciphertext").getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
  finally { db.close(); }
}
it("isolates servers/accounts/workspaces and persists only encrypted envelopes", async () => {
  const a = await fixture(), b = await fixture({ ...scope, workspaceId: "other" }, a.key), c = await fixture({ ...scope, userId: "other" }), d = await fixture({ ...scope, server: "https://other.example.test" });
  await a.exclusive(() => a.encrypted.setItem("replica", "Sensitive work description"));
  expect(await a.encrypted.getItem("replica")).toBe("Sensitive work description");
  for (const f of [b, c, d]) expect(await f.encrypted.getItem("replica")).toBeNull();
  const values = await rawValues(); expect(values).toHaveLength(1); expect(JSON.stringify(values)).not.toContain("Sensitive work description");
  await expect(a.host.storage.setItem(`${a.encrypted.namespace}plaintext`, "Sensitive work description")).rejects.toThrow();
  await expect(a.host.storage.setItem("ordinary-cache", JSON.stringify(values[0]))).rejects.toThrow("Invalid encrypted storage key");
});
it("reopens a segmented Unicode replica larger than localStorage without plaintext parts", async () => {
  const f = await fixture(), value = "Private history 🦕".repeat(480000);
  const segmented = segmentedPrivateStorage(f.encrypted, () => () => {});
  await f.exclusive(() => segmented.setItem("replica", value)); f.host.close();
  const reopened = await fixture(scope, f.key), reader = segmentedPrivateStorage(reopened.encrypted, () => () => {});
  expect(await reopened.exclusive(() => reader.getItem("replica"))).toBe(value);
  const values = await rawValues(); expect(values.length).toBeGreaterThan(30); expect(JSON.stringify(values)).not.toContain("Private history");
}, 20000);
it("serializes read/modify/write across two window hosts", async () => {
  const a = await fixture(), b = await fixture(scope, a.key); await a.encrypted.setItem("counter", "0");
  const increment = (f: typeof a) => f.exclusive(async () => { const value = Number(await f.encrypted.getItem("counter")); await new Promise((resolve) => setTimeout(resolve, 2)); await f.encrypted.setItem("counter", String(value + 1)); });
  await Promise.all([increment(a), increment(b), increment(a), increment(b)]); expect(await a.encrypted.getItem("counter")).toBe("4");
});
it("waits for active operations before scoped account erasure and invalidates old handles", async () => {
  const a = await fixture(), b = await fixture(scope, a.key), other = await fixture({ ...scope, userId: "other" }); await other.encrypted.setItem("replica", "Keep another account");
  let release!: () => void, started!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; }), ready = new Promise<void>((resolve) => { started = resolve; });
  const write = a.exclusive(async () => { started(); await waiting; await a.encrypted.setItem("replica", "Pending work"); }); await ready;
  let erased = false; const erasing = erasePrivateIndexedStorage(scope).then(() => { erased = true; });
  await new Promise((resolve) => setTimeout(resolve, 5)); expect(erased).toBe(false); release(); await write; await erasing;
  for (const f of [a, b]) await expect(f.encrypted.getItem("replica")).rejects.toThrow("Private database was closed");
  expect(await other.encrypted.getItem("replica")).toBe("Keep another account"); const reopened = await fixture(scope, a.key); expect(await reopened.encrypted.getItem("replica")).toBeNull();
});
it("refuses a newer database without erasing its contents", async () => {
  const name = await privateDatabaseName(scope), request = indexedDB.open(name, 2); request.onupgradeneeded = () => request.result.createObjectStore("future");
  const db = await new Promise<IDBDatabase>((resolve) => { request.onsuccess = () => resolve(request.result); }); db.close();
  await expect(openPrivateIndexedStorage(scope)).rejects.toMatchObject({ name: "VersionError" });
  const future = await open(name); expect(future.version).toBe(2); expect(future.objectStoreNames.contains("future")).toBe(true); future.close();
});
it("does not acknowledge an aborted write after its put request succeeds", async () => {
  const f = await fixture(); await f.encrypted.setItem("replica", "Original work"); const put = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args: Parameters<typeof put>) {
    const request = Reflect.apply(put, this, args) as IDBRequest<IDBValidKey>; request.addEventListener("success", () => this.transaction.abort()); return request;
  });
  await expect(f.encrypted.setItem("replica", "Must not be acknowledged")).rejects.toThrow(); expect(await f.encrypted.getItem("replica")).toBe("Original work");
});
it("closes stale handles when another window upgrades the database", async () => {
  const f = await fixture(), db = await open(await privateDatabaseName(scope), 2); await expect(f.encrypted.setItem("replica", "Late write")).rejects.toThrow("Private database was closed"); db.close();
});
it("requires cross-window locks and refuses malformed scope without falling back", async () => {
  await expect(openPrivateIndexedStorage({ server: "https://api.example.test/path", userId: "owner" })).rejects.toThrow("Invalid private database scope");
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "locks")!; Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
  try { await expect(openPrivateIndexedStorage(scope)).rejects.toThrow("requires Web Locks"); } finally { Object.defineProperty(navigator, "locks", descriptor); }
});
