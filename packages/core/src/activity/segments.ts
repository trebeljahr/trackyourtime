/**
 * Segment and interval arithmetic. Pure, and in epoch ms throughout.
 */
import type {
  ActivityInterval,
  ActivitySegment,
  MergeSegmentsOptions,
} from "./types.js";

export const DEFAULT_PULSE_GAP_MS = 60_000;

const compareKeys = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const bySegmentOrder = (a: ActivitySegment, b: ActivitySegment): number =>
  a.start - b.start || a.end - b.end || compareKeys(a.key, b.key);

/**
 * Join adjacent segments that describe the same thing.
 *
 * Two segments merge when they share `source`, `key` and `afk` and the second
 * starts no more than `pulseGapMs` after the first ends (an overlap counts as
 * adjacent). Interleaving does not prevent a merge — A, B, A inside a minute
 * still joins the two A's — because a quick glance at another tab should not
 * split the stretch it interrupted. The merged segment keeps the first label
 * it saw, so a title that changed mid-stretch does not make the label flicker.
 *
 * Returns new objects sorted by start; the input is not mutated. Empty and
 * inverted segments are dropped.
 */
export function mergeSegments(
  segments: readonly ActivitySegment[],
  options: MergeSegmentsOptions = {},
): ActivitySegment[] {
  const gap = options.pulseGapMs ?? DEFAULT_PULSE_GAP_MS;
  const sorted = segments
    .filter((segment) => segment.end > segment.start)
    .map((segment) => ({ ...segment }))
    .sort(bySegmentOrder);

  const merged: ActivitySegment[] = [];
  const latest = new Map<string, ActivitySegment>();

  for (const segment of sorted) {
    const identity = JSON.stringify([segment.source, segment.afk, segment.key]);
    const previous = latest.get(identity);
    if (previous !== undefined && segment.start - previous.end <= gap) {
      previous.end = Math.max(previous.end, segment.end);
      if (previous.label === undefined && segment.label !== undefined) {
        previous.label = segment.label;
      }
      continue;
    }
    merged.push(segment);
    latest.set(identity, segment);
  }

  return merged.sort(bySegmentOrder);
}

/**
 * Union a set of intervals into sorted, non-overlapping ones. Touching
 * intervals (`a.end === b.start`) are joined.
 */
export function unionIntervals(
  intervals: readonly ActivityInterval[],
): ActivityInterval[] {
  const sorted = intervals
    .filter((interval) => interval.end > interval.start)
    .map((interval) => ({ start: interval.start, end: interval.end }))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const out: ActivityInterval[] = [];
  for (const interval of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end);
    } else {
      out.push(interval);
    }
  }
  return out;
}

/**
 * `interval` minus every span in `holes`, as the pieces that remain.
 *
 * `holes` must already be a union (sorted, disjoint) — see
 * {@link unionIntervals}.
 */
export function subtractIntervals(
  interval: ActivityInterval,
  holes: readonly ActivityInterval[],
): ActivityInterval[] {
  const pieces: ActivityInterval[] = [];
  let cursor = interval.start;

  for (const hole of holes) {
    if (hole.end <= cursor) continue;
    if (hole.start >= interval.end) break;
    if (hole.start > cursor) pieces.push({ start: cursor, end: hole.start });
    cursor = Math.max(cursor, hole.end);
    if (cursor >= interval.end) break;
  }

  if (cursor < interval.end) pieces.push({ start: cursor, end: interval.end });
  return pieces;
}

/** Total length of a union in ms. */
export function totalLength(union: readonly ActivityInterval[]): number {
  return union.reduce((sum, interval) => sum + (interval.end - interval.start), 0);
}
