import { createPrivateAccountInventorySync, decodeSecret, PRIVATE_ACCOUNT_INVENTORY_SCOPE } from "@starter/core";
import { openPrivateIndexedStorage } from "./private-indexed-storage";
import { requirePrivateRouting } from "./private-routing-requirement";
import type { UnlockedIdentity } from "./private-session";
/** A locally confirmed setup or device payload may verify/save an inventory
 * without exposing its temporary keys as an unlocked application session. */
export async function stagePrivateAccountInventory(scope: { server: string; userId: string }, secrets: UnlockedIdentity, check: () => void) {
  check(); const host = await openPrivateIndexedStorage(scope);
  const current = () => { try { check(); return true; } catch { return false; } };
  try {
    check();
    const sync = await createPrivateAccountInventorySync({ ...scope, storage: host.storage, exclusive: host.exclusive(PRIVATE_ACCOUNT_INVENTORY_SCOPE), capture: () => { check(); return check; },
      beforePrivateState: (phase, digest) => requirePrivateRouting(scope, current, phase === "publish", digest),
      resolveStorageKey: () => { check(); const key = decodeSecret(secrets.master, 32); return { key, current, release: () => key.fill(0) }; },
      resolveIdentity: () => {
        check(); const master = decodeSecret(secrets.master, 32), { kty, crv, x, y } = secrets.signingPrivateKey;
        return { master, signingPrivateKey: secrets.signingPrivateKey, signingPublicKey: { kty, crv, x, y }, current, release: () => master.fill(0) };
      },
    });
    check(); return { ...sync, close: host.close };
  } catch (error) { host.close(); throw error; }
}
