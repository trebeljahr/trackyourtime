import type { KeyValueStorage } from "../storage.js";
import { decodeSecret, encodeSecret } from "./crypto.js";
const PART_BYTES = 256 * 1024;
export const PRIVATE_SEGMENTED_MAX_BYTES = 64 * 1024 * 1024;
const encoder = new TextEncoder();
type Generation = { id: string; bytes: number; digest: string; parts: number };
type Manifest = { v: 1; kind: "trackyourtime-private-segments"; active: Generation | null; staging: Generation | null; garbage: Generation[] };
const empty = (): Manifest => ({ v: 1, kind: "trackyourtime-private-segments", active: null, staging: null, garbage: [] });
function generation(value: unknown): value is Generation {
  const row = value as Generation | null;
  return !!row && typeof row === "object" && Object.keys(row).length === 4 && typeof row.id === "string" && /^[0-9a-f-]{36}$/.test(row.id) && Number.isSafeInteger(row.bytes) && row.bytes >= 0 && row.bytes <= PRIVATE_SEGMENTED_MAX_BYTES && Number.isSafeInteger(row.parts) && row.parts === Math.max(1, Math.ceil(row.bytes / PART_BYTES)) && typeof row.digest === "string" && /^[A-Za-z0-9_-]{43}$/.test(row.digest);
}
function manifest(raw: string | null): Manifest {
  if (raw === null) return empty();
  const value = JSON.parse(raw) as Manifest;
  if (!value || value.v !== 1 || value.kind !== "trackyourtime-private-segments" || Object.keys(value).length !== 5 || (value.active !== null && !generation(value.active)) || (value.staging !== null && !generation(value.staging)) || !Array.isArray(value.garbage) || value.garbage.length > 1 || value.garbage.some((row) => !generation(row))) throw new Error("Unsupported private segmented storage manifest");
  const all = [value.active, value.staging, ...value.garbage].filter((row): row is Generation => !!row);
  if (new Set(all.map((row) => row.id)).size !== all.length) throw new Error("Duplicate private storage generation");
  return value;
}
/** Put this ABOVE an authenticated private storage adapter. Each bounded part
 * and pointer is encrypted by that adapter. The host must hold its inter-window
 * lock for the whole operation. A staged write cannot replace the active value
 * until every byte has been reopened and verified. */
export function segmentedPrivateStorage(encrypted: KeyValueStorage, capture: () => () => void): KeyValueStorage {
  const pointer = (key: string) => `segments:${key}:manifest`;
  const part = (key: string, row: Generation, index: number) => `segments:${key}:${row.id}:${index}`;
  const digest = async (bytes: Uint8Array<ArrayBuffer>) => encodeSecret(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
  const read = async (key: string, row: Generation, check: () => void): Promise<string> => {
    const result = new Uint8Array(row.bytes);
    let offset = 0;
    for (let index = 0; index < row.parts; index++) {
      check(); const raw = await encrypted.getItem(part(key, row, index)); check();
      if (raw === null) throw new Error("Private storage part is missing; the manifest was kept");
      const bytes = decodeSecret(raw, PART_BYTES);
      const expected = Math.min(PART_BYTES, row.bytes - offset);
      if (bytes.length !== expected) throw new Error("Private storage part has the wrong length");
      result.set(bytes, offset); offset += bytes.length;
    }
    const actual = await digest(result); check();
    if (actual !== row.digest) throw new Error("Private storage parts failed verification");
    return new TextDecoder("utf-8", { fatal: true }).decode(result);
  };
  const erase = async (key: string, rows: Generation[], check: () => void) => {
    for (const row of rows) for (let index = 0; index < row.parts; index++) { check(); await encrypted.removeItem(part(key, row, index)); check(); }
  };
  return {
    async getItem(key) {
      const check = capture(); check();
      const current = manifest(await encrypted.getItem(pointer(key))); check();
      if (current.active) return read(key, current.active, check);
      // Upgrade the original bounded encrypted value only after a verified
      // segmented replacement commits. Interrupted staging keeps it readable.
      const legacy = await encrypted.getItem(key); check(); return legacy;
    },
    async setItem(key, value) {
      const check = capture(); check();
      if (typeof value !== "string" || value.length > PRIVATE_SEGMENTED_MAX_BYTES) throw new Error("Private workspace state is too large");
      const bytes = encoder.encode(value);
      if (bytes.length > PRIVATE_SEGMENTED_MAX_BYTES) throw new Error("Private workspace state is too large");
      const current = manifest(await encrypted.getItem(pointer(key))); check();
      if (current.active) { await read(key, current.active, check); await encrypted.removeItem(key); check(); }
      else { await encrypted.getItem(key); check(); }
      // A previous interrupted staging write is tracked before any part is
      // created. Clean it before starting another generation; no orphan scan.
      await erase(key, [...current.garbage, ...(current.staging ? [current.staging] : [])], check);
      const next: Generation = { id: crypto.randomUUID(), bytes: bytes.length, parts: Math.max(1, Math.ceil(bytes.length / PART_BYTES)), digest: await digest(bytes) }; check();
      await encrypted.setItem(pointer(key), JSON.stringify({ ...empty(), active: current.active, staging: next } satisfies Manifest)); check();
      for (let index = 0; index < next.parts; index++) { check(); await encrypted.setItem(part(key, next, index), encodeSecret(bytes.subarray(index * PART_BYTES, (index + 1) * PART_BYTES))); check(); }
      if (await read(key, next, check) !== value) throw new Error("Private workspace state could not be verified");
      check(); await encrypted.setItem(pointer(key), JSON.stringify({ ...empty(), active: next, garbage: current.active ? [current.active] : [] } satisfies Manifest)); check();
      // The committed pointer retains garbage metadata until the next write.
      // Failed cleanup cannot turn a committed value into a lost save.
      try { await erase(key, current.active ? [current.active] : [], check); await encrypted.removeItem(key); check(); } catch { /* Retried before the next generation. */ }
    },
    async removeItem(key) {
      const check = capture(); check();
      const current = manifest(await encrypted.getItem(pointer(key))); check();
      await erase(key, [...current.garbage, ...(current.staging ? [current.staging] : []), ...(current.active ? [current.active] : [])], check);
      await encrypted.removeItem(key); check(); await encrypted.removeItem(pointer(key)); check();
    },
  };
}
