import { createPrivateAccountInventorySync, decodeSecret, type KeyValueStorage, type PrivateInventoryTransport, type QueueExclusive } from "@starter/core";
import { privateSession } from "./private-session";
import { privateAccountInventoryStorageHost } from "./private-replica";
import { privateClientScope as binding } from "./private-client-scope";
import { privateScopedRpc } from "./private-scoped-rpc";
import { requirePrivateRouting } from "./private-routing-requirement";
/** Always use the account-wide host lock. This adapter does not enroll or
 * recover a missing profile automatically and never uses a plaintext queue. */
export async function privateAccountWorkspaceInventorySync(userId: string, storage: KeyValueStorage, exclusive: QueueExclusive) {
  const { server, check, current } = binding(userId);
  const sync = await createPrivateAccountInventorySync({ server, userId, storage, exclusive, capture: () => { check(); return check; },
    beforePrivateState: (phase, digest) => requirePrivateRouting({ server, userId }, current, phase === "publish", digest),
    resolveStorageKey: () => {
      check(); const key = decodeSecret(privateSession(userId)!.master, 32);
      return { key, current, release: () => key.fill(0) };
    },
    resolveIdentity: () => {
      check(); const root = privateSession(userId)!, master = decodeSecret(root.master, 32), { kty, crv, x, y } = root.signingPrivateKey;
      return { master, signingPrivateKey: root.signingPrivateKey, signingPublicKey: { kty, crv, x, y }, current, release: () => master.fill(0) };
    },
  });
  check(); return sync;
}
/** Dedicated fixed-origin, non-batched POST transport. Check again at actual
 * dispatch, after native readiness, so a delayed request cannot follow a server
 * switch or a new unlock. No optimistic unknown-version or legacy fallback. */
export function privateAccountInventoryTransport(userId: string): PrivateInventoryTransport {
  const { rpc, supported } = privateScopedRpc(userId, "privacy.accountInventory");
  return {
    commit: async (signed) => { supported(); const result = await rpc.privacy.inventoryWrite.mutate({ signed }); supported(); return result; },
    versions: async (input) => { supported(); const result = await rpc.privacy.inventoryVersions.mutate(input); supported(); return result; },
  };
}
/** Infrastructure only: no conversion controller or app mode routing is mounted
 * here. Closing a host keeps encrypted pending work for the next unlock. */
export async function openPrivateAccountInventorySync(userId: string) {
  const { check } = binding(userId), host = await privateAccountInventoryStorageHost(userId);
  try {
    check(); const sync = await privateAccountWorkspaceInventorySync(userId, host.storage, host.exclusive), transport = privateAccountInventoryTransport(userId); check();
    return { ...sync, close: host.close, pull: (through?: number) => sync.pull(transport, through), flushOne: () => sync.flushOne(transport) };
  } catch (error) { host.close(); throw error; }
}
