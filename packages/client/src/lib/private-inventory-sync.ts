import { createTRPCClient, httpLink } from "@trpc/client";
import type { AppRouter } from "@starter/server/trpc";
import { REQUIRES_API_LEVEL } from "@starter/shared";
import { createPrivateAccountInventorySync, decodeSecret, versionHeaders, type KeyValueStorage, type PrivateInventoryTransport, type QueueExclusive } from "@starter/core";
import { privateDataOrigin, privateOperationScope, privateSession, privateSessionVersion } from "./private-session";
import { privateAccountInventoryStorageHost } from "./private-replica";
import { currentServerApiLevel } from "./server-level";
import { whenApiOriginReady } from "./api-origin";
import { getNativeToken } from "./native-session";
import { clientId } from "./shell";
import { APP_VERSION } from "./app-version";

/** A primitive session epoch deliberately avoids retaining an unlocked root in
 * long-lived stores or verified-value callbacks. Reopen after every unlock. */
function binding(userId: string) {
  const server = privateDataOrigin(), version = privateSessionVersion(), captured = privateOperationScope(userId);
  const check = () => {
    captured();
    if (privateDataOrigin() !== server || privateSessionVersion() !== version || !privateSession(userId)) throw new Error("Private account changed during inventory sync");
  };
  const current = () => { try { check(); return true; } catch { return false; } };
  check(); return { server, check, current };
}
/** Always use the account-wide host lock. This adapter does not enroll or
 * recover a missing profile automatically and never uses a plaintext queue. */
export async function privateAccountWorkspaceInventorySync(userId: string, storage: KeyValueStorage, exclusive: QueueExclusive) {
  const { server, check, current } = binding(userId);
  const sync = await createPrivateAccountInventorySync({ server, userId, storage, exclusive, capture: () => { check(); return check; },
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
  const { server, check } = binding(userId);
  const supported = () => {
    check(); const level = currentServerApiLevel();
    if (level === null || level < REQUIRES_API_LEVEL["privacy.accountInventory"]) throw new Error("Confirm this server supports encrypted account inventory before syncing");
  };
  const rpc = createTRPCClient<AppRouter>({ links: [httpLink({ url: `${server}/api/trpc`,
    headers: () => { supported(); return { ...versionHeaders(APP_VERSION), "x-trackyourtime-client": clientId() }; },
    fetch: async (url, input) => {
      await whenApiOriginReady(); supported();
      const headers = new Headers(input?.headers), token = getNativeToken();
      if (token) headers.set("authorization", `Bearer ${token}`); else headers.delete("authorization");
      const response = await fetch(url, { ...input, headers, credentials: token ? "omit" : "include", cache: "no-store", redirect: "error" });
      supported(); return response;
    },
  })] });
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
