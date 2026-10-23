import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createSecureStore, type Encryption } from "../secure-store.ts";
import { ACTIVITY_PROTECTION_REQUIRED, markEmptyActivityProtected, activityAccount, activityProtection, createActivityCodec, protectActivity, recoverActivitySwap, finishActivitySwap, type ActivityCodec } from "./protection.ts";
import { parseScope } from "./ipc-parse.ts";
import type { ActivityService } from "./service.ts";
import { createActivityStore } from "./store.ts";

type Status = { encrypted: boolean; locked: boolean; trusted: boolean; canTrust: boolean };
/** Key lifetime and store replacement live outside Electron so tests use only
 * synthetic history and fake OS encryption, never the real keychain. */
export function createActivityVault(options: {
  userData: string;
  encryption?: Encryption;
  makeService: (codec: ActivityCodec | undefined, status: () => Status) => ActivityService;
  onReplace: (service: ActivityService) => void;
}) {
  recoverActivitySwap(options.userData);
  let codec: ActivityCodec | undefined, protectedAccount: string | null = null;
  let explicitlyLocked = false;
  let disposed = false;
  const trustedPath = path.join(options.userData, "activity-device-key.bin");
  const trusted = options.encryption ? createSecureStore(options.encryption, {
    read: () => { try { return readFileSync(trustedPath); } catch { return null; } },
    write: (data) => {
      mkdirSync(options.userData, { recursive: true });
      writeFileSync(`${trustedPath}.tmp`, data, { mode: 0o600 });
      renameSync(`${trustedPath}.tmp`, trustedPath);
    },
    remove: () => rmSync(trustedPath, { force: true }),
  }) : null;
  const status = (): Status => {
    let encrypted = true;
    try { encrypted = existsSync(path.join(options.userData, ACTIVITY_PROTECTION_REQUIRED)) || activityProtection(options.userData) !== null; } catch { /* fail closed */ }
    return { encrypted, locked: encrypted && !codec, trusted: existsSync(trustedPath), canTrust: !!trusted && !["basic_text", "unknown", "unavailable"].includes(options.encryption?.backend() ?? "unavailable") };
  };
  const requireProtection = () => {
    mkdirSync(options.userData, { recursive: true });
    writeFileSync(path.join(options.userData, ACTIVITY_PROTECTION_REQUIRED), "1\n", { mode: 0o600 });
  };
  let activity = options.makeService(codec, status);
  options.onReplace(activity);
  const reset = () => { activity = options.makeService(codec, status); options.onReplace(activity); };
  let transition: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = () => { if (disposed) throw new Error("Activity vault is closed"); return task(); };
    const next = transition.then(run, run);
    transition = next.catch(() => undefined);
    return next;
  };
  const stop = async () => { await activity.settled(); if (disposed) throw new Error("Activity vault is closed"); activity.dispose(); };
  const discardKey = () => { codec?.destroy(); codec = undefined; protectedAccount = null; };
  return {
    settled: () => transition,
    status,
    protect: (input: unknown) => serial(async () => {
      if (!input || typeof input !== "object") throw new Error("Invalid activity key");
      const { key, userId, origin, remember } = input as Record<string, unknown>;
      if (typeof key !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(key) || typeof userId !== "string" || !userId || userId.length > 100 || userId.includes(":") || typeof origin !== "string" || origin.length > 2048) throw new Error("Invalid activity key");
      const account = activityAccount(userId, origin), existing = activityProtection(options.userData);
      if (existing && existing.account !== account) throw new Error("Activity belongs to another account");
      if (!existing) {
        const scope = createActivityStore(options.userData).scope();
        if (scope && !scope.startsWith(`${userId}:`)) throw new Error("Activity belongs to another account");
      }
      const raw = Buffer.from(key, "base64url"), nextCodec = createActivityCodec(raw, account); raw.fill(0);
      try {
        if (existing) finishActivitySwap(options.userData, nextCodec);
        if (remember === true) {
          if (!trusted?.status().persistent) throw new Error("A secure OS keychain is required to trust this device");
          trusted.setToken(JSON.stringify({ account, key }));
        } else if (remember === false) trusted?.deleteToken();
      } catch (error) { nextCodec.destroy(); throw error; }
      await stop();
      try {
        if (!existing) protectActivity(options.userData, nextCodec, account);
        requireProtection();
        discardKey(); codec = nextCodec; protectedAccount = account; explicitlyLocked = false;
      } catch (error) { nextCodec.destroy(); reset(); throw error; }
      reset(); return activity.snapshot();
    }),
    lock: () => serial(async () => {
      explicitlyLocked = true;
      if (codec) { await stop(); discardKey(); reset(); }
      return activity.snapshot();
    }),
    setScope: (input: unknown) => serial(async () => {
      const scope = parseScope(input); if (!scope) return;
      const existing = activityProtection(options.userData);
      const origin = typeof input === "object" && input !== null && "origin" in input ? (input as { origin: unknown }).origin : null;
      if (existing && !codec && !explicitlyLocked && existsSync(trustedPath) && typeof origin === "string" && existing.account === activityAccount(scope.userId, origin)) {
        let saved: { account?: string; key?: string } | null = null;
        try { const text = trusted?.getToken(); saved = text ? JSON.parse(text) : null; } catch { /* One attempt only; never retry a denied keychain prompt. */ }
        if (saved?.account === existing.account && typeof saved.key === "string" && /^[A-Za-z0-9_-]{43}$/.test(saved.key)) {
          const raw = Buffer.from(saved.key, "base64url"), nextCodec = createActivityCodec(raw, existing.account); raw.fill(0);
          try {
            finishActivitySwap(options.userData, nextCodec);
            await stop(); codec = nextCodec; protectedAccount = existing.account; reset();
          } catch { nextCodec.destroy(); trusted?.deleteToken(); }
        }
      }
      if (existing && (!protectedAccount || typeof origin !== "string" || existing.account !== activityAccount(scope.userId, origin))) {
        await stop(); discardKey(); reset(); return;
      }
      await activity.setScope(scope);
    }),
    forget: () => serial(async () => {
      trusted?.deleteToken(); explicitlyLocked = false;
      if (!status().encrypted) { await activity.forget(); return; }
      requireProtection();
      await stop(); discardKey();
      for (const name of ["activity", "activity.previous", "activity.protecting"]) rmSync(path.join(options.userData, name), { recursive: true, force: true });
      markEmptyActivityProtected(options.userData);
      reset();
    }),
    wipeLocked: () => serial(async () => {
      if (!status().locked) return activity.wipe();
      requireProtection(); trusted?.deleteToken(); await stop(); discardKey();
      for (const name of ["activity", "activity.previous", "activity.protecting"]) rmSync(path.join(options.userData, name), { recursive: true, force: true });
      markEmptyActivityProtected(options.userData);
      reset(); return activity.snapshot();
    }),
    dispose: () => { disposed = true; activity.dispose(); discardKey(); },
  };
}
