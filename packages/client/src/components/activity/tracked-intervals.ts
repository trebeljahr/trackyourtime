import type { DesktopActivityInterval, DetailedEntry, TimeEntry } from "@starter/shared";

import { isOwnEntry } from "@/components/tracker/own-entries";
import { TRACKER_LIST_INPUT } from "@/components/tracker/use-entry-mutations";
import type { trpc } from "@/lib/trpc";
import { isNetworkError, type OfflineMutation } from "@/lib/offline";

/**
 * What this person has already tracked, as intervals, for the desktop
 * activity suggestions. Main subtracts these (with the dismissals) from what
 * it recorded; anything missed here is offered again as untracked, and
 * accepting it would file the same time twice.
 *
 * Four sources, because each alone leaves a hole:
 *  - `entries.list` for the range — the viewer's OWN rows only
 *    (`own-entries.ts`): a colleague's entry in a shared workspace says
 *    nothing about what this computer was used for;
 *  - the running entry, up to now;
 *  - this account's queued `entries.create` (start–end) and `entries.start`
 *    (start–its queued stop, else now) in this workspace, held rows included:
 *    time no server has seen yet is still tracked;
 *  - offline, the tracker's cached list instead of the fetch.
 */

/** The page size and page cap of the fetch — 1,000 entries in a day is plenty. */
export const TRACKED_PAGE_LIMIT = 200;
export const TRACKED_MAX_PAGES = 5;

/** How far back of the range to ask, so an entry that began earlier and runs into it counts. */
const LOOKBACK_MS = 24 * 60 * 60 * 1000;

type EntryLike = Pick<DetailedEntry, "id" | "authorId" | "start" | "end">;

const toInterval = (start: string, end: string | null, now: number): DesktopActivityInterval | null => {
  const from = Date.parse(start);
  const to = end === null ? now : Date.parse(end);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;
  return { start: from, end: to };
};

/** Queued creates and starts as intervals; a queued start ends at its queued stop, else now. */
export const queuedIntervals = (
  mutations: readonly OfflineMutation[],
  now: number,
): DesktopActivityInterval[] => {
  const stopEnds = new Map<string, string>();
  for (const mutation of mutations) {
    if (mutation.op === "entries.stop" && mutation.tempId !== undefined) {
      stopEnds.set(mutation.tempId, mutation.input.end);
    }
  }
  const intervals: DesktopActivityInterval[] = [];
  for (const mutation of mutations) {
    let interval: DesktopActivityInterval | null = null;
    if (mutation.op === "entries.create") {
      interval = toInterval(mutation.input.start, mutation.input.end, now);
    } else if (mutation.op === "entries.start") {
      const end = mutation.tempId === undefined ? undefined : stopEnds.get(mutation.tempId);
      interval = toInterval(mutation.input.start, end ?? null, now);
    }
    if (interval !== null) intervals.push(interval);
  }
  return intervals;
};

/** Everything tracked that overlaps `range`, from what the four sources said. */
export const trackedIntervalsFrom = (input: {
  entries: readonly EntryLike[];
  viewerId: string | null;
  running: Pick<TimeEntry, "start" | "end"> | null;
  queued: readonly OfflineMutation[];
  range: DesktopActivityInterval;
  now: number;
}): DesktopActivityInterval[] => {
  const { range, now } = input;
  const intervals: DesktopActivityInterval[] = [];
  for (const entry of input.entries) {
    if (!isOwnEntry(entry, input.viewerId)) continue;
    const interval = toInterval(entry.start, entry.end, now);
    if (interval !== null) intervals.push(interval);
  }
  // `entries.current` is the viewer's own timer by definition.
  if (input.running !== null) {
    const interval = toInterval(input.running.start, input.running.end, now);
    if (interval !== null) intervals.push(interval);
  }
  intervals.push(...queuedIntervals(input.queued, now));
  return intervals.filter((interval) => interval.end > range.start && interval.start < range.end);
};

type Utils = ReturnType<typeof trpc.useUtils>;

/** The tracker's cached list, for when the fetch never got an answer. */
const cachedEntries = (utils: Utils): EntryLike[] =>
  utils.entries.list
    .getInfiniteData(TRACKER_LIST_INPUT)
    ?.pages.flatMap((page) => page.entries) ?? [];

/**
 * `entries.list` for `range` (and a day before it), paged. A transport
 * failure falls back to the tracker's cache; any other error is a real
 * answer and is thrown.
 */
export const fetchRangeEntries = async (
  utils: Utils,
  range: DesktopActivityInterval,
): Promise<EntryLike[]> => {
  const from = new Date(range.start - LOOKBACK_MS).toISOString();
  const to = new Date(range.end).toISOString();
  const rows: EntryLike[] = [];
  try {
    let cursor: string | undefined;
    for (let page = 0; page < TRACKED_MAX_PAGES; page += 1) {
      const result = await utils.entries.list.fetch(
        { from, to, limit: TRACKED_PAGE_LIMIT, ...(cursor === undefined ? {} : { cursor }) },
        // Always a fresh answer: this decides what is still untracked.
        { staleTime: 0 },
      );
      rows.push(...result.entries);
      cursor = result.nextCursor;
      if (cursor === undefined) break;
    }
    return rows;
  } catch (error) {
    if (!isNetworkError(error)) throw error;
    return cachedEntries(utils);
  }
};
