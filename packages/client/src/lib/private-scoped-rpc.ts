import { createTRPCClient, httpLink } from "@trpc/client";
import type { AppRouter } from "@starter/server/trpc";
import { REQUIRES_API_LEVEL, type Capability } from "@starter/shared";
import { versionHeaders } from "@starter/core";
import { privateClientScope } from "./private-client-scope";
import { currentServerApiLevel } from "./server-level";
import { whenApiOriginReady } from "./api-origin";
import { getNativeToken } from "./native-session";
import { clientId } from "./shell";
import { APP_VERSION } from "./app-version";
/** A dedicated fixed-origin channel, outside legacy queues and batched app
 * requests. Unknown server versions never select an optimistic fallback. */
export function privateScopedRpc(userId: string, capability: Capability) {
  return privateBoundRpc(privateClientScope(userId), capability);
}
/** Confirmation-authenticated device restore can fetch ciphertext before keys
 * become the active application session. Its caller must retain scope checks. */
export function privateBoundRpc(binding: ReturnType<typeof privateClientScope>, capability: Capability) {
  binding.check();
  const supported = () => {
    binding.check(); const level = currentServerApiLevel();
    if (typeof level !== "number" || !Number.isSafeInteger(level) || level < REQUIRES_API_LEVEL[capability]) throw new Error("Confirm this server supports this encrypted data protocol before syncing");
  };
  const rpc = createTRPCClient<AppRouter>({ links: [httpLink({ url: `${binding.server}/api/trpc`,
    headers: () => { supported(); return { ...versionHeaders(APP_VERSION), "x-trackyourtime-client": clientId() }; },
    fetch: async (url, input) => {
      await whenApiOriginReady(); supported();
      const target = new URL(String(url));
      if (target.origin !== binding.server || !target.pathname.startsWith("/api/trpc/")) throw new Error("Private request belongs to another server");
      const headers = new Headers(input?.headers), token = getNativeToken();
      if (token) headers.set("authorization", `Bearer ${token}`); else headers.delete("authorization");
      const response = await fetch(url, { ...input, headers, credentials: token ? "omit" : "include", cache: "no-store", redirect: "error" });
      supported(); return response;
    },
  })] });
  return { rpc, supported, binding };
}
