import { createTRPCReact } from "@trpc/react-query";
import { TRPCClientError, httpBatchLink, httpBatchStreamLink, splitLink, type TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import { REQUIRES_API_LEVEL } from "@starter/shared";
import { durableRequestSignal, durableEntryEnvelope, isDurableEntryOp, assertEntryClientSupported, CLIENT_TOO_OLD, versionHeaders, withWorkspaceId } from "@starter/core";
import type { AppRouter } from "@starter/server/trpc";
import { clientId, isTokenShell } from "@/lib/shell";
import { getNativeToken } from "@/lib/native-session";
import { rebaseApiUrl, whenApiOriginReady } from "@/lib/api-origin";
import {
  getActiveWorkspaceId,
  isActiveWorkspaceReady,
  whenActiveWorkspaceReady,
} from "@/lib/active-workspace";
import { APP_VERSION } from "@/lib/app-version";
import { currentServerApiLevel, noteClientTooOld } from "@/lib/server-level";

import { submitDurableEntry } from "@/lib/offline";
import { fetchSyncSnapshot, trackSyncQuery } from "@/lib/sync-reconciliation";
import { assertStandardContentRequest, currentWorkspaceContentRoute, isWorkspaceContentProcedure, readPrivateWorkspaceQuery } from "./private-content-route";
import { readWorkspaceList } from "./private-workspace-list";
import { capturePrivateRequestScope, checkPrivateRequestScope, privateRequestScopeHeaders } from "./private-request-scope";
import { mutatePrivateWorkspace } from "./private-workspace-mutation";
import { preparePrivateWorkspaceCreation } from "./private-workspace-creation";

export const trpc = createTRPCReact<AppRouter>();

/** New clients retain read compatibility with older self-hosted servers. */
export const compatibleReadsLink = (): TRPCLink<AppRouter> => () => {
  const legacy = new Set<string>();
  const required = REQUIRES_API_LEVEL["catalog.options"];
  return ({ op, next }) => {
    const level = currentServerApiLevel();
    const legacyKey = `${level}:${op.path}`;
    const fallback = ({
      "projects.options": "projects.list",
      "clients.options": "clients.list",
      "tasks.options": "tasks.list",
      "reports.rows": "reports.detailed",
      "reports.totals": "reports.detailed",
    } as Record<string, string>)[op.path];
    if (op.type !== "query" || (!fallback && op.path !== "tasks.projectLinks")) return next(op);
    return observable((observer) => {
      let subscription: { unsubscribe: () => void } | undefined;
      const readLegacy = () => {
        if (fallback) subscription = next({ ...op, path: fallback, context: { ...op.context, independent: op.path === "reports.rows" } }).subscribe(observer);
        else { observer.next({ result: { data: {} } }); observer.complete(); }
      };
      if ((level !== null && level < required) || legacy.has(legacyKey)) readLegacy();
      else subscription = next(op).subscribe({
        next: (value) => observer.next(value),
        complete: () => observer.complete(),
        error: (error) => {
          // A modern server's NOT_FOUND can mean revoked workspace access.
          if (error.data?.code !== "NOT_FOUND" || (level !== null && level >= required)) { observer.error(error); return; }
          legacy.add(legacyKey);
          readLegacy();
        },
      });
      return () => subscription?.unsubscribe();
    });
  };
};

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
  assertEntryClientSupported(op.path, op.input, currentServerApiLevel());
  const input = isActiveWorkspaceReady()
    ? withWorkspaceId(op.input, getActiveWorkspaceId())
    : withWorkspaceId(op.input, PENDING_WORKSPACE);
  return next(input === op.input ? op : { ...op, input });
};

export const privateWorkspaceCreationLink = (): TRPCLink<AppRouter> => () => ({ op, next }) => {
  if (op.path !== "workspaces.create" || op.type !== "mutation") return next(op);
  return observable((observer) => {
    const abort = new AbortController(); let subscription: { unsubscribe: () => void } | undefined;
    let prepared: Awaited<ReturnType<typeof preparePrivateWorkspaceCreation>> = null;
    void (async () => {
      const originalScope = capturePrivateRequestScope(), originalInput = structuredClone(op.input);
      await Promise.all([whenApiOriginReady(), whenActiveWorkspaceReady()]);
      if (abort.signal.aborted) return;
      checkPrivateRequestScope(originalScope);
      prepared = await preparePrivateWorkspaceCreation(originalInput, abort.signal);
      checkPrivateRequestScope(originalScope);
      if (abort.signal.aborted) return;
      if (!prepared) { subscription = next({ ...op, input: originalInput, context: { ...op.context, privateCreationScope: originalScope } }).subscribe(observer); return; }
      const result = await new Promise<Parameters<typeof observer.next>[0]>((resolve, reject) => {
        const cancel = () => reject(new Error("Workspace creation canceled"));
        abort.signal.addEventListener("abort", cancel, { once: true });
        subscription = next({ ...op, input: prepared!.input, context: { ...op.context, privateCreationScope: originalScope } }).subscribe({
          next: (value) => { abort.signal.removeEventListener("abort", cancel); resolve(value); },
          error: (error) => { abort.signal.removeEventListener("abort", cancel); reject(error); },
          complete: () => { abort.signal.removeEventListener("abort", cancel); reject(new Error("Workspace creation returned no data")); },
        });
      });
      const accepted = await prepared.accept("data" in result.result ? result.result.data : undefined);
      checkPrivateRequestScope(originalScope);
      if (!abort.signal.aborted) { observer.next({ result: { data: accepted } }); observer.complete(); }
    })().catch((error) => { if (!abort.signal.aborted) observer.error(TRPCClientError.from(error)); }).finally(() => prepared?.close());
    return () => { abort.abort(); subscription?.unsubscribe(); prepared?.close(); };
  });
};

/** Account-wide private navigation resolves before any standard list request. */
export const privateWorkspaceListLink = (): TRPCLink<AppRouter> => () => ({ op, next }) => {
  if (op.path !== "workspaces.list" || op.type !== "query") return next(op);
  return observable((observer) => {
    const abort = new AbortController(); let subscription: { unsubscribe: () => void } | undefined;
    void (async () => {
      await Promise.all([whenApiOriginReady(), whenActiveWorkspaceReady()]);
      if (abort.signal.aborted) return;
      const value = await readWorkspaceList(() => new Promise((resolve, reject) => {
        const cancel = () => reject(new Error("Workspace lookup canceled"));
        abort.signal.addEventListener("abort", cancel, { once: true });
        subscription = next({ ...op, input: undefined }).subscribe({
          next: (result) => { if (result.result.type === undefined || result.result.type === "data") { abort.signal.removeEventListener("abort", cancel); resolve(result.result.data as never); } },
          error: (error) => { abort.signal.removeEventListener("abort", cancel); reject(error); },
          complete: () => { abort.signal.removeEventListener("abort", cancel); reject(new Error("Workspace list returned no data")); },
        });
      }), abort.signal);
      if (!abort.signal.aborted) { observer.next({ result: { data: value } }); observer.complete(); }
    })().catch((error) => { if (!abort.signal.aborted) observer.error(TRPCClientError.from(error)); });
    return () => { abort.abort(); subscription?.unsubscribe(); };
  });
};

/** Consume private operations before the legacy outbox or transport can see
 * plaintext. Unsupported private operations refuse rather than fall back. */
export const privateContentLink = (): TRPCLink<AppRouter> => () => ({ op, next }) => {
  if (!isWorkspaceContentProcedure(op.path)) return next(op);
  return observable((observer) => {
    let cancelled = false, subscription: { unsubscribe: () => void } | undefined;
    const abort = new AbortController();
    void (async () => {
      const originalScope = capturePrivateRequestScope(), originalInput = structuredClone(op.input);
      await Promise.all([whenApiOriginReady(), whenActiveWorkspaceReady()]);
      if (cancelled) return;
      checkPrivateRequestScope(originalScope);
      const input = originalInput !== null && typeof originalInput === "object" && !Array.isArray(originalInput) ? originalInput as Record<string, unknown> : null;
      const workspaceId = input && typeof input.workspaceId === "string" && input.workspaceId !== PENDING_WORKSPACE ? input.workspaceId : getActiveWorkspaceId();
      const addressed = input?.workspaceId === PENDING_WORKSPACE ? (workspaceId === null ? Object.fromEntries(Object.entries(input).filter(([key]) => key !== "workspaceId")) : { ...input, workspaceId }) : originalInput;
      const route = await currentWorkspaceContentRoute(workspaceId, abort.signal);
      if (cancelled) return;
      checkPrivateRequestScope(originalScope);
      if (route.mode === "encrypted") {
        const value = op.type === "mutation" ? await mutatePrivateWorkspace(route, op.path, addressed) : await readPrivateWorkspaceQuery(route, op.path, addressed, op.type); checkPrivateRequestScope(originalScope); route.check();
        if (!cancelled) { observer.next({ result: { data: value } } as never); observer.complete(); }
      } else {
        route.check(); subscription = next({ ...op, input: addressed, context: { ...op.context, privateContentScope: originalScope } }).subscribe({
          next: (value) => { try { checkPrivateRequestScope(originalScope); route.check(); observer.next(value); } catch (error) { observer.error(TRPCClientError.from(error instanceof Error ? error : new Error("Workspace data changed"))); } },
          error: (error) => observer.error(error), complete: () => observer.complete(),
        });
      }
    })().catch((error) => { if (!cancelled) observer.error(TRPCClientError.from(error)); });
    return () => { cancelled = true; abort.abort(); subscription?.unsubscribe(); };
  });
};

/** Save every supported entry write before the transport sees any bytes. */
export const durableEntryLink = (): TRPCLink<AppRouter> => () => ({ op, next }) => {
  if (op.type !== "mutation" || !isDurableEntryOp(op.path)) return next(op);
  const operation = op.path;
  const input = op.input as Record<string, unknown>;
  return observable((observer) => {
    let cancelled = false;
    void submitDurableEntry(operation, input, (frozen) => new Promise((resolve, reject) => {
      // Do not cancel a submitted request on unmount. Its saved identity also
      // survives process death and a reply lost after the server commits.
      next({ ...op, path: "entries.applyOperation", input: durableEntryEnvelope(operation, frozen) }).subscribe({
        next: resolve,
        error: reject,
      });
    })).then((result) => {
      if (!cancelled) { observer.next(result as never); observer.complete(); }
    }, (error) => {
      if (!cancelled) observer.error(TRPCClientError.from(error));
    });
    return () => { cancelled = true; };
  });
};

/** Track query lifetime through decoding, since streamed fetch ends at headers. */
export const syncSnapshotLink = (): TRPCLink<AppRouter> => () => ({ op, next }) => {
  if (op.type !== "query") return next(op);
  return observable((observer) => {
    const done = trackSyncQuery();
    const subscription = next(op).subscribe({
      next: (value) => { done(); observer.next(value); },
      error: (error) => { done(); observer.error(error); },
      complete: () => { done(); observer.complete(); },
    });
    return () => { done(); subscription.unsubscribe(); };
  });
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

/**
 * True when a tRPC response body refuses this build as `CLIENT_TOO_OLD`
 * (`data.versionRefusal`, docs/versioning.md → Refusals). Reads a batched
 * array as well as a single envelope.
 */
export const isClientTooOldBody = (body: unknown): boolean => {
  const items = Array.isArray(body) ? body : [body];
  return items.some((item) => {
    if (typeof item !== "object" || item === null) return false;
    const error = (item as { error?: unknown }).error;
    if (typeof error !== "object" || error === null) return false;
    const json = (error as { json?: unknown }).json ?? error;
    const data = (json as { data?: unknown }).data;
    return (
      typeof data === "object" &&
      data !== null &&
      (data as { versionRefusal?: unknown }).versionRefusal === CLIENT_TOO_OLD
    );
  });
};

/**
 * Streaming sends headers before procedures finish, so even a refusal can
 * arrive under HTTP 200. Observe decoded errors on both transports instead of
 * cloning/reading a response body (which would wait for the entire batch).
 */
export const versionRefusalLink = (): TRPCLink<AppRouter> => () => ({ op, next }) =>
  observable((observer) => next(op).subscribe({
    next: (value) => observer.next(value),
    complete: () => observer.complete(),
    error: (error) => {
      if (isClientTooOldBody({ error })) noteClientTooOld();
      observer.error(error);
    },
  }));

/** Older WebViews can have fetch without tRPC's stream decoding primitives. */
export const supportsBatchStreaming = (): boolean =>
  typeof ReadableStream !== "undefined" &&
  typeof WritableStream !== "undefined" &&
  typeof TransformStream !== "undefined" &&
  typeof TextDecoderStream !== "undefined" &&
  typeof Response !== "undefined" &&
  "body" in Response.prototype;

/** Disable streaming per client, or with an operation's context.skipStreaming. */
export function getTRPCClient({ streamQueries = true }: { streamQueries?: boolean } = {}): ReturnType<typeof trpc.createClient> {
  const options = {
    url: `${process.env.NEXT_PUBLIC_API_URL || ""}/api/trpc`,
    /**
     * The phone and desktop shells authenticate with a bearer token, not a
     * cookie: a `capacitor://localhost` or `app://-` document is cross-site
     * to the API whatever SameSite says. With no token — every web request — this is exactly
     * `credentials: "include"` and no `authorization` header, which
     * `src/lib/trpc.test.ts` asserts rather than assumes.
     */
    fetch(url: RequestInfo | URL, options?: RequestInit): Promise<Response> {
      if (String(url).includes("entries.applyOperation"))
        options = { ...options, signal: durableRequestSignal(options?.signal) };
      const query = !options?.method || options.method === "GET";
      return fetchSyncSnapshot(query, () => {
        if (!isTokenShell()) {
          const token = getNativeToken();
          const init = {
            ...options,
            credentials: token ? "omit" as const : "include" as const,
          };
          return assertStandardContentRequest(String(url), init).then((check) => { check(); return fetch(url, init); });
        }
        // The token shells choose their server at runtime (`lib/api-origin.ts`).
        // The link above keeps the build-time URL; the request is rebased
        // here, and only once the stored choice has been read, so nothing
        // can leave for a server the person has already moved away from.
        // The workspace choice is read the same way, and an operation that
        // got ahead of it has its marker settled before it leaves.
        return Promise.all([
          whenApiOriginReady(),
          whenActiveWorkspaceReady(),
        ]).then(async () => {
          const token = getNativeToken();
          const settled = settlePendingWorkspace(
            String(url),
            options,
            getActiveWorkspaceId()
          );
          // Capture auth and credentials together after readiness. A token
          // can change while the server/workspace choices are being read.
          const headers = new Headers(settled.init?.headers);
          if (token) headers.set("authorization", `Bearer ${token}`);
          else headers.delete("authorization");
          const target = rebaseApiUrl(settled.url), init = {
            ...settled.init,
            headers,
            credentials: token ? "omit" as const : "include" as const,
          };
          const check = await assertStandardContentRequest(target, init); check(); return fetch(target, init);
        });
      });
    },
    headers: (batch?: { opList: readonly { context: Record<string, unknown> }[] }) => {
      const token = getNativeToken();
      return {
        "x-trackyourtime-client": clientId(),
        // The version handshake (docs/versioning.md). Additive: the
        // client kind above is unchanged, because it decides the device
        // label and the session window.
        ...versionHeaders(APP_VERSION),
        ...privateRequestScopeHeaders(batch?.opList),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      };
    },
  };
  return trpc.createClient({
    links: [
      workspaceLink(),
      privateWorkspaceCreationLink(),
      privateWorkspaceListLink(),
      privateContentLink(),
      durableEntryLink(),
      syncSnapshotLink(),
      versionRefusalLink(),
      compatibleReadsLink(),
      splitLink({
        // Keep report pages independent even on WebViews without streaming.
        condition: (op) => op.path === "reports.rows" || op.context.independent === true,
        true: httpBatchLink(options),
        false: splitLink({
        // Queries do not set response headers. Keep mutations on ordinary
        // JSON batches so their HTTP status/header behavior stays intact.
        // CapacitorHttp patching is disabled in capacitor.config.ts: phones
        // use WebView fetch. Older WebViews fall back without a polyfill.
        condition: (op) => op.type === "query" && streamQueries &&
          op.context.skipStreaming !== true && supportsBatchStreaming(),
        true: httpBatchStreamLink({ ...options, streamHeader: "accept" }),
        false: httpBatchLink(options),
        }),
      }),
    ],
  });
}
