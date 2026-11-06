/**
 * Stay unlocked on this device (docs/private-workspace-protocol.md →
 * "Password unlock").
 *
 * Private keys opened with the password would otherwise live in memory only,
 * and every reload would ask for the password again. This keeps the unlocked
 * identity sealed with a per-device AES-GCM key that is generated as
 * NON-EXTRACTABLE and stored as a CryptoKey object in IndexedDB: script on
 * this origin can use it, but cannot read its bytes, and a copied database
 * file holds no usable key material on its own. The trust is the same as
 * staying signed in on this device. Sign-out, account deletion and an
 * explicit lock erase the entry.
 *
 * Any failure (no IndexedDB, a private window, a WebView that cannot store
 * CryptoKeys) leaves the keys in memory only, as before.
 */
const DB = "trackyourtime-device-keys";
const STORE = "unlocked";
const AAD = new TextEncoder().encode("trackyourtime-device-unlock-v1");

type Entry = { v: 1; key: CryptoKey; iv: Uint8Array<ArrayBuffer>; data: ArrayBuffer };

const id = (origin: string, userId: string) => `${origin}\n${userId}`;
/** A non-secret marker, so accounts that never saved an unlock resolve at once. */
const MARK = "trackyourtime:device-unlock-saved:";
const mark = (origin: string, userId: string, on: boolean) => {
  try { if (on) localStorage.setItem(MARK + id(origin, userId), "1"); else localStorage.removeItem(MARK + id(origin, userId)); } catch { /* Unavailable storage: no marker. */ }
};
export function hasSavedUnlock(origin: string, userId: string): boolean {
  try { return localStorage.getItem(MARK + id(origin, userId)) === "1"; } catch { return false; }
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("IndexedDB unavailable")); return; }
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open device key storage"));
  });
}

async function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T> | null): Promise<T | undefined> {
  const db = await open();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, mode), request = work(tx.objectStore(STORE));
      let value: T | undefined;
      if (request) request.onsuccess = () => { value = request.result; };
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error ?? new Error("Device key storage failed"));
      tx.onabort = () => reject(tx.error ?? new Error("Device key storage aborted"));
    });
  } finally { db.close(); }
}

export async function rememberUnlockedKeys(origin: string, userId: string, secrets: unknown): Promise<void> {
  try {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: AAD }, key, new TextEncoder().encode(JSON.stringify(secrets)));
    const entry: Entry = { v: 1, key, iv, data };
    await run("readwrite", (store) => store.put(entry, id(origin, userId)));
    mark(origin, userId, true);
  } catch { /* Memory only on this device. */ }
}

export async function restoreUnlockedKeys<T>(origin: string, userId: string): Promise<T | null> {
  try {
    const entry = await run<Entry | undefined>("readonly", (store) => store.get(id(origin, userId)) as IDBRequest<Entry | undefined>);
    if (!entry || entry.v !== 1 || !(entry.key instanceof CryptoKey)) return null;
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: entry.iv, additionalData: AAD }, entry.key, entry.data);
    return JSON.parse(new TextDecoder().decode(plain)) as T;
  } catch { return null; }
}

export async function forgetUnlockedKeys(origin: string, userId: string): Promise<void> {
  mark(origin, userId, false);
  try { await run("readwrite", (store) => store.delete(id(origin, userId))); } catch { /* Nothing stored. */ }
}
