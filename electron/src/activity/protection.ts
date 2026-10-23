/** Activity encryption is independent of the OS keychain. A trusted device
 * may remember the account-derived key using a separate, secure OS store. */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_ACTIVITY_SETTINGS } from "./settings.ts";

export const ACTIVITY_PROTECTION_FILE = "protection.json";
/** Device policy survives sign-out; it contains no key or captured history. */
export const ACTIVITY_PROTECTION_REQUIRED = "activity-protection-required";
export interface ActivityCodec { encode: (plain: string, file: string) => string; decode: (encrypted: string, file: string) => string; destroy: () => void }
export function activityAccount(userId: string, origin: string): string {
  return createHash("sha256").update(JSON.stringify([origin, userId])).digest("hex");
}
export function createActivityCodec(key: Uint8Array, account: string): ActivityCodec {
  if (key.length !== 32 || !/^[a-f0-9]{64}$/.test(account)) throw new Error("Invalid activity key");
  const secret = Buffer.from(key);
  let destroyed = false;
  const aad = (file: string) => Buffer.from(JSON.stringify(["trackyourtime-activity-v1", account, file]));
  return {
    encode: (plain, file) => {
      if (destroyed) throw new Error("Activity key is locked");
      const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", secret, iv);
      cipher.setAAD(aad(file));
      const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
      // v2 is deliberately unreadable to older activity stores: they stop
      // capture instead of replacing the encrypted state with defaults.
      return JSON.stringify({ v: 2, algorithm: "AES-256-GCM", nonce: iv.toString("base64url"), data: data.toString("base64url"), tag: cipher.getAuthTag().toString("base64url") });
    },
    decode: (encrypted, file) => {
      if (destroyed) throw new Error("Activity key is locked");
      const box = JSON.parse(encrypted) as Record<string, unknown>;
      if (box.v !== 2 || box.algorithm !== "AES-256-GCM" || typeof box.nonce !== "string" || typeof box.data !== "string" || typeof box.tag !== "string" || box.data.length > 128 * 1024 * 1024) throw new Error("Invalid encrypted activity");
      const iv = Buffer.from(box.nonce, "base64url"), tag = Buffer.from(box.tag, "base64url");
      if (iv.length !== 12 || tag.length !== 16) throw new Error("Invalid encrypted activity");
      const cipher = createDecipheriv("aes-256-gcm", secret, iv);
      cipher.setAAD(aad(file)); cipher.setAuthTag(tag);
      return Buffer.concat([cipher.update(Buffer.from(box.data, "base64url")), cipher.final()]).toString("utf8");
    },
    destroy: () => { destroyed = true; secret.fill(0); },
  };
}
const atomic = (file: string, content: string) => {
  writeFileSync(`${file}.tmp`, content, { mode: 0o600 }); renameSync(`${file}.tmp`, file);
};
/** An older build must also stay closed after protected history is wiped. */
export function markEmptyActivityProtected(userData: string): void {
  const dir = path.join(userData, "activity");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  atomic(path.join(dir, "state.json"), JSON.stringify({ v: 2, protectionRequired: true }));
}
const rawFiles = (dir: string): string[] => existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/")).sort() : [];
export function activityProtection(userData: string): { account: string } | null {
  const file = path.join(userData, "activity", ACTIVITY_PROTECTION_FILE);
  if (!existsSync(file)) return null;
  // A damaged marker must never turn protected history back into plaintext.
  const value = JSON.parse(readFileSync(file, "utf8")) as { v: number; account: string };
  if (value.v !== 1 || !/^[a-f0-9]{64}$/.test(value.account)) throw new Error("Unreadable activity protection marker");
  return { account: value.account };
}
export function verifyActivityProtection(userData: string, codec: ActivityCodec, recoverTornTail = false): void {
  const dir = path.join(userData, "activity");
  const marker = JSON.parse(readFileSync(path.join(dir, ACTIVITY_PROTECTION_FILE), "utf8")) as { check: string };
  if (codec.decode(marker.check, "key-check") !== "trackyourtime-activity-key-v1") throw new Error("Wrong activity key");
  const repairs: { file: string; prefix: string; tail: string }[] = [];
  for (const file of rawFiles(dir)) {
    if (file === ACTIVITY_PROTECTION_FILE) continue;
    const text = readFileSync(path.join(dir, file), "utf8");
    if (file.endsWith(".jsonl")) {
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!; if (!line) continue;
        try { codec.decode(line, file); }
        catch (error) {
          // Only an unterminated final append can be a crash tear. Preserve
          // its exact bytes under authenticated encryption before trimming it.
          if (!recoverTornTail || i !== lines.length - 1 || text.endsWith("\n")) throw error;
          repairs.push({ file, prefix: lines.slice(0, i).join("\n") + (i > 0 ? "\n" : ""), tail: line });
        }
      }
    } else codec.decode(text, file);
  }
  // Do not touch any file until the key and every other record verified.
  for (const repair of repairs) {
    const recovery = `${repair.file}.torn.${randomBytes(8).toString("hex")}`;
    atomic(path.join(dir, recovery), codec.encode(repair.tail, recovery));
    atomic(path.join(dir, repair.file), repair.prefix);
  }
}
/** Build and verify a complete encrypted replacement before moving a byte of
 * the original. A verified encrypted snapshot preserves even torn/corrupt
 * source files for recovery. Original files are removed only after the swap. */
export function protectActivity(userData: string, codec: ActivityCodec, account: string): void {
  const dir = path.join(userData, "activity"), pending = path.join(userData, "activity.protecting"), previous = path.join(userData, "activity.previous");
  if (activityProtection(userData)) { verifyActivityProtection(userData, codec); return; }
  if (existsSync(previous)) throw new Error("An interrupted activity migration needs recovery first");
  if (existsSync(path.join(dir, "state.json"))) {
    const state = JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8")) as { v?: number; protectionRequired?: boolean };
    if (typeof state.v === "number" && state.v > 1 && !(state.v === 2 && state.protectionRequired === true && existsSync(path.join(userData, ACTIVITY_PROTECTION_REQUIRED)))) throw new Error("Newer activity format");
  }
  rmSync(pending, { recursive: true, force: true }); mkdirSync(pending, { recursive: true, mode: 0o700 });
  const source: Record<string, string> = {};
  try {
    for (const file of rawFiles(dir)) {
      const original = readFileSync(path.join(dir, file), "utf8"); source[file] = original;
      let plain = original;
      if (file === "state.json") {
        const state = JSON.parse(original) as { v?: number; protectionRequired?: boolean };
        if (state.v === 2 && state.protectionRequired === true) plain = JSON.stringify({ v: 1, settings: DEFAULT_ACTIVITY_SETTINGS, scope: null, rules: [], dismissals: [] });
      }
      const encrypted = file.endsWith(".jsonl") ? plain.split("\n").map((line) => line ? codec.encode(line, file) : "").join("\n") : codec.encode(plain, file);
      const check = file.endsWith(".jsonl") ? encrypted.split("\n").map((line) => line ? codec.decode(line, file) : "").join("\n") : codec.decode(encrypted, file);
      if (check !== plain) throw new Error("Activity migration verification failed");
      const target = path.join(pending, file); mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 }); atomic(target, encrypted);
    }
    const backup = codec.encode(JSON.stringify(source), "migration-backup.bin");
    if (codec.decode(backup, "migration-backup.bin") !== JSON.stringify(source)) throw new Error("Activity backup verification failed");
    atomic(path.join(pending, "migration-backup.bin"), backup);
    atomic(path.join(pending, ACTIVITY_PROTECTION_FILE), JSON.stringify({ v: 1, account, check: codec.encode("trackyourtime-activity-key-v1", "key-check") }));
    if (existsSync(dir)) renameSync(dir, previous);
    renameSync(pending, dir);
    verifyActivityProtection(userData, codec);
    rmSync(previous, { recursive: true, force: true });
  } catch (error) {
    if (!existsSync(dir) && existsSync(previous)) renameSync(previous, dir);
    throw error;
  }
}
/** Repair the narrow directory-swap crash window without guessing at a key.
 * If the new directory exists, keep the old copy until its successor verifies. */
export function recoverActivitySwap(userData: string): void {
  const dir = path.join(userData, "activity"), previous = path.join(userData, "activity.previous");
  if (!existsSync(dir) && existsSync(previous)) renameSync(previous, dir);
}
export function finishActivitySwap(userData: string, codec: ActivityCodec): void {
  verifyActivityProtection(userData, codec, true);
  rmSync(path.join(userData, "activity.previous"), { recursive: true, force: true });
  rmSync(path.join(userData, "activity.protecting"), { recursive: true, force: true });
}
