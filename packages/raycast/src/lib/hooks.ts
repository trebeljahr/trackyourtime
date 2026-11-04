import { environment, LaunchType } from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { useCallback, useEffect, useRef, useState } from "react";
import { reconcileRunning, type TimerEcho } from "../vendor/index.js";
import { getTrackYourTime, type TrackYourTime } from "./api.js";
import { watchLocalChange } from "./local-signal.js";
import { loadTimerEcho } from "./storage.js";
import { isAuthFailure, showFailureToast } from "./ui.js";
import { activeWorkspaceId, onWorkspaceChanged } from "./workspace.js";
import { notifySessionChanged, onSessionChanged, sessionCacheKey } from "./auth.js";
import { NotSignedInError } from "./errors.js";

/**
 * The session and workspace this command reads from. Re-read storage when
 * another command signals a change, so a sign-out, new pairing or workspace
 * switch re-keys every loader. Cached content is withheld until the first
 * local identity read resolves.
 */
export function useActiveWorkspaceId(): {
  workspaceId: string | null;
  sessionKey: string | null;
  resolved: boolean;
} {
  const [state, setState] = useState<{
    workspaceId: string | null;
    sessionKey: string | null;
    resolved: boolean;
  }>({ workspaceId: null, sessionKey: null, resolved: false });

  useEffect(() => {
    let cancelled = false;
    const read = (): void => {
      void (async () => {
        const sessionKey = await sessionCacheKey();
        const workspaceId = sessionKey ? await activeWorkspaceId() : null;
        return { sessionKey, workspaceId };
      })()
        .then(({ workspaceId, sessionKey }) => {
          if (cancelled) return;
          setState((previous) =>
            previous.resolved && previous.workspaceId === workspaceId && previous.sessionKey === sessionKey
              ? previous
              : { workspaceId, sessionKey, resolved: true },
          );
        })
        .catch(() => {
          if (!cancelled) setState({ workspaceId: null, sessionKey: null, resolved: true });
        });
    };
    read();
    const stopWatching = watchLocalChange(read);
    const unsubscribe = onWorkspaceChanged(read);
    const unsubscribeSession = onSessionChanged(read);
    return () => {
      cancelled = true;
      stopWatching();
      unsubscribe();
      unsubscribeSession();
    };
  }, []);

  return state;
}

/** A loaded value and the session/workspace its requests were addressed to. */
type Tagged<T> = { workspaceId: string | null; sessionKey: string; value: T };

export type ApiHookResult<T> = {
  data: T | undefined;
  isLoading: boolean;
  error: Error | undefined;
  /** True when the failure was "no session", so the caller shows sign-in. */
  signedOut: boolean;
  revalidate: () => void;
  /** Await a menu-bar refresh before Raycast unloads its action handler. */
  refresh: () => Promise<unknown>;
  /** Apply a visible change now, then refresh or restore on refusal. */
  optimistic: <R>(request: Promise<R>, update: (value: T) => T) => Promise<R>;
};

/**
 * Load something from the API with Raycast's stale-while-revalidate cache, so
 * a command paints last known data immediately instead of a spinner.
 *
 * `cacheKey` namespaces the cached value — two loaders in one command must
 * not share a slot.
 *
 * The session, server and workspace are part of every slot. Persistent data
 * from an older untagged slot or a different pairing must not paint a list of
 * working actions after the session has gone away.
 */
export function useApi<T>(
  cacheKey: string,
  loader: (api: TrackYourTime) => Promise<T>,
  options?: { execute?: boolean },
): ApiHookResult<T> {
  const workspace = useActiveWorkspaceId();
  const scopedKey = `${cacheKey}@${workspace.sessionKey ?? "signed-out"}@${workspace.workspaceId ?? "none"}`;
  const { data, isLoading, error, revalidate, mutate } = useCachedPromise(
    // The key is passed as an argument, not closed over, because that is what
    // `useCachedPromise` hashes into its cache slot.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async (_key: string): Promise<Tagged<T>> => {
      // Read before the load: the tag says which workspace the requests were
      // addressed to, even when the load itself moves the choice.
      const workspaceId = await activeWorkspaceId().catch(() => null);
      const sessionKey = await sessionCacheKey();
      if (!sessionKey) throw new NotSignedInError();
      return { workspaceId, sessionKey, value: await loader(await getTrackYourTime()) };
    },
    [scopedKey],
    {
      execute: workspace.resolved && workspace.sessionKey !== null && (options?.execute ?? true),
      // Kept for a revalidation of the same slot, where it stops a flicker.
      // Across a workspace change the previous data is the OTHER workspace's,
      // which is what the tag check below refuses to hand out.
      keepPreviousData: true,
      onError: (failure) => {
        if (isAuthFailure(failure)) {
          notifySessionChanged();
          return;
        }
        // Scheduled menu refreshes cannot show UI. Their last snapshot and
        // error tooltip remain available until the next successful read.
        if (environment.launchType !== LaunchType.Background) {
          void showFailureToast(failure, "Could not reach Track Your Time");
        }
      },
    },
  );

  // useCachedPromise types revalidate as void. Its mutation API explicitly
  // awaits revalidation in menu-bar commands, including a read-only mutate().
  const refresh = useCallback(() => mutate(), [mutate]);

  return {
    data:
      data !== undefined &&
      workspace.resolved &&
      workspace.sessionKey !== null &&
      data.sessionKey === workspace.sessionKey &&
      data.workspaceId === workspace.workspaceId &&
      !isAuthFailure(error)
        ? data.value
        : undefined,
    isLoading: !workspace.resolved || isLoading,
    error,
    signedOut: (workspace.resolved && workspace.sessionKey === null) || isAuthFailure(error),
    revalidate,
    refresh,
    optimistic: <R>(request: Promise<R>, update: (value: T) => T): Promise<R> =>
      mutate(request, {
        optimisticUpdate: (current) =>
          current === undefined ||
          current.workspaceId !== workspace.workspaceId ||
          current.sessionKey !== workspace.sessionKey
            ? (current as Tagged<T>)
            : { ...current, value: update(current.value) },
        rollbackOnError: true,
      }),
  };
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
 * A clock for a display that shows whole minutes of `anchorMs`.
 *
 * It wakes once per minute of elapsed time, exactly when the text changes, and
 * not at all without an anchor. Each changed title makes Raycast rebuild its
 * status items, so a re-render with nothing new to show still has a cost.
 */
export function useMinuteClock(anchorMs: number | null): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (anchorMs === null || Number.isNaN(anchorMs)) return;
    let id: ReturnType<typeof setTimeout>;
    const schedule = (): void => {
      const elapsed = Math.max(0, Date.now() - anchorMs);
      id = setTimeout(
        () => {
          setNow(Date.now());
          schedule();
        },
        60_000 - (elapsed % 60_000),
      );
    };
    setNow(Date.now());
    schedule();
    return () => clearTimeout(id);
  }, [anchorMs]);

  return now;
}

/**
 * The running entry a surface should actually draw, given the snapshot it
 * fetched and whatever this Mac has done to the timer since.
 *
 * This is what makes stop/start agree across Raycast's separate processes.
 * `refreshMenuBar()` cannot: a menu bar command that is still loaded — which
 * a running timer keeps it — is not remounted by a background launch, so the
 * live instance would keep ticking an ended entry. Another command's write
 * wakes this through `watchLocalChange`, with no timer in between.
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
        if (cancelled) return;
        setEcho((previous) => (previous?.at === next?.at && previous?.runningId === next?.runningId ? previous : next));
      });
    };
    read();
    const stopWatching = watchLocalChange(read);
    return () => {
      cancelled = true;
      stopWatching();
    };
  }, []);

  const { running, refetch } = snapshot ? reconcileRunning(snapshot, echo) : { running: null, refetch: false };

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
