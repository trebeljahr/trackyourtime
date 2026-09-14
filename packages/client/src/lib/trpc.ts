import { createTRPCReact } from "@trpc/react-query";
import { httpBatchLink, type TRPCLink } from "@trpc/client";
import { withWorkspaceId } from "@starter/core";
import type { AppRouter } from "@starter/server/trpc";
import { isNative } from "@/mobile/bridge";
import { getNativeToken } from "@/lib/native-session";
import { rebaseApiUrl, whenApiOriginReady } from "@/lib/api-origin";
import {
  getActiveWorkspaceId,
  isActiveWorkspaceReady,
  whenActiveWorkspaceReady,
} from "@/lib/active-workspace";

export const trpc = createTRPCReact<AppRouter>();

/**
 * Stands in for the workspace on an operation that left before the native
 * shell had read its stored choice. Replaced — or removed — by the fetch
 * wrapper once the read lands; it never reaches a server.
 */
export const PENDING_WORKSPACE = "trackyourtime:pending-workspace";

/**
 * Address every operation to this device's active workspace
 * (`lib/active-workspace.ts`), unless it already names one.
 *
 * Never over an explicit value: a replayed offline row carries the workspace
 * it was queued in (`replayOfflineMutation`), and filling that in with the
 * CURRENT workspace is precisely how a start queued in A would land in B.
 * Inputs that are not objects are left alone (`withWorkspaceId`).
 *
 * The React Query key is built from the input a component passes, above this
 * link, so it does not include the workspace — which is why a switch has to
 * reset the cache (`resetWorkspaceCaches`) rather than rely on new keys.
 */
export const workspaceLink = (): TRPCLink<AppRouter> => () => ({ op, next }) => {
  const input = isActiveWorkspaceReady()
    ? withWorkspaceId(op.input, getActiveWorkspaceId())
    : withWorkspaceId(op.input, PENDING_WORKSPACE);
  return next(input === op.input ? op : { ...op, input });
};

/** Replace (or drop) the pending marker in one batched input object. */
const settleInputs = (batch: unknown, workspaceId: string | null): unknown => {
  if (typeof batch !== "object" || batch === null) return batch;
  const settled: Record<string, unknown> = {};
  for (const [index, input] of Object.entries(batch)) {
    if (
      typeof input === "object" &&
      input !== null &&
      (input as { workspaceId?: unknown }).workspaceId === PENDING_WORKSPACE
    ) {
      const { workspaceId: _pending, ...rest } = input as Record<string, unknown>;
      void _pending;
      settled[index] = workspaceId === null ? rest : { ...rest, workspaceId };
    } else {
      settled[index] = input;
    }
  }
  return settled;
};

/**
 * Settle the pending marker in a batched request, once the stored workspace is
 * known. Exported for the test; the marker only ever appears on the native
 * shells, so on web this is never reached with one.
 */
export const settlePendingWorkspace = (
  url: string,
  init: RequestInit | undefined,
  workspaceId: string | null
): { url: string; init: RequestInit | undefined } => {
  const marker = JSON.stringify(PENDING_WORKSPACE).slice(1, -1);
  const bodyHasMarker =
    typeof init?.body === "string" && init.body.includes(marker);
  const parsed = new URL(url, "http://placeholder.invalid");
  const query = parsed.searchParams.get("input");
  const urlHasMarker = query !== null && query.includes(marker);
  if (!bodyHasMarker && !urlHasMarker) return { url, init };

  let nextUrl = url;
  if (urlHasMarker && query !== null) {
    parsed.searchParams.set(
      "input",
      JSON.stringify(settleInputs(JSON.parse(query), workspaceId))
    );
    nextUrl = url.startsWith("http")
      ? parsed.toString()
      : `${parsed.pathname}${parsed.search}`;
  }
  const nextInit =
    bodyHasMarker && init !== undefined && typeof init.body === "string"
      ? {
          ...init,
          body: JSON.stringify(settleInputs(JSON.parse(init.body), workspaceId)),
        }
      : init;
  return { url: nextUrl, init: nextInit };
};

export function getTRPCClient() {
  return trpc.createClient({
    links: [
      workspaceLink(),
      httpBatchLink({
        url: `${process.env.NEXT_PUBLIC_API_URL || ""}/api/trpc`,
        /**
         * The native shells authenticate with a bearer token, not a cookie: a
         * `capacitor://localhost` document is cross-site to the API whatever
         * SameSite says. With no token — every web request — this is exactly
         * `credentials: "include"` and no `authorization` header, which
         * `src/lib/trpc.test.ts` asserts rather than assumes.
         */
        fetch(url, options) {
          if (!isNative()) {
            const token = getNativeToken();
            return fetch(url, {
              ...options,
              credentials: token ? "omit" : "include",
            });
          }
          // The phone apps choose their server at runtime (`lib/api-origin.ts`).
          // The link above keeps the build-time URL; the request is rebased
          // here, and only once the stored choice has been read, so nothing
          // can leave for a server the person has already moved away from.
          // The workspace choice is read the same way, and an operation that
          // got ahead of it has its marker settled before it leaves.
          return Promise.all([
            whenApiOriginReady(),
            whenActiveWorkspaceReady(),
          ]).then(() => {
            const token = getNativeToken();
            const settled = settlePendingWorkspace(
              String(url),
              options as RequestInit | undefined,
              getActiveWorkspaceId()
            );
            return fetch(rebaseApiUrl(settled.url), {
              ...settled.init,
              credentials: token ? "omit" : "include",
            });
          });
        },
        headers: () => {
          const token = getNativeToken();
          return {
            "x-trackyourtime-client": isNative() ? "trackyourtime-mobile" : "web",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          };
        },
      }),
    ],
  });
}
