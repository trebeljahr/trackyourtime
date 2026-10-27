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
export function privateScopedRpc(userId: string, capability: Capability, timeoutMs?: number) {
  return privateBoundRpc(privateClientScope(userId), capability, timeoutMs);
}
/** Confirmation-authenticated device restore can fetch ciphertext before keys
 * become the active application session. Its caller must retain scope checks. */
export function privateBoundRpc(binding: ReturnType<typeof privateClientScope>, capability: Capability, timeoutMs?: number) {
  binding.check();
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)) throw new Error("Invalid private request timeout");
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
      const signal = timeoutMs === undefined ? input?.signal : privateRequestTimeout(input?.signal, timeoutMs);
      const response = await fetch(url, { ...input, signal, headers, credentials: token ? "omit" : "include", cache: "no-store", redirect: "error" });
      supported(); return response;
    },
  })] });
  return { rpc, supported, binding };
}

/** Keep the deadline active through response decoding, not just until headers.
 * No key, request body or binding is captured by these abort listeners. */
function privateRequestTimeout(original: AbortSignal | null | undefined, timeoutMs: number) {
  const deadline = typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(timeoutMs) : (() => {
    const controller = new AbortController(); setTimeout(() => controller.abort(new DOMException("Private request timed out", "TimeoutError")), timeoutMs); return controller.signal;
  })();
  if (!original) return deadline;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([original, deadline]);
  const controller = new AbortController();
  const abortOriginal = () => { controller.abort(original.reason); cleanup(); };
  const abortDeadline = () => { controller.abort(deadline.reason); cleanup(); };
  const cleanup = () => { original.removeEventListener("abort", abortOriginal); deadline.removeEventListener("abort", abortDeadline); };
  original.addEventListener("abort", abortOriginal, { once: true }); deadline.addEventListener("abort", abortDeadline, { once: true });
  if (original.aborted) abortOriginal(); else if (deadline.aborted) abortDeadline();
  return controller.signal;
}
