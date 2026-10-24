import type { KeyValueStorage, QueueExclusive } from "@starter/core";

const STORE = "ciphertext", VERSION = 1;
const handles = new Map<string, Set<() => void>>();
const generations = new Map<string, number>();
type AccountScope = { server: string; userId: string };
type PrivateIndexedHost = { storage: KeyValueStorage; exclusive: (workspaceId: string) => QueueExclusive; close: () => void };
export async function privateDatabaseName(scope: AccountScope): Promise<string> {
  const origin = new URL(scope.server);
  if (!["https:", "http:"].includes(origin.protocol) || origin.origin !== scope.server || typeof scope.userId !== "string" || !scope.userId || scope.userId.length > 100) throw new Error("Invalid private database scope");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(["trackyourtime-private-database-v1", scope.server, scope.userId])));
  return `trackyourtime-private-${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
function locks(): LockManager {
  if (typeof navigator === "undefined" || !navigator.locks) throw new Error("Encrypted workspace storage requires Web Locks");
  return navigator.locks;
}
function validateKey(key: string): void {
  if (!/^trackyourtime\.private\.[A-Za-z0-9_-]{43}\..+/.test(key) || key.length > 4096) throw new Error("Invalid encrypted storage key");
}
function validateCiphertext(raw: unknown): asserts raw is string {
  if (typeof raw !== "string" || raw.length > 32 * 1024 * 1024) throw new Error("Invalid encrypted storage value");
  const value = JSON.parse(raw), box = value?.box;
  if (value?.v !== 1 || value?.kind !== "trackyourtime-private-storage" || Object.keys(value).length !== 3 || !box || Object.keys(box).length !== 3 || box.v !== 1 || typeof box.nonce !== "string" || !/^[A-Za-z0-9_-]{16}$/.test(box.nonce) || typeof box.data !== "string" || !/^[A-Za-z0-9_-]{22,}$/.test(box.data)) throw new Error("Private database accepts encrypted envelopes only");
}
/** Raw backing store ONLY for createPrivateStorage. It rejects plaintext and
 * acknowledges a write after the transaction commits, never on request success.
 * It never falls back to localStorage or an in-memory queue on failure. */
export async function openPrivateIndexedStorage(scope: AccountScope): Promise<PrivateIndexedHost> {
  const name = await privateDatabaseName(scope), manager = locks();
  const accountLock = `${name}:account`;
  return manager.request<Promise<PrivateIndexedHost>>(accountLock, { mode: "shared" }, async () => {
    const generation = generations.get(name) ?? 0;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      let refused = false;
      const request = indexedDB.open(name, VERSION);
      request.onupgradeneeded = (event) => {
        if (refused || event.oldVersion !== 0) { request.transaction!.abort(); return; }
        request.result.createObjectStore(STORE);
      };
      request.onsuccess = () => {
        if (refused) { request.result.close(); return; }
        resolve(request.result);
      };
      request.onerror = () => reject(request.error ?? new Error("Could not open private database"));
      request.onblocked = () => { refused = true; reject(new Error("Private database is blocked by another window")); };
    });
    let closed = false;
    const close = () => {
      closed = true; db.close(); handles.get(name)?.delete(close);
      if (!handles.get(name)?.size) handles.delete(name);
    };
    const check = () => {
      if (closed || (generations.get(name) ?? 0) !== generation) throw new Error("Private database was closed; open it again before saving");
    };
    db.onversionchange = close;
    db.onclose = close;
    const opened = handles.get(name) ?? new Set(); opened.add(close); handles.set(name, opened);
    if (db.objectStoreNames.length !== 1 || !db.objectStoreNames.contains(STORE)) { close(); throw new Error("Unsupported private database layout; stored data was kept"); }
    const transact = <T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
      check();
      return new Promise((resolve, reject) => {
        // Ask the browser for strict durability; capacity/privacy-mode failures
        // propagate to the replica, which must keep the network request local.
        const transaction = db.transaction(STORE, mode, { durability: "strict" });
        let value: T;
        transaction.oncomplete = () => { try { check(); resolve(value); } catch (error) { reject(error); } };
        transaction.onabort = () => reject(transaction.error ?? new Error("Private database transaction aborted"));
        transaction.onerror = () => { /* The abort event settles the operation. */ };
        try {
          const request = operation(transaction.objectStore(STORE));
          request.onsuccess = () => { value = request.result; };
        } catch (error) { transaction.abort(); reject(error); }
      });
    };
    return {
      close,
      exclusive: (workspaceId) => {
        if (typeof workspaceId !== "string" || !workspaceId || workspaceId.length > 100) throw new Error("Invalid private workspace lock");
        return (task) => manager.request(accountLock, { mode: "shared" }, () => manager.request(`${name}:workspace:${encodeURIComponent(workspaceId)}`, async () => { check(); return task(); }));
      },
      storage: {
        async getItem(key) {
          validateKey(key); const raw: unknown = await transact("readonly", (store) => store.get(key));
          if (raw === undefined) return null;
          validateCiphertext(raw); return raw;
        },
        async setItem(key, value) { validateKey(key); validateCiphertext(value); await transact("readwrite", (store) => store.put(value, key)); },
        async removeItem(key) { validateKey(key); await transact("readwrite", (store) => store.delete(key)); },
      },
    };
  });
}
/** Successful account deletion only. Sign-out keeps encrypted unsent work.
 * A database version change closes other windows' handles before deletion.
 * A blocked deletion reports failure; it never silently erases another scope. */
export async function erasePrivateIndexedStorage(scope: AccountScope): Promise<void> {
  const name = await privateDatabaseName(scope), manager = locks();
  await manager.request(`${name}:account`, async () => {
    generations.set(name, (generations.get(name) ?? 0) + 1);
    for (const close of handles.get(name) ?? []) close();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error("Could not erase private database"));
      request.onblocked = () => reject(new Error("Close other app windows to finish erasing this device's encrypted data"));
    });
  });
}
