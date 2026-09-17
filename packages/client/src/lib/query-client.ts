"use client";

import { QueryCache, QueryClient, onlineManager } from "@tanstack/react-query";

import { noteNotFound } from "@/lib/active-workspace";
import {
  isAuthError,
  isForbiddenError,
  isNotFoundError,
} from "@/lib/offline";
import { isCapacitor } from "@/lib/shell";
import { getNetworkOnline, subscribeNetwork } from "@/mobile/network";

/**
 * React Query, configured for the host it is running on.
 *
 * Two decisions, each of which has a wrong answer that looks fine until the
 * network goes away:
 *
 * **`onlineManager` is fed the radio, not the browser.** Its default listener
 * is `window.online`/`offline`, which in WKWebView never fires for airplane
 * mode. With the wrong verdict every query on a backgrounded phone wakes up
 * and fires into a radio that is not there.
 *
 * **Retries are bounded on native.** The web defaults (3 attempts, exponential
 * backoff) are fine on a desktop; on a phone they are a battery cost paid per
 * screen per wake. An `UNAUTHORIZED` or `FORBIDDEN` is never retried —
 * retrying a session or a role the server has rejected cannot change its mind.
 *
 * **A NOT_FOUND re-asks for the workspace list.** Removal from a workspace on
 * another device, with the socket down, shows up here first: every query for
 * the active workspace starts answering NOT_FOUND. `noteNotFound` refetches
 * `workspaces.list` (throttled), and the active-workspace sync falls back to
 * the default and says so — see `lib/active-workspace.ts`.
 *
 * Mutations keep React Query's defaults here, `networkMode: "online"`
 * included. See `OFFLINE_QUEUED_MUTATION` below for the handful that must
 * not.
 */
/**
 * The tab's one QueryClient, kept so sign-out can empty it. Sign-out does not
 * reload the page, so without this the next account to sign in in the same
 * tab is shown the previous one's cached entries until each query refetches.
 */
let appQueryClient: QueryClient | null = null;

/** Drop every cached answer. Called on sign-out and account deletion. */
export const clearAppQueryCache = async (): Promise<void> => {
  const client = appQueryClient;
  if (client === null) return;
  await client.cancelQueries();
  client.clear();
};

export const createAppQueryClient = (): QueryClient => {
  // Bounded, backed-off retries are a battery rule: the phone only.
  const native = isCapacitor();

  appQueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (error) => {
        if (isNotFoundError(error)) noteNotFound();
      },
    }),
    defaultOptions: {
      queries: native
        ? {
            retry: (failureCount: number, error: unknown) => {
              if (isAuthError(error) || isForbiddenError(error)) return false;
              return failureCount < 2;
            },
            retryDelay: (attempt: number) =>
              Math.min(1000 * 2 ** attempt, 30_000),
          }
        : {},
    },
  });
  return appQueryClient;
};

/**
 * The mutation options for a write the offline queue owns.
 *
 * React Query's default is to *pause* a mutation while `onlineManager` says
 * offline: `mutationFn` never runs, `onError` never fires, and the offline
 * queue is filled from `onError`. Paused means the promise sits there and
 * nothing is ever queued — the timer button would simply do nothing in
 * airplane mode. The offline queue *is* the pause mechanism for these writes,
 * and it needs the failure to happen to do its job.
 *
 * **Applied per mutation, deliberately not as a `defaultOptions.mutations`.**
 * It used to be global, which quietly took React Query's pause-and-resume away
 * from every *other* mutation in the app — profile edits, catalog renames,
 * invoice writes, the calendar's drag-to-move — on the web as much as on the
 * phone. None of those queue anything: without pausing they roll back and
 * toast "network error" the instant the connection blips, where pausing would
 * have replayed them on reconnect with the optimistic state intact. Three
 * places need this and they are the three that catch the failure:
 *
 *  - `components/tracker/use-entry-mutations.ts` — start/stop/create/edit
 *  - `components/timesheet/use-timesheet-mutations.ts` — the grid's writes
 *  - `hooks/use-offline-queue.ts` — the replay itself, which must reject
 *    rather than hang if the radio dies mid-flush; a paused replay would
 *    leave `flush()` awaiting a promise that never settles and the queue
 *    latched as "flushing" for the rest of the launch.
 *
 * Adding a fourth is a decision to argue about, not a default to inherit.
 */
export const OFFLINE_QUEUED_MUTATION = {
  networkMode: "always",
} as const;

let bound = false;

/**
 * Hand React Query the same network verdict everything else in the app uses.
 * Idempotent; `setEventListener` replaces whatever was registered before, and
 * calling it twice would leave a dangling subscription.
 */
export const bindOnlineManager = (): void => {
  if (bound) return;
  bound = true;

  onlineManager.setEventListener((setOnline) => {
    setOnline(getNetworkOnline());
    return subscribeNetwork(() => setOnline(getNetworkOnline()));
  });
};
