import { useCachedPromise } from "@raycast/utils";
import { useEffect, useRef, useState } from "react";
import { reconcileRunning, type TimerEcho } from "@starter/core";
import { getTrackYourTime, type TrackYourTime } from "./api.js";
import { loadTimerEcho } from "./storage.js";
import { isAuthFailure, showFailureToast } from "./ui.js";
import { activeWorkspaceId, onWorkspaceChanged } from "./workspace.js";

/**
 * How often a surface re-reads the chosen workspace. A local read; a switch
 * made in another command reaches a menu bar that stays loaded within this.
 */
const WORKSPACE_POLL_MS = 5000;

/**
 * The workspace this command reads from, re-read from storage so a switch
 * made anywhere in Raycast re-keys every loader. `resolved` is false until the
 * first read, and no loader runs before it.
 */
export function useActiveWorkspaceId(): {
  workspaceId: string | null;
  resolved: boolean;
} {
  const [state, setState] = useState<{
    workspaceId: string | null;
    resolved: boolean;
  }>({ workspaceId: null, resolved: false });

  useEffect(() => {
    let cancelled = false;
    const read = (): void => {
      void activeWorkspaceId()
        .catch(() => null)
        .then((workspaceId) => {
          if (cancelled) return;
          setState((previous) =>
            previous.resolved && previous.workspaceId === workspaceId
              ? previous
              : { workspaceId, resolved: true },
          );
        });
    };
    read();
    const id = setInterval(read, WORKSPACE_POLL_MS);
    const unsubscribe = onWorkspaceChanged(read);
    return () => {
      cancelled = true;
      clearInterval(id);
      unsubscribe();
    };
  }, []);

  return state;
}

/** A loaded value and the workspace its requests were addressed to. */
type Tagged<T> = { workspaceId: string | null; value: T };

export type ApiHookResult<T> = {
  data: T | undefined;
  isLoading: boolean;
  error: Error | undefined;
  /** True when the failure was "no session", so the caller shows sign-in. */
  signedOut: boolean;
  revalidate: () => void;
};

/**
 * Load something from the API with Raycast's stale-while-revalidate cache, so
 * a command paints last known data immediately instead of a spinner.
 *
 * `cacheKey` namespaces the cached value — two loaders in one command must
 * not share a slot.
 *
 * The chosen workspace is part of every slot. `useCachedPromise` persists
 * what it painted across launches, so a shared slot would paint workspace A's
 * projects, entries and totals the instant a command opened pointed at B —
 * and keep them there for as long as B's first read took, or forever offline.
 */
export function useApi<T>(
  cacheKey: string,
  loader: (api: TrackYourTime) => Promise<T>,
  options?: { execute?: boolean },
): ApiHookResult<T> {
  const workspace = useActiveWorkspaceId();
  const scopedKey = `${cacheKey}@${workspace.workspaceId ?? "none"}`;
  const { data, isLoading, error, revalidate } = useCachedPromise(
    // The key is passed as an argument, not closed over, because that is what
    // `useCachedPromise` hashes into its cache slot.
    async (_key: string): Promise<Tagged<T>> => {
      // Read before the load: the tag says which workspace the requests were
      // addressed to, even when the load itself moves the choice.
      const workspaceId = await activeWorkspaceId().catch(() => null);
      return { workspaceId, value: await loader(await getTrackYourTime()) };
    },
    [scopedKey],
    {
      execute: workspace.resolved && (options?.execute ?? true),
      // Kept for a revalidation of the same slot, where it stops a flicker.
      // Across a workspace change the previous data is the OTHER workspace's,
      // which is what the tag check below refuses to hand out.
      keepPreviousData: true,
      onError: (failure) => {
        void showFailureToast(failure, "Could not reach Track Your Time");
      },
    },
  );

  return {
    data:
      data !== undefined && workspace.resolved && data.workspaceId === workspace.workspaceId
        ? data.value
        : undefined,
    isLoading,
    error,
    signedOut: isAuthFailure(error),
    revalidate,
  };
}

/**
 * Re-run a loader on a timer, for a surface that has to notice a change it
 * did not make itself.
 *
 * Every trackyourtime client refreshes the menu bar after its own mutations, so
 * this is only about the ones that cannot: a timer started in the web app, on
 * another machine, or by a build of this extension that is not running.
 */
export function usePoll(revalidate: () => void, intervalMs: number): void {
  useEffect(() => {
    const id = setInterval(revalidate, intervalMs);
    return () => clearInterval(id);
  }, [revalidate, intervalMs]);
}

/**
 * Watch for the running entry being replaced or stopped, and reload when it
 * is.
 *
 * A surface that stays loaded to count seconds has to answer for those
 * seconds: nothing re-runs it any more, so a timer stopped anywhere else
 * leaves a clock ticking up on an entry that already ended — a wrong number,
 * not merely a stale one. `entries.current` is one small query, so this can
 * run far more often than the full snapshot and hand the reload to it only
 * once the two disagree.
 *
 * Failures are swallowed. The menu bar has no good place to put a network
 * blip, and the next tick asks again anyway.
 */
export function useWatchRunning(
  runningId: string | null,
  active: boolean,
  revalidate: () => void,
  intervalMs: number,
): void {
  useEffect(() => {
    if (!active) return;

    let cancelled = false;
    const check = async (): Promise<void> => {
      try {
        const api = await getTrackYourTime();
        const current = await api.current();
        if (!cancelled && (current?.id ?? null) !== runningId) revalidate();
      } catch {
        // Asked again on the next tick.
      }
    };

    const id = setInterval(() => void check(), intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [runningId, active, revalidate, intervalMs]);
}

/**
 * A clock that re-renders its caller, so an elapsed time on screen actually
 * moves.
 *
 * Frozen while `active` is false: with no timer running there is nothing to
 * count, and a view command that wakes every second to render the same string
 * is a battery cost with no payoff. Re-reads the clock on activation so a
 * timer started a moment ago does not wait a full tick to show up.
 */
export function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);

  return now;
}

/**
 * How often a surface re-reads this install's timer echo. One second, because
 * it is a local storage read with no network in it, and because a second is
 * how long the user should ever see a timer they already stopped.
 */
const ECHO_POLL_MS = 1000;

/**
 * The running entry a surface should actually draw, given the snapshot it
 * fetched and whatever this Mac has done to the timer since.
 *
 * This is what makes stop/start agree across Raycast's separate processes.
 * `refreshMenuBar()` cannot: a menu bar command that is still loaded — which
 * a running timer keeps it — is not remounted by a background launch, so the
 * live instance would keep ticking an ended entry until its own 20s poll came
 * round. Reading a local record costs nothing and cannot be declined.
 *
 * Calls `revalidate` once when the echo names a timer the snapshot has never
 * seen, so the fields catch up with the fact.
 */
export function useReconciledRunning<T extends { id: string }>(
  snapshot: { running: T | null; fetchedAt: number } | undefined,
  revalidate: () => void,
): T | null {
  const [echo, setEcho] = useState<TimerEcho | null>(null);
  const latest = useRef(revalidate);
  latest.current = revalidate;

  useEffect(() => {
    let cancelled = false;
    const read = (): void => {
      void loadTimerEcho().then((next) => {
        if (!cancelled) setEcho(next);
      });
    };
    read();
    const id = setInterval(read, ECHO_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const { running, refetch } = snapshot
    ? reconcileRunning(snapshot, echo)
    : { running: null, refetch: false };

  // Once per transition rather than once per render: `echo.at` only moves
  // when something actually happened to the timer.
  const pending = refetch ? (echo?.at ?? null) : null;
  const asked = useRef<number | null>(null);
  useEffect(() => {
    if (pending === null || asked.current === pending) return;
    asked.current = pending;
    latest.current();
  }, [pending]);

  return running;
}
