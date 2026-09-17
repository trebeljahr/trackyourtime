/*
 * The session token's home: `userData/session.bin`, encrypted with Electron's
 * `safeStorage` (the macOS Keychain, DPAPI on Windows, libsecret/kwallet on
 * Linux). The renderer reaches it only through the bridge (preload.ts) and
 * never sees the file, the path or the key.
 *
 * Why a file and not localStorage: the token is a credential. `localStorage`
 * sits in the profile as plain LevelDB that anything able to read the user's
 * files can copy; `session.bin` is ciphertext whose key the OS guards.
 *
 * **The Linux trap.** With no keyring (a bare window manager, a headless box)
 * `safeStorage` still "works": `getSelectedStorageBackend()` answers
 * `basic_text`, which encrypts with a key hardcoded into Chromium. That is
 * obfuscation, and writing a credential under it would look secure and not
 * be. So this store refuses to persist there: the token lives in memory for
 * this run, the next launch starts signed out, and `status()` says so, which
 * Settings → Devices shows.
 *
 * The logic is `createSecureStore`, over injected encryption and file
 * functions, so every branch is unit-tested without Electron
 * (secure-store.test.ts). `electronSecureStore` binds it.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { DesktopSecureStoreStatus } from "../../packages/shared/src/desktop-bridge.ts";

export const SESSION_FILE = "session.bin";

/** Linux backends that are not encryption, whatever the API calls them. */
const INSECURE_BACKENDS: ReadonlySet<string> = new Set(["basic_text", "unknown"]);

export interface Encryption {
  isAvailable: () => boolean;
  /** The backend name, as `status().backend` reports it. */
  backend: () => string;
  encrypt: (plain: string) => Buffer;
  decrypt: (cipher: Buffer) => string;
}

export interface SessionFile {
  read: () => Buffer | null;
  write: (data: Buffer) => void;
  remove: () => void;
}

export interface SecureStore {
  getToken: () => string | null;
  setToken: (token: string) => DesktopSecureStoreStatus;
  deleteToken: () => void;
  status: () => DesktopSecureStoreStatus;
}

export function createSecureStore(encryption: Encryption, file: SessionFile): SecureStore {
  /** This run's token. The only copy when the backend cannot persist. */
  let memory: string | null = null;
  let loaded = false;

  const status = (): DesktopSecureStoreStatus => {
    if (!encryption.isAvailable()) return { persistent: false, backend: "unavailable" };
    const backend = encryption.backend();
    return { persistent: !INSECURE_BACKENDS.has(backend), backend };
  };

  const load = (): void => {
    if (loaded) return;
    loaded = true;
    if (!status().persistent) {
      // A file left from a run that did persist (a keyring since removed)
      // cannot be read safely either way; it is not decrypted here.
      return;
    }
    const data = file.read();
    if (data === null || data.length === 0) return;
    try {
      const token = encryption.decrypt(data);
      memory = token.length > 0 ? token : null;
    } catch {
      // The key changed (a new keychain, a profile copied to another
      // machine): this ciphertext will never decrypt again. Signed out, and
      // the dead file goes, so the next launch does not try again.
      memory = null;
      file.remove();
    }
  };

  return {
    getToken: () => {
      load();
      return memory;
    },
    setToken: (token) => {
      load();
      const current = status();
      if (token.length === 0) return current;
      memory = token;
      if (current.persistent) {
        file.write(encryption.encrypt(token));
      } else {
        // Never leave an older ciphertext behind a token that was not written.
        file.remove();
      }
      return current;
    },
    deleteToken: () => {
      loaded = true;
      memory = null;
      file.remove();
    },
    status,
  };
}

/** The file half, atomic and owner-only. */
export function sessionFileAt(userData: string): SessionFile {
  const target = path.join(userData, SESSION_FILE);
  return {
    read: () => {
      try {
        return readFileSync(target);
      } catch {
        return null;
      }
    },
    write: (data) => {
      mkdirSync(userData, { recursive: true });
      const temp = `${target}.${process.pid}.tmp`;
      writeFileSync(temp, data, { mode: 0o600 });
      renameSync(temp, target);
    },
    remove: () => {
      rmSync(target, { force: true });
    },
  };
}

/** The platform name for a backend `safeStorage` does not name itself. */
export function platformBackend(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "keychain";
  if (platform === "win32") return "dpapi";
  return "unknown";
}
