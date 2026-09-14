/**
 * Turning captured activity into entries worth confirming.
 */
import { matchRule } from "./rules.js";
import {
  mergeSegments,
  subtractIntervals,
  totalLength,
  unionIntervals,
} from "./segments.js";
import type {
  ActivityInterval,
  ActivityKeyShare,
  ActivityRule,
  ActivitySegment,
  ActivitySuggestion,
  BuildSuggestionsOptions,
  ProposedEntryFields,
} from "./types.js";

export const DEFAULT_SUGGESTION_GAP_MINUTES = 10;
export const DEFAULT_SUGGESTION_MIN_MINUTES = 5;
export const DEFAULT_SUGGESTION_MAX_KEYS = 5;

const MINUTE_MS = 60_000;

type Piece = ActivityInterval & { key: string };

const proposedFrom = (rule: ActivityRule): ProposedEntryFields => {
  const proposed: ProposedEntryFields = {};
  if (rule.description !== undefined) proposed.description = rule.description;
  if (rule.projectId !== undefined) proposed.projectId = rule.projectId;
  if (rule.taskId !== undefined) proposed.taskId = rule.taskId;
  if (rule.tagIds !== undefined) proposed.tagIds = [...rule.tagIds];
  if (rule.billable !== undefined) proposed.billable = rule.billable;
  return proposed;
};

const compareKeys = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Untracked activity, as blocks a person can accept as entries.
 *
 * 1. AFK segments are ignored; the rest are merged ({@link mergeSegments}).
 * 2. Every tracked interval is cut out of them, so time already on an entry
 *    is never suggested twice. Callers pass dismissed ranges here too — a
 *    dismissal means "this time is accounted for", and treating it exactly
 *    like an entry lets activity that arrives after the dismissal still
 *    surface on its own.
 * 3. What remains is joined into blocks. A new block starts when the next
 *    piece begins more than `gapMinutes` after the block's end, or when a
 *    tracked interval lies between them — a block never spans tracked time,
 *    or accepting it would create an overlapping entry.
 * 4. A block whose covered time (the union of its pieces, not its span) is
 *    under `minMinutes` is dropped: two quick glances ten minutes apart are
 *    not twelve minutes of work.
 *
 * Keys are credited with the time of their own pieces, so overlapping sources
 * (a desktop app and a browser tab at once) can credit more than the block's
 * covered time; `share` is always relative to the credited total.
 *
 * Deterministic: the same inputs produce the same output, sorted by start.
 */
export function buildSuggestions(
  segments: readonly ActivitySegment[],
  trackedIntervals: readonly ActivityInterval[],
  rules: readonly ActivityRule[],
  options: BuildSuggestionsOptions = {},
): ActivitySuggestion[] {
  const gapMs = (options.gapMinutes ?? DEFAULT_SUGGESTION_GAP_MINUTES) * MINUTE_MS;
  const minMs = (options.minMinutes ?? DEFAULT_SUGGESTION_MIN_MINUTES) * MINUTE_MS;
  const maxKeys = options.maxKeys ?? DEFAULT_SUGGESTION_MAX_KEYS;

  const tracked = unionIntervals(trackedIntervals);

  const pieces: Piece[] = [];
  for (const segment of mergeSegments(segments.filter((s) => !s.afk))) {
    for (const piece of subtractIntervals(segment, tracked)) {
      pieces.push({ ...piece, key: segment.key });
    }
  }
  pieces.sort((a, b) => a.start - b.start || a.end - b.end || compareKeys(a.key, b.key));

  const blocks: Piece[][] = [];
  let current: Piece[] = [];
  let currentEnd = Number.NEGATIVE_INFINITY;

  for (const piece of pieces) {
    const separated =
      current.length > 0 &&
      (piece.start - currentEnd > gapMs ||
        tracked.some((t) => t.start >= currentEnd && t.end <= piece.start));
    if (separated) {
      blocks.push(current);
      current = [];
      currentEnd = Number.NEGATIVE_INFINITY;
    }
    current.push(piece);
    currentEnd = Math.max(currentEnd, piece.end);
  }
  if (current.length > 0) blocks.push(current);

  const suggestions: ActivitySuggestion[] = [];
  for (const block of blocks) {
    const covered = totalLength(unionIntervals(block));
    if (covered < minMs || block.length === 0) continue;

    const perKey = new Map<string, number>();
    for (const piece of block) {
      perKey.set(piece.key, (perKey.get(piece.key) ?? 0) + (piece.end - piece.start));
    }
    const credited = [...perKey.values()].reduce((sum, ms) => sum + ms, 0);
    const ranked = [...perKey.entries()].sort(
      (a, b) => b[1] - a[1] || compareKeys(a[0], b[0]),
    );

    const topKeys: ActivityKeyShare[] = ranked
      .slice(0, maxKeys)
      .map(([key, ms]) => ({
        key,
        seconds: Math.round(ms / 1000),
        share: credited > 0 ? ms / credited : 0,
      }));

    const rule = matchRule(
      rules,
      ranked.map(([key]) => key),
    );

    const start = block[0]?.start ?? 0;
    const end = block.reduce((max, piece) => Math.max(max, piece.end), start);

    suggestions.push({
      start,
      end,
      topKeys,
      ...(rule !== null ? { ruleId: rule.id } : {}),
      proposed: rule !== null ? proposedFrom(rule) : {},
    });
  }

  return suggestions;
}
