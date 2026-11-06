// Parallel entries: one person's entries that overlap in time.
//
// Overlap is allowed — several agent sessions, a call while a build runs —
// and every total stays honest by splitting the shared time EVENLY: each
// moment is divided by the number of that person's entries active in it. A
// range total then equals the wall-clock time the person tracked, and the
// same hour is never billed twice.
//
// Overlap is per author. A colleague working the same hour is somebody
// else's time and is summed, as it always was.
//
// Nothing is stored: the split is derived from `start`/`end` whenever a
// report or an invoice is computed. An entry that overlaps nothing never
// enters these maps and is measured exactly as before.

import { addDaysToKey, dayKeyInZone, zonedDayStartMs, type DayKey } from "./timezone.js";

/** One entry, clipped to the window it is being measured in. */
export type ParallelInterval = {
  id: string;
  authorId: string;
  startMs: number;
  endMs: number;
};

/** What an overlapping entry contributes, in integer seconds. */
export type ParallelShare = {
  seconds: number;
  /** Per bucket (a local day, or `ALL` for an unbucketed split). Sums to `seconds`. */
  slices: { date: string; seconds: number }[];
};

/**
 * Where one bucket of time ends, given an instant inside it. A report buckets
 * by local day; an invoice does not bucket at all.
 */
export type BucketOf = (ms: number) => { key: string; endMs: number };

export const ALL_TIME_BUCKET = "all";

export const singleBucket: BucketOf = () => ({ key: ALL_TIME_BUCKET, endMs: Infinity });

const MS_PER_DAY = 86_400_000;

/** Local days in `timeZone`, the bucket every report's timeline uses. */
export const zonedDayBuckets = (timeZone: string): BucketOf => (ms) => {
  const key: DayKey = dayKeyInZone(ms, timeZone);
  const next = zonedDayStartMs(addDaysToKey(key, 1), timeZone);
  // Same guard as `splitIntervalByZonedDay`: a boundary that fails to advance.
  return { key, endMs: next > ms ? next : ms + MS_PER_DAY };
};

/**
 * Clip an entry to a window. `endMs: null` is a running timer, counted up to
 * `nowMs`. Returns null when nothing of it is inside.
 */
export const clipInterval = (
  entry: { id: string; authorId: string; startMs: number; endMs: number | null },
  window: { fromMs: number; toMs: number },
  nowMs: number,
): ParallelInterval | null => {
  const startMs = Math.max(entry.startMs, window.fromMs);
  const endMs = Math.min(entry.endMs ?? nowMs, window.toMs);
  if (!(endMs > startMs)) return null;
  return { id: entry.id, authorId: entry.authorId, startMs, endMs };
};

type Cluster = { minStart: number; maxEnd: number; members: ParallelInterval[] };

/**
 * Keep only the entries that overlap another entry of the same author.
 *
 * Built to be fed a report's keyset walk — newest start first — so it holds
 * one open cluster per author and drops every lone entry as soon as the
 * cluster after it starts. Memory is bounded by the overlapping entries, not
 * by the range. Any order still gives a correct answer for ordered input and
 * merges spans conservatively otherwise (an entry edited mid-walk can arrive
 * out of order, exactly as `keysetPages` warns).
 */
export class OverlapCollector {
  private readonly open = new Map<string, Cluster>();
  private readonly kept: ParallelInterval[] = [];

  add(interval: ParallelInterval | null): void {
    if (!interval) return;
    const cluster = this.open.get(interval.authorId);
    if (cluster && interval.startMs < cluster.maxEnd && interval.endMs > cluster.minStart) {
      cluster.members.push(interval);
      cluster.minStart = Math.min(cluster.minStart, interval.startMs);
      cluster.maxEnd = Math.max(cluster.maxEnd, interval.endMs);
      return;
    }
    if (cluster) this.close(cluster);
    this.open.set(interval.authorId, {
      minStart: interval.startMs,
      maxEnd: interval.endMs,
      members: [interval],
    });
  }

  /** Every entry that overlaps at least one other entry of its author. */
  overlapping(): ParallelInterval[] {
    for (const cluster of this.open.values()) this.close(cluster);
    this.open.clear();
    return this.kept;
  }

  private close(cluster: Cluster): void {
    if (cluster.members.length > 1) this.kept.push(...cluster.members);
  }
}

/** `OverlapCollector` over a list, in any order. */
export const overlappingIntervals = (
  intervals: readonly (ParallelInterval | null)[],
): ParallelInterval[] => {
  const sorted = intervals
    .filter((interval): interval is ParallelInterval => interval !== null)
    .sort((a, b) => b.startMs - a.startMs || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const collector = new OverlapCollector();
  for (const interval of sorted) collector.add(interval);
  return collector.overlapping();
};

/**
 * Split overlapping time evenly and return each entry's share.
 *
 * Every elementary piece of time — cut at each start, end and bucket
 * boundary — is divided by the number of the author's entries active in it.
 * Shares are then made integers per author and bucket: the bucket's total is
 * its wall-clock seconds rounded once, each entry gets the floor of its exact
 * share, and the remainder goes to the largest fractions (ties by id). So a
 * day's split total always equals that day's wall-clock time, and an entry's
 * `seconds` is the sum of its slices.
 *
 * Feed it intervals already clipped to the window being measured. Entries
 * that overlap nothing may be included; they come back whole.
 */
export const parallelShares = (
  intervals: readonly ParallelInterval[],
  bucketOf: BucketOf = singleBucket,
): Map<string, ParallelShare> => {
  const byAuthor = new Map<string, ParallelInterval[]>();
  for (const interval of intervals) {
    if (!(interval.endMs > interval.startMs)) continue;
    const list = byAuthor.get(interval.authorId) ?? [];
    list.push(interval);
    byAuthor.set(interval.authorId, list);
  }

  const result = new Map<string, ParallelShare>();
  for (const list of byAuthor.values()) {
    // Exact share in ms, per bucket, per entry — insertion order of buckets
    // is chronological because the sweep is.
    const exact = new Map<string, Map<string, number>>();
    const points = [...new Set(list.flatMap((i) => [i.startMs, i.endMs]))].sort((a, b) => a - b);
    const byStart = [...list].sort((a, b) => a.startMs - b.startMs);
    const active: ParallelInterval[] = [];
    let next = 0;

    for (let p = 0; p + 1 < points.length; p += 1) {
      const from = points[p]!;
      const to = points[p + 1]!;
      while (next < byStart.length && byStart[next]!.startMs <= from) {
        active.push(byStart[next]!);
        next += 1;
      }
      for (let a = active.length - 1; a >= 0; a -= 1) {
        if (active[a]!.endMs <= from) active.splice(a, 1);
      }
      if (active.length === 0) continue;

      let cursor = from;
      for (let guard = 0; guard < 100_000 && cursor < to; guard += 1) {
        const bucket = bucketOf(cursor);
        const pieceEnd = Math.min(to, bucket.endMs > cursor ? bucket.endMs : to);
        const each = (pieceEnd - cursor) / active.length;
        let buckets = exact.get(bucket.key);
        if (!buckets) {
          buckets = new Map();
          exact.set(bucket.key, buckets);
        }
        for (const member of active) {
          buckets.set(member.id, (buckets.get(member.id) ?? 0) + each);
        }
        cursor = pieceEnd;
      }
    }

    for (const [key, shares] of exact) {
      const ids = [...shares.keys()].sort();
      const totalMs = ids.reduce((sum, id) => sum + shares.get(id)!, 0);
      const target = Math.round(totalMs / 1000);
      const floors = ids.map((id) => Math.floor(shares.get(id)! / 1000 + 1e-9));
      let remainder = target - floors.reduce((sum, value) => sum + value, 0);
      const order = ids
        .map((id, index) => ({ index, fraction: shares.get(id)! / 1000 - floors[index]! }))
        .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
      for (const { index } of order) {
        if (remainder <= 0) break;
        floors[index]! += 1;
        remainder -= 1;
      }
      ids.forEach((id, index) => {
        const seconds = floors[index]!;
        const share = result.get(id) ?? { seconds: 0, slices: [] };
        share.seconds += seconds;
        if (seconds > 0) share.slices.push({ date: key, seconds });
        result.set(id, share);
      });
    }
  }
  return result;
};

/**
 * Wall-clock seconds covered by a set of intervals (their union) — the figure
 * a split total must equal. Used by tests and by surfaces that only need a
 * total, never per-entry shares.
 */
export const wallClockSeconds = (intervals: readonly { startMs: number; endMs: number }[]): number => {
  const sorted = intervals.filter((i) => i.endMs > i.startMs).sort((a, b) => a.startMs - b.startMs);
  let total = 0;
  let spanStart = -Infinity;
  let spanEnd = -Infinity;
  for (const interval of sorted) {
    if (interval.startMs >= spanEnd) {
      if (spanEnd > spanStart) total += spanEnd - spanStart;
      spanStart = interval.startMs;
      spanEnd = interval.endMs;
    } else {
      spanEnd = Math.max(spanEnd, interval.endMs);
    }
  }
  if (spanEnd > spanStart) total += spanEnd - spanStart;
  return Math.round(total / 1000);
};
