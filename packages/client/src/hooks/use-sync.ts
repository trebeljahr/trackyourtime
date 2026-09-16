"use client";

import * as React from "react";
import {
  createId,
  createSyncClient,
  createTimerStore,
  isOwnActivity,
  resolveSyncUrl,
  startTicking,
  syncEventReach,
  type SyncEventReach,
  type SyncClient,
  type SyncEvent,
  type SyncStatus,
  type TimeEntry,
  type TimerState,
} from "@starter/core";
import { useRouter } from "next/navigation";
import { useNativeSession } from "@/hooks/use-native-session";
import { useAuth } from "@/hooks/use-auth";
import { getActiveWorkspaceId } from "@/lib/active-workspace";
import { onSignOut } from "@/lib/auth-client";
import { useApiOrigin } from "@/hooks/use-api-origin";
import { getApiOrigin } from "@/lib/api-origin";
import { idleWatcher } from "@/lib/idle-watcher";
import { getNativeToken } from "@/lib/native-session";
import { revokeThisDevice } from "@/lib/revoke-this-device";
import { writeRunningMirror } from "@/lib/running-mirror";
import { trpc } from "@/lib/trpc";
import { APP_VERSION } from "@/lib/app-version";

/**
 * Per-tab identity echoed back on every SyncEvent this tab caused, so the
 * originating tab can skip its own broadcast instead of invalidating caches
 * it has already updated.
 */
export const ORIGIN_ID: string = createId();

// ── connection status, shared by every consumer ──────────────────────

type Listener = () => void;

let currentStatus: SyncStatus = "closed";
const statusListeners = new Set<Listener>();

const setStatus = (next: SyncStatus): void => {
  if (next === currentStatus) return;
  currentStatus = next;
  for (const listener of statusListeners) listener();
};

const subscribeStatus = (listener: Listener): (() => void) => {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
};

const getStatus = (): SyncStatus => currentStatus;
const getServerStatus = (): SyncStatus => "closed";

/** The live WebSocket status. Safe to call from anywhere under the shell. */
export const useSyncStatus = (): SyncStatus =>
  React.useSyncExternalStore(subscribeStatus, getStatus, getServerStatus);

// ── the one live client, reachable from outside React ────────────────

/**
 * The client `useSync` currently owns. Held at module scope so a native
 * resume can force a reconnect without a ref threaded through the tree —
 * `initMobile`'s `appStateChange` handler is not a React consumer, and the
 * shell mounts `useSync` exactly once, so there is never more than one.
 */
let activeClient: SyncClient | null = null;

/**
 * Drop the socket and open a new one now.
 *
 * The server pings every 10s and terminates on the first missed pong
 * (`ws/handler.ts`), so a socket the OS froze while the app was backgrounded
 * is dead server-side within ~20s — while the client still reports "open",
 * because a frozen connection delivers no close event. Reconnection in
 * `sync-client.ts` runs off `onclose` alone, so without this the status stays
 * a lie and, worse, `use-offline-queue`'s flush trigger (`status === "open"`)
 * never fires again. Reconnecting also re-runs the server's
 * `enforceMaxEntryDuration` on upgrade, so a timer left running overnight is
 * caught for free.
 */
export const reconnectSync = (): void => {
  activeClient?.reconnect();
};

// ── URL derivation ───────────────────────────────────────────────────

/** Lives in `@starter/core` so non-React clients derive the same socket URL. */
export { resolveSyncUrl } from "@starter/core";

// ── cache invalidation ───────────────────────────────────────────────

type Utils = ReturnType<typeof trpc.useUtils>;

/**
 * How much of an event concerns the workspace on screen — see
 * `syncEventReach` in core, shared with the extension and Raycast. The React
 * Query keys do not include the workspace (the tRPC link adds it below them),
 * so an `entry.upserted` from workspace A invalidating `entries.list` while B
 * is on screen would at best refetch B for nothing.
 */
export { syncEventReach, type SyncEventReach };

/** Whether an event shows THIS person at a keyboard — see core. */
export { isOwnActivity };

/**
 * Map a sync event onto the query caches it invalidates. Reports depend on
 * both entries and the catalog, so they are refreshed by either.
 */
const invalidateFor = (utils: Utils, event: SyncEvent): void => {
  switch (event.kind) {
    case "entry.upserted":
    case "entry.deleted":
    case "timer.started":
    case "timer.stopped":
      void utils.entries.invalidate();
      void utils.reports.invalidate();
      return;
    case "catalog.changed":
      void utils.clients.invalidate();
      void utils.projects.invalidate();
      void utils.tasks.invalidate();
      void utils.tags.invalidate();
      void utils.reports.invalidate();
      // A cascading delete rewrites the entries it detached, and publishes no
      // entry event of its own.
      if (event.entriesTouched) void utils.entries.invalidate();
      return;
    case "favorites.changed":
      void utils.favorites.invalidate();
      return;
    case "invoice.changed":
      // Invoicing stamps `invoiceId` onto the entries it bills, so a write
      // here changes what is still billable — entries and reports go stale
      // alongside the ledger itself.
      void utils.invoices.invalidate();
      void utils.entries.invalidate();
      void utils.reports.invalidate();
      return;
    case "settings.changed":
      void utils.settings.invalidate();
      return;
    case "data.imported":
      // An import writes thousands of entries and the catalog behind them in
      // one go, so there is nothing here to patch — every list is refetched,
      // including the import history the undo button reads.
      void utils.entries.invalidate();
      void utils.reports.invalidate();
      void utils.clients.invalidate();
      void utils.projects.invalidate();
      void utils.tasks.invalidate();
      void utils.tags.invalidate();
      void utils.data.invalidate();
      return;
    case "integrations.changed":
      // API tokens and webhook subscriptions are read only on the settings
      // screen, and both lists are short — refetch rather than patch, so a
      // token revoked on a laptop disappears from the phone without either
      // client having to reconstruct what changed from a payload.
      if (event.scope === "api-token") void utils.apiTokens.invalidate();
      else void utils.webhooks.invalidate();
      return;
    case "membership.changed":
      // A role or visibility change alters what EVERY query may return for
      // this person, and a removal takes the workspace away entirely, so
      // nothing is patched — everything is refetched.
      void utils.invalidate();
      return;
    default: {
      // A new SyncEvent kind with no case here would otherwise be a silent
      // cross-device staleness bug that no test catches. Fail the BUILD
      // instead: this line stops compiling the moment the union grows.
      const unhandled: never = event;
      void unhandled;
      return;
    }
  }
};

/**
 * Opens the sync socket and keeps react-query in step with mutations made on
 * other devices. Mount exactly once, in the app shell.
 */
export const useSync = (): SyncStatus => {
  const utils = trpc.useUtils();
  const utilsRef = React.useRef(utils);
  const userId = useAuth().user?.id ?? null;
  const userIdRef = React.useRef(userId);
  React.useEffect(() => {
    userIdRef.current = userId;
  }, [userId]);
  const router = useRouter();
  const routerRef = React.useRef(router);
  // Keyed on, not merely read: the native token arrives from the Keychain
  // after mount, so an effect with empty deps opens one tokenless socket, is
  // refused at the upgrade, and then retries that same refusal forever —
  // which also means `syncStatus` never reaches "open" and the offline queue
  // never gets its flush trigger. `ready` is in the key too, so the socket is
  // not opened before we know whether there is a token at all.
  const { token: nativeToken, ready: sessionReady } = useNativeSession();
  // Keyed on too: on the phone apps the server is a choice read from storage,
  // and a socket opened before (or across) a change of server would be talking
  // to one the person has left. Always null on web.
  const serverOrigin = useApiOrigin().choice?.origin ?? null;
  // Bumped when a 4401 turns out to be a replaced session rather than a
  // revoked one (`lib/session-revoked.ts`): the closed client has latched, so
  // a fresh one is built with the current credential.
  const [epoch, setEpoch] = React.useState(0);

  React.useEffect(() => {
    utilsRef.current = utils;
  }, [utils]);

  React.useEffect(() => {
    routerRef.current = router;
  }, [router]);

  React.useEffect(() => {
    if (!sessionReady) return;

    const url = resolveSyncUrl(getApiOrigin(), window.location.origin);
    if (url === "") return;

    const client = createSyncClient({
      url,
      // A getter, so a reconnect re-reads it rather than re-offering the
      // token this closure was created with.
      token: () => getNativeToken() ?? undefined,
      clientVersion: APP_VERSION,
      onStatus: setStatus,
      /*
       * The server closed us with 4401: this device's session no longer
       * exists. The socket has already stopped reconnecting — without this
       * the app would sit on a sync dot that never settles, against a
       * credential the server has permanently rejected, and on native that
       * dead token would still be in the Keychain at the next launch.
       */
      onSessionRevoked: () => {
        void revokeThisDevice(
          () => routerRef.current.replace("/login"),
          () => setEpoch((value) => value + 1),
        );
      },
      onEvent: (event, originId, eventWorkspaceId) => {
        // Our own echo — the mutation's optimistic update already landed.
        if (originId !== undefined && originId === ORIGIN_ID) return;
        // Somebody just did something on another device, so the person was at
        // a keyboard at this instant. Idle detection measures from here rather
        // than from the last time *this* tab saw input — that is what stops a
        // laptop left open from pausing work being done elsewhere.
        if (isOwnActivity(event, eventWorkspaceId, userIdRef.current)) {
          idleWatcher.noteRemoteActivity(Date.now());
        }
        // Read per event, not captured: the socket is per person and is NOT
        // reopened on a workspace switch, so the active workspace can change
        // under a live client.
        switch (syncEventReach(event, eventWorkspaceId, getActiveWorkspaceId())) {
          case "all":
            invalidateFor(utilsRef.current, event);
            return;
          case "timer":
            void utilsRef.current.entries.current.invalidate();
            return;
          case "membership":
            void utilsRef.current.workspaces.list.invalidate();
            return;
          case "ignore":
            return;
        }
      },
    });

    client.connect();
    activeClient = client;
    return () => {
      if (activeClient === client) activeClient = null;
      client.close();
    };
  }, [sessionReady, nativeToken, serverOrigin, epoch]);

  return useSyncStatus();
};

// ── running timer ────────────────────────────────────────────────────

/**
 * One store per tab — every consumer of `useRunningEntry` shares this clock.
 *
 * Exported because two things outside React drive it: the boot seed from
 * `lib/running-mirror.ts`, which puts a timer on screen before any query has
 * answered, and the native resume handler, which ticks it so the clock is
 * right on the first frame after 90 seconds in the background.
 */
export const timerStore = createTimerStore();

// The running timer is a person's. Whoever signs in next in this tab must not
// see the previous account's clock while their own `entries.current` is on its
// way — or, offline, instead of it.
onSignOut(() => {
  timerStore.getState().setRunning(null);
});

let tickers = 0;
let stopTicking: (() => void) | null = null;

const retainTicker = (): (() => void) => {
  tickers += 1;
  if (tickers === 1) stopTicking = startTicking(timerStore);
  return () => {
    tickers -= 1;
    if (tickers === 0) {
      stopTicking?.();
      stopTicking = null;
    }
  };
};

export type RunningEntry = {
  entry: TimeEntry | null;
  elapsedSec: number;
  /**
   * The device's clock is behind the entry's own start, so elapsed time cannot
   * be computed. See `clockLooksWrong`.
   */
  clockSkewed: boolean;
};

/**
 * How far behind the running entry's start the device clock has to be before
 * we say so. A start stamped by another device, or by the server, is a
 * different clock; a minute of tolerance covers ordinary drift between two
 * honest ones.
 */
const CLOCK_SKEW_TOLERANCE_MS = 60_000;

/**
 * True when this device thinks "now" is before the timer started.
 *
 * `entryDurationSec` clamps with `Math.max(0, …)`, so a phone whose clock is
 * behind — set by hand, or back from a dead battery before NTP catches up —
 * shows a clock frozen at 0:00 while the entry genuinely runs. The clamp is
 * right (a negative duration is worse) but the result reads as a broken app
 * and is unexplainable from the outside, so it is worth naming.
 */
export const clockLooksWrong = (
  entry: TimeEntry | null,
  nowMs: number
): boolean => {
  if (entry === null || entry.end !== null) return false;
  const startMs = Date.parse(entry.start);
  if (Number.isNaN(startMs)) return false;
  return nowMs < startMs - CLOCK_SKEW_TOLERANCE_MS;
};

const selectTimerState = (): TimerState => timerStore.getState();
const selectInitialTimerState = (): TimerState => timerStore.getInitialState();

/**
 * The running entry plus its live elapsed seconds.
 *
 * Elapsed time is recomputed from `entry.start` against the wall clock on
 * every tick (never accumulated), so it survives sleep and throttled tabs.
 * `useSyncExternalStore` keeps the subscription tear-free under React 19
 * concurrent rendering.
 */
export const useRunningEntry = (): RunningEntry => {
  const query = trpc.entries.current.useQuery(undefined, {
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });

  const entry = query.data ?? null;
  // `isSuccess`, not "we rendered": on a cold offline launch the query never
  // answers, `query.data` is `undefined`, and an ungated effect would call
  // `setRunning(null)` on the first render — wiping the entry the mirror
  // seeded microseconds earlier and showing no timer on exactly the launch
  // this whole path exists for. A paused or failed read is not a statement
  // that nothing is running; only an answer is.
  const answered = query.isSuccess;

  React.useEffect(() => {
    if (!answered) return;
    timerStore.getState().setRunning(entry);
    // Mirrored from here rather than from the mutations, so there is one
    // writer and it is the authoritative one. `null` clears the mirror, which
    // is how a timer stopped on another device stops coming back.
    void writeRunningMirror(entry);
  }, [answered, entry]);

  React.useEffect(() => retainTicker(), []);

  const state = React.useSyncExternalStore(
    timerStore.subscribe,
    selectTimerState,
    selectInitialTimerState
  );

  return {
    entry: state.running,
    elapsedSec: state.elapsedSec,
    clockSkewed: clockLooksWrong(state.running, Date.now()),
  };
};
