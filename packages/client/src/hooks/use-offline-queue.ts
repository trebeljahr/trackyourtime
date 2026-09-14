"use client";

import * as React from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { WorkspaceSummary } from "@starter/core";

import { toast } from "@/components/ui/sonner";
import { translate } from "@/i18n/translate";
import { OFFLINE_QUEUED_MUTATION } from "@/lib/query-client";
import { trpc } from "@/lib/trpc";
import {
  applyWorkspaceList,
  registerWorkspaceListRefetch,
  resetWorkspaceCaches,
} from "@/lib/active-workspace";
import {
  adoptUnstampedOfflineRows,
  flushOfflineQueue,
  getForeignCount,
  getPendingCount,
  getServerForeignCount,
  getServerPendingCount,
  isAuthError,
  isNetworkError,
  isNotFoundError,
  isOnline,
  refreshPendingCount,
  setOfflineQueueOwner,
  subscribePending,
  type OfflineMutation,
} from "@/lib/offline";
import { useAuth } from "@/providers/auth-provider";
import { useSyncStatus } from "@/hooks/use-sync";
import {
  replayOfflineMutation,
  StaleQueuedStopError,
  type OfflineReplayMutators,
  type ReplayIdMap,
} from "@/hooks/replay-offline-mutation";
import { idleWatcher } from "@/lib/idle-watcher";
import {
  getServerNetworkOnline,
  subscribeNetwork,
} from "@/mobile/network";

export type OfflineQueueState = {
  /** Number of this account's mutations waiting to reach the server. */
  pending: number;
  /**
   * Mutations queued by a DIFFERENT account on this device — someone who
   * signed out (or was signed out) before their queue drained. They are kept,
   * never replayed under this session, and surfaced so the device does not
   * quietly sit on somebody's unsynced time.
   */
  foreign: number;
  online: boolean;
  isFlushing: boolean;
  /**
   * The queue stopped because the server does not recognise this client's
   * session. Nothing was dropped — the rows are still there and will replay
   * after a sign-in.
   */
  authBlocked: boolean;
  /** Replay the queue now. Safe to call when it is empty or already running. */
  flush: () => Promise<void>;
};

// ── online/offline, as an external store ─────────────────────────────

/*
 * The window `online`/`offline` events were the whole story here. They are
 * still the story in a browser, but in WKWebView they do not fire for airplane
 * mode and `navigator.onLine` lies about the radio, so the subscription now
 * goes through `mobile/network.ts` — which listens to the OS on native and to
 * exactly these two events everywhere else.
 */
const getOnline = (): boolean => isOnline();

/**
 * Take a membership list: re-resolve the active workspace, and if it moved
 * because the one on screen is gone, clear its caches and say so. Then adopt
 * legacy rows into the active workspace and recount. Returns the membership
 * set a flush filters by.
 *
 * Idempotent — the query effect and a flush both call it with the same list,
 * and only the first call sees a change.
 */
export const takeWorkspaceListFor = async (
  list: readonly WorkspaceSummary[],
  forUser: string,
  queryClient: QueryClient
): Promise<ReadonlySet<string>> => {
  const outcome = await applyWorkspaceList(list, forUser);
  // A first list (requests named no workspace, and the server resolved the
  // default) changes nothing on screen, so only a real move resets.
  if (outcome.changed && outcome.previousId !== null) {
    await resetWorkspaceCaches(queryClient);
  }
  if (outcome.lost !== null) {
    toast.error(translate("shell")("workspace.lost", { name: outcome.lost.name }));
  }
  if (outcome.activeId !== null) {
    await adoptUnstampedOfflineRows(outcome.activeId);
  }
  await refreshPendingCount();
  return new Set(list.map((workspace) => workspace.id));
};

/**
 * The pending-mutation queue, wired to the things that mean "the network is
 * back": the browser's `online` event and the sync socket reopening. A flush
 * replays in order and stops at the first mutation that still cannot reach the
 * server, so ordering is never broken by a partial retry.
 */
export const useOfflineQueue = (): OfflineQueueState => {
  const utils = trpc.useUtils();
  const queryClient = useQueryClient();
  const syncStatus = useSyncStatus();
  const userId = useAuth().user?.id ?? null;
  const userIdRef = React.useRef(userId);
  React.useEffect(() => {
    userIdRef.current = userId;
  }, [userId]);

  /*
   * The workspace list, owned here because the queue is what needs it first:
   * a flush cannot decide which rows are replayable without it, and this hook
   * is mounted exactly once per tab. The switcher reads the result from
   * `lib/active-workspace.ts` rather than running a second copy.
   */
  const workspacesQuery = trpc.workspaces.list.useQuery(undefined, {
    enabled: userId !== null,
    staleTime: 60_000,
  });
  const { refetch: refetchWorkspaces } = workspacesQuery;

  const takeWorkspaceList = React.useCallback(
    (
      list: readonly WorkspaceSummary[],
      forUser: string
    ): Promise<ReadonlySet<string>> =>
      takeWorkspaceListFor(list, forUser, queryClient),
    [queryClient]
  );
  const takeWorkspaceListRef = React.useRef(takeWorkspaceList);
  React.useEffect(() => {
    takeWorkspaceListRef.current = takeWorkspaceList;
  }, [takeWorkspaceList]);

  React.useEffect(() => {
    const list = workspacesQuery.data;
    if (list === undefined || userId === null) return;
    void takeWorkspaceList(list, userId);
  }, [takeWorkspaceList, userId, workspacesQuery.data]);

  React.useEffect(
    () => registerWorkspaceListRefetch(() => void refetchWorkspaces()),
    [refetchWorkspaces]
  );

  const pending = React.useSyncExternalStore(
    subscribePending,
    getPendingCount,
    getServerPendingCount
  );
  const foreign = React.useSyncExternalStore(
    subscribePending,
    getForeignCount,
    getServerForeignCount
  );
  const online = React.useSyncExternalStore(
    subscribeNetwork,
    getOnline,
    getServerNetworkOnline
  );

  const [isFlushing, setIsFlushing] = React.useState(false);
  const [authBlocked, setAuthBlocked] = React.useState(false);

  /*
   * The replay's own mutations, and they need `networkMode: "always"` for a
   * different reason than the ones that fill the queue.
   *
   * `flush()` checks `isOnline()` before it starts, but a radio can die
   * mid-flush — that is the ordinary case on a phone. A paused mutation never
   * settles, so `mutateAsync` would hang forever inside the flush loop:
   * `runningRef` stays latched, the `finally` never runs, and nothing in this
   * launch can flush the queue again. Rejecting is what lets `isNetworkError`
   * stop the flush and write the remainder back in order.
   */
  const startMutation = trpc.entries.start.useMutation(OFFLINE_QUEUED_MUTATION);
  const stopMutation = trpc.entries.stop.useMutation(OFFLINE_QUEUED_MUTATION);
  const createMutation = trpc.entries.create.useMutation(OFFLINE_QUEUED_MUTATION);
  const updateMutation = trpc.entries.update.useMutation(OFFLINE_QUEUED_MUTATION);
  const removeMutation = trpc.entries.remove.useMutation(OFFLINE_QUEUED_MUTATION);
  const discardMutation = trpc.entries.discard.useMutation(OFFLINE_QUEUED_MUTATION);

  const mutators: OfflineReplayMutators = React.useMemo(
    () => ({
      "entries.start": (input) => startMutation.mutateAsync(input),
      "entries.stop": (input) => stopMutation.mutateAsync(input),
      "entries.create": (input) => createMutation.mutateAsync(input),
      "entries.update": (input) => updateMutation.mutateAsync(input),
      "entries.remove": (input) => removeMutation.mutateAsync(input),
      "entries.discard": (input) => discardMutation.mutateAsync(input),
    }),
    [
      startMutation,
      stopMutation,
      createMutation,
      updateMutation,
      removeMutation,
      discardMutation,
    ]
  );

  const dispatch = React.useCallback(
    // `idleWatcher` is the tab's module singleton, so it is stable across
    // renders and deliberately not a dependency.
    async (
      mutation: OfflineMutation,
      context: { createdAt: string; resolved: ReplayIdMap }
    ): Promise<void> =>
      replayOfflineMutation(mutators, idleWatcher, mutation, context),
    [mutators]
  );

  // Listeners are registered once; they read the latest dispatch through refs
  // so a re-render never rebinds the window events mid-flush.
  const dispatchRef = React.useRef(dispatch);
  const utilsRef = React.useRef(utils);
  const runningRef = React.useRef(false);

  React.useEffect(() => {
    dispatchRef.current = dispatch;
  }, [dispatch]);

  React.useEffect(() => {
    utilsRef.current = utils;
  }, [utils]);

  const flush = React.useCallback(async (): Promise<void> => {
    if (runningRef.current) return;
    if ((await refreshPendingCount()) === 0) return;
    if (!isOnline()) return;
    const forUser = userIdRef.current;
    if (forUser === null) return;

    runningRef.current = true;
    setIsFlushing(true);

    /*
     * Ask which workspaces this account is in BEFORE sending anything, and
     * do not flush without an answer. The last known list could be a day old:
     * a row for a workspace the person was removed from since would be sent,
     * refused as NOT_FOUND, and dropped — tracked time deleted by a toast.
     * Held rows are the ones the answer no longer contains.
     */
    let members: ReadonlySet<string>;
    try {
      const list = await utilsRef.current.workspaces.list.fetch();
      members = await takeWorkspaceListRef.current(list, forUser);
    } catch {
      runningRef.current = false;
      setIsFlushing(false);
      return;
    }

    let applied = 0;
    let rejected = 0;
    let stale = 0;
    let blocked = false;

    // One map for the whole flush: a start and the stop that ends it are
    // queued as a pair, and the stop becomes targetable the instant the start
    // ahead of it lands.
    const resolved: ReplayIdMap = new Map();

    try {
      const result = await flushOfflineQueue(async (mutation, meta) => {
        try {
          await dispatchRef.current(mutation, {
            createdAt: meta.createdAt,
            resolved,
          });
          applied += 1;
        } catch (error) {
          // Still unreachable — stop here so the rest keeps its order.
          if (isNetworkError(error)) throw error;
          // A stop from days ago that names no entry. Dropping it is right —
          // it would otherwise end whatever is running now — but it is the
          // user's tracked time, so it is said out loud rather than binned.
          if (error instanceof StaleQueuedStopError) {
            stale += 1;
            return;
          }
          // The session is gone (expired, or signed out from another device).
          // UNAUTHORIZED only: a FORBIDDEN is a refusal of this one row by a
          // valid session (a role change) and falls through to `rejected`
          // below, so it cannot wedge the rest of the queue behind it.
          // Also a stop, not a drop: the request arrived, but "we do not know
          // who you are" is no verdict on the user's tracked time. Throwing
          // leaves this row and everything behind it in the queue — see
          // `createOfflineQueue.flush`, which writes the remainder back.
          if (isAuthError(error)) {
            blocked = true;
            throw error;
          }
          // A NOT_FOUND on a stamped row can mean "you were removed from this
          // workspace" as much as "that entry is gone": the list asked for
          // above is only as fresh as the start of the flush, and a flush of
          // many rows takes a while. Ask again, and keep the row — stopping
          // the flush here — unless its workspace is demonstrably still a
          // membership. The next flush then holds it by the filter instead of
          // this one deleting it. Applied without the adoption step
          // (`takeWorkspaceListFor`): that needs the queue this flush holds.
          if (isNotFoundError(error) && mutation.workspaceId !== undefined) {
            const fresh = await utilsRef.current.workspaces.list
              .fetch()
              .catch(() => null);
            if (fresh !== null) await applyWorkspaceList(fresh, forUser);
            if (
              fresh === null ||
              !fresh.some((workspace) => workspace.id === mutation.workspaceId)
            ) {
              throw error;
            }
          }
          // The server refused it on the merits (validation, a permission a
          // role change took away). The server wins: drop the mutation and
          // let the invalidation below pull the authoritative state back.
          rejected += 1;
        }
      }, { memberWorkspaceIds: members });

      setAuthBlocked(blocked);

      /*
       * Say something when a row is lost.
       *
       * Both counters mean "the user tracked this and it is not going to
       * exist". Silently deleting somebody's time and then invalidating the
       * caches so the day looks emptier than they remember is the worst
       * possible way to handle it.
       */
      const t = translate("tracker");
      if (rejected > 0) {
        toast.error(t("offlineQueue.rejected", { count: rejected }), {
          description: t("offlineQueue.rejectedDescription"),
        });
      }
      if (stale > 0) {
        toast.error(t("offlineQueue.stale", { count: stale }), {
          description: t("offlineQueue.staleDescription"),
        });
      }

      if (applied > 0 || rejected > 0 || stale > 0 || result.flushed > 0) {
        await utilsRef.current.entries.invalidate();
        await utilsRef.current.reports.invalidate();
      }
    } finally {
      runningRef.current = false;
      setIsFlushing(false);
    }
  }, []);

  const flushRef = React.useRef(flush);
  React.useEffect(() => {
    flushRef.current = flush;
  }, [flush]);

  React.useEffect(() => {
    void refreshPendingCount();

    // Through `subscribeNetwork` rather than `window.addEventListener("online")`
    // so this fires when a phone leaves airplane mode, which WKWebView does not
    // report as an `online` event at all.
    return subscribeNetwork(() => {
      if (!isOnline()) return;
      void flushRef.current();
    });
  }, []);

  // The socket reopening is the earliest reliable "we are back" signal —
  // earlier than the next user action, and more trustworthy than navigator.
  React.useEffect(() => {
    if (syncStatus !== "open") return;
    void flushRef.current();
  }, [syncStatus]);

  // `authBlocked` is only ever reassigned by a flush that reaches its own
  // `setAuthBlocked`, so a queue drained by any other path (a successful
  // mutation clearing the last row, a sign-out that resets it) would leave the
  // flag stuck true and the tracker bar accusing a signed-in user. Nothing is
  // blocked when nothing is queued, so derive it rather than tracking it.
  /*
   * Tell the queue whose rows it is holding, and flush once it knows.
   *
   * Until an account is resolved the flush filter replays nothing at all —
   * which is the safe default, and also means the socket-open and network-back
   * flushes above can fire before `useSession()` has answered (routinely, on a
   * cold native launch waiting on the Keychain) and do nothing. So this effect
   * owns the flush that follows a sign-in, rather than relying on another
   * event to come along afterwards.
   */
  React.useEffect(() => {
    let cancelled = false;
    void setOfflineQueueOwner(userId).then(() => {
      if (cancelled || userId === null) return;
      void flushRef.current();
    });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  return {
    pending,
    foreign,
    online,
    isFlushing,
    authBlocked: authBlocked && pending > 0,
    flush,
  };
};
