import { createPrivateAccountTimerStore, decodeSecret, PRIVATE_ACCOUNT_TIMER_SCOPE } from "@starter/core";
import { openPrivateIndexedStorage } from "./private-indexed-storage";
import type { UnlockedIdentity } from "./private-session";
/** Save setup/device-confirmed pins before publishing an unlocked session. No
 * API mode, empty feed or imported key alone can initialize an empty timer. */
export async function stagePrivateAccountTimer(scope: { server: string; userId: string }, secrets: UnlockedIdentity, check: () => void) {
  const binding = { ...scope }, master = secrets.master, { kty, crv, x, y } = secrets.signingPrivateKey;
  check(); const host = await openPrivateIndexedStorage(binding); let closed = false;
  const guard = () => { check(); if (closed) throw new Error("Account timer staging was closed"); };
  const current = () => { try { guard(); return true; } catch { return false; } };
  const close = () => { closed = true; host.close(); };
  try {
    guard();
    const store = await createPrivateAccountTimerStore({ scope: binding, storage: host.storage, exclusive: host.exclusive(PRIVATE_ACCOUNT_TIMER_SCOPE), signingPublicKey: { kty, crv, x, y }, capture: () => { guard(); return guard; },
      resolveStorageKey: () => { guard(); const key = decodeSecret(master, 32); return { key, current, release: () => key.fill(0) }; },
    });
    guard(); return { ...store, close };
  } catch (error) { close(); throw error; }
}
