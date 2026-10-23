import type { KeyValueStorage } from "../storage.js";
import { deriveSecret, encodeSecret, seal, unseal, type Ciphertext } from "./crypto.js";

export type PrivateStorageScope = { server: string; userId: string; workspaceId: string };
/** The resolver owns this key. The adapter copies it and wipes its own copies.
 * `current` must become false on lock, sign-out, key rotation or scope change. */
export type PrivateStorageKey = { key: Uint8Array; current: () => boolean; release?: () => void };
export const PRIVATE_STORAGE_MAX_VALUE_BYTES = 8 * 1024 * 1024;
const MAX_ENVELOPE_CHARS = 32 * 1024 * 1024;
const encoder = new TextEncoder();

export class PrivateStorageLockedError extends Error {
  constructor() { super("Unlock private data before accessing this device's encrypted workspace storage"); this.name = "PrivateStorageLockedError"; }
}
export class PrivateStorageIntegrityError extends Error {
  constructor(cause?: unknown) { super("Encrypted workspace storage could not be verified; the stored copy was kept", { cause }); this.name = "PrivateStorageIntegrityError"; }
}
export class PrivateStorageWriteError extends Error {
  constructor() { super("Could not confirm the encrypted workspace storage write"); this.name = "PrivateStorageWriteError"; }
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function envelope(raw: string): Ciphertext {
  try {
    if (raw.length > MAX_ENVELOPE_CHARS) throw new Error("Encrypted storage exceeds its limit");
    const value: unknown = JSON.parse(raw);
    if (!object(value) || value.v !== 1 || value.kind !== "trackyourtime-private-storage" || Object.keys(value).length !== 3 || !object(value.box)) throw new Error("Unsupported encrypted storage format");
    const box = value.box;
    if (box.v !== 1 || typeof box.nonce !== "string" || typeof box.data !== "string" || Object.keys(box).length !== 3) throw new Error("Unsupported encrypted storage box");
    return box as Ciphertext;
  } catch (error) { throw new PrivateStorageIntegrityError(error); }
}

/** A separate namespace for each account, server and workspace. Use this for
 * private replicas and queues, never as an automatic wrapper around a shared
 * legacy queue that may still contain another account's unsent work.
 *
 * Like KeyValueStorage, this adapter does not own multi-operation locks. A
 * read/modify/write caller must hold its queue or replica's exclusive lock for
 * the full operation. Individual backing writes must be atomic. */
export async function createPrivateStorage({ storage, scope, resolveKey }: {
  storage: KeyValueStorage;
  scope: PrivateStorageScope;
  resolveKey: () => PrivateStorageKey | null;
}): Promise<KeyValueStorage & { namespace: string }> {
  const server = new URL(scope.server);
  if (!["https:", "http:"].includes(server.protocol) || server.origin !== scope.server || typeof scope.userId !== "string" || !scope.userId || scope.userId.length > 100 || typeof scope.workspaceId !== "string" || !scope.workspaceId || scope.workspaceId.length > 100) throw new Error("Invalid private storage scope");
  // Capture primitives; mutating the caller's scope cannot redirect an adapter.
  const binding = JSON.stringify(["trackyourtime-private-storage-v1", scope.server, scope.userId, scope.workspaceId]);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(binding)));
  const namespace = `trackyourtime.private.${encodeSecret(digest)}.`;
  const file = (key: string): string => {
    if (typeof key !== "string" || !key || key.length > 1024) throw new Error("Invalid private storage key");
    return `${namespace}${encodeURIComponent(key)}`;
  };
  const aad = (key: string) => JSON.stringify([binding, key]);
  const withKey = async <T>(work: (key: Uint8Array, check: () => void) => Promise<T>): Promise<T> => {
    const access = resolveKey();
    if (!access) throw new PrivateStorageLockedError();
    let copy: Uint8Array | undefined;
    let key: Uint8Array | undefined;
    const check = () => { if (!access.current()) throw new PrivateStorageLockedError(); };
    try {
      if (access.key.length !== 32) throw new PrivateStorageLockedError();
      check(); copy = new Uint8Array(access.key);
      key = await deriveSecret(copy, binding); check();
      const result = await work(key, check); check(); return result;
    } finally { copy?.fill(0); key?.fill(0); access.release?.(); }
  };
  const decode = async (key: Uint8Array, raw: string, logicalKey: string): Promise<string> => {
    try {
      const value = await unseal<unknown>(key, envelope(raw), aad(logicalKey));
      if (typeof value !== "string" || encoder.encode(value).length > PRIVATE_STORAGE_MAX_VALUE_BYTES) throw new Error("Invalid private storage value");
      return value;
    } catch (error) {
      if (error instanceof PrivateStorageIntegrityError) throw error;
      throw new PrivateStorageIntegrityError(error);
    }
  };
  return {
    namespace,
    getItem: (logicalKey) => withKey(async (key, check) => {
      const raw = await storage.getItem(file(logicalKey)); check();
      return raw === null ? null : decode(key, raw, logicalKey);
    }),
    setItem: (logicalKey, value) => withKey(async (key, check) => {
      if (typeof value !== "string" || encoder.encode(value).length > PRIVATE_STORAGE_MAX_VALUE_BYTES) throw new Error("Invalid or oversized private storage value");
      const target = file(logicalKey), existing = await storage.getItem(target); check();
      // Never overwrite ciphertext from a different key/version or damaged
      // storage. An explicit recovery/erasure flow must handle that case.
      if (existing !== null) { await decode(key, existing, logicalKey); check(); }
      const raw = JSON.stringify({ v: 1, kind: "trackyourtime-private-storage", box: await seal(key, value, aad(logicalKey)) });
      check(); await storage.setItem(target, raw); check();
      // A best-effort storage adapter must not acknowledge lost queued work.
      if (await storage.getItem(target) !== raw) throw new PrivateStorageWriteError();
    }),
    removeItem: (logicalKey) => withKey(async (key, check) => {
      const target = file(logicalKey), raw = await storage.getItem(target); check();
      if (raw === null) return;
      await decode(key, raw, logicalKey); check();
      await storage.removeItem(target); check();
      if (await storage.getItem(target) !== null) throw new PrivateStorageWriteError();
    }),
  };
}
