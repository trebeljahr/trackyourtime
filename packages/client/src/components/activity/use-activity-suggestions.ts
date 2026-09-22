"use client";

import * as React from "react";
import type {
  DesktopActivity,
  DesktopActivityInterval,
  DesktopActivitySuggestion,
} from "@starter/shared";

import {
  fetchRangeEntries,
  trackedIntervalsFrom,
} from "@/components/activity/tracked-intervals";
import { useViewerId } from "@/components/tracker/own-entries";
import { timerStore } from "@/hooks/use-sync";
import { getActiveWorkspaceId } from "@/lib/active-workspace";
import { listOwnQueuedMutations } from "@/lib/offline";
import { trpc } from "@/lib/trpc";

/** How often an open, visible screen asks again. Main's push covers the rest. */
export const SUGGESTIONS_REFRESH_MS = 30_000;

/**
 * How long a read of the tracked time answers a push-driven refresh. Main
 * pushes as often as every 2 s while it records, and each push re-reading
 * `entries.list` would be a request per push; a stale answer here costs at
 * most a suggestion shown a few seconds too long, and accepting it
 * recomputes from a fresh read anyway.
 */
export const TRACKED_REUSE_MS = 15_000;

export type ActivitySuggestionsState = {
  /** Null until main answers, and when it has no scope or its store is locked. */
  suggestions: DesktopActivitySuggestion[] | null;
  /** Main answered at least once for this range. */
  loaded: boolean;
  /** The last refresh failed; what is on screen is the previous answer. */
  failed: boolean;
  /** `fresh`: re-read the tracked time even when a recent read would do. */
  refresh: (options?: { fresh?: boolean }) => Promise<void>;
  /** Everything tracked that overlaps `range`, read fresh — for the accept check. */
  trackedBetween: (range: DesktopActivityInterval) => Promise<DesktopActivityInterval[]>;
};

/**
 * The suggestions for one range (a day on screen), composed by main from what
 * it recorded minus what is tracked here. Refreshes on mount, on every
 * activity push from main, every 30 s while the document is visible, and
 * whenever a caller asks (after an accept or a dismiss).
 */
export const useActivitySuggestions = (
  activity: DesktopActivity | null,
  range: DesktopActivityInterval,
): ActivitySuggestionsState => {
  const utils = trpc.useUtils();
  const viewerId = useViewerId();
  const [suggestions, setSuggestions] = React.useState<DesktopActivitySuggestion[] | null>(null);
  const [loaded, setLoaded] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  const viewerRef = React.useRef(viewerId);
  viewerRef.current = viewerId;

  const trackedBetween = React.useCallback(
    async (span: DesktopActivityInterval): Promise<DesktopActivityInterval[]> => {
      const workspaceId = getActiveWorkspaceId();
      const [entries, queued] = await Promise.all([
        fetchRangeEntries(utils, span),
        workspaceId === null ? Promise.resolve([]) : listOwnQueuedMutations(workspaceId),
      ]);
      // The cache first; the timer store when `entries.current` has not
      // answered, which on a cold offline launch it never does.
      const current = utils.entries.current.getData();
      const running = current !== undefined ? current : timerStore.getState().running;
      return trackedIntervalsFrom({
        entries,
        viewerId: viewerRef.current,
        running,
        queued,
        range: span,
        now: Date.now(),
      });
    },
    [utils],
  );

  // A range changed mid-flight must not have its answer overwritten by the
  // previous range's late one.
  const generation = React.useRef(0);
  const reuse = React.useRef<{ key: string; at: number; tracked: DesktopActivityInterval[] } | null>(null);
  const { start, end } = range;

  const readTracked = React.useCallback(
    async (fresh: boolean): Promise<DesktopActivityInterval[]> => {
      const key = `${start}:${end}`;
      const kept = reuse.current;
      if (!fresh && kept !== null && kept.key === key && Date.now() - kept.at < TRACKED_REUSE_MS) {
        return kept.tracked;
      }
      const tracked = await trackedBetween({ start, end });
      reuse.current = { key, at: Date.now(), tracked };
      return tracked;
    },
    [trackedBetween, start, end],
  );

  const refresh = React.useCallback(
    async (options: { fresh?: boolean } = {}): Promise<void> => {
      if (activity === null) return;
      const mine = ++generation.current;
      try {
        const tracked = await readTracked(options.fresh === true);
        const next = await activity.suggestions({ from: start, to: end, tracked });
        if (mine !== generation.current) return;
        setSuggestions(next);
        setLoaded(true);
        setFailed(false);
      } catch {
        if (mine === generation.current) setFailed(true);
      }
    },
    [activity, readTracked, start, end],
  );

  React.useEffect(() => {
    setSuggestions(null);
    setLoaded(false);
    void refresh({ fresh: true });
  }, [refresh]);

  React.useEffect(() => {
    if (activity === null) return;
    return activity.onChanged(() => {
      void refresh();
    });
  }, [activity, refresh]);

  React.useEffect(() => {
    if (activity === null) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh({ fresh: true });
    }, SUGGESTIONS_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [activity, refresh]);

  return { suggestions, loaded, failed, refresh, trackedBetween };
};
