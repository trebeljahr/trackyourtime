/*
 * Suggestions, composed here in the main process.
 *
 * The renderer sends the tracked intervals in (fetching entries is network
 * work, and nothing under `activity/` does any) and gets suggestions back,
 * with display names and at most three titles each. Raw segments never cross
 * IPC: the page sees only what it is about to offer.
 *
 * The arithmetic is core's `buildSuggestions`, shared with the browser
 * extension. What is added here: the live open segment, the in-memory
 * "just accepted" spans (an accepted entry takes a moment to show up in the
 * tracked intervals), names, titles, and the accept check.
 */

import {
  buildSuggestions,
  type ActivityInterval,
  type ActivityRule,
  type ActivitySegment,
} from "../../../packages/core/src/activity/index.ts";
import type {
  DesktopActivityAcceptCheck,
  DesktopActivityApp,
  DesktopActivitySuggestion,
} from "../../../packages/shared/src/desktop-bridge.ts";
import { STALE_AFTER_MS, type OpenSegment, type StoredSegment } from "./model.ts";

/** How long an accepted span counts as tracked without being in the tracked list. */
export const ACCEPTED_HOLD_MS = 5 * 60_000;
/** How far around an accepted span its check looks. */
export const ACCEPT_CONTEXT_MS = 12 * 60 * 60_000;
export const MAX_RECENT_APPS = 30;
export const MAX_TITLES = 3;

export interface AcceptedSpan extends ActivityInterval {
  at: number;
}

/** The scope's stored segments plus the open one, which counts up to now (or `lastSeen`, if stale). */
export function withOpenSegment(
  stored: readonly StoredSegment[],
  open: OpenSegment | null,
  scope: string,
  now: number,
): StoredSegment[] {
  if (open === null || open.scope !== scope) return [...stored];
  const end = now - open.lastSeen > STALE_AFTER_MS ? open.lastSeen : Math.max(open.lastSeen, now);
  if (end <= open.start) return [...stored];
  return [
    ...stored,
    {
      scope,
      source: "desktop",
      start: open.start,
      end,
      key: open.key,
      name: open.name,
      ...(open.label !== undefined ? { label: open.label } : {}),
      afk: false,
    },
  ];
}

/** The newest name each key was seen under. */
export function namesOf(segments: readonly StoredSegment[]): Map<string, string> {
  const names = new Map<string, { name: string; at: number }>();
  for (const segment of segments) {
    const known = names.get(segment.key);
    if (known === undefined || segment.end >= known.at) names.set(segment.key, { name: segment.name, at: segment.end });
  }
  return new Map([...names].map(([key, { name }]) => [key, name]));
}

/** Newest first, one per key. */
export function recentApps(segments: readonly StoredSegment[]): DesktopActivityApp[] {
  const sorted = [...segments].sort((a, b) => b.end - a.end);
  const seen = new Set<string>();
  const out: DesktopActivityApp[] = [];
  for (const segment of sorted) {
    if (seen.has(segment.key)) continue;
    seen.add(segment.key);
    out.push({ key: segment.key, name: segment.name });
    if (out.length >= MAX_RECENT_APPS) break;
  }
  return out;
}

/** Accepted spans still inside their hold. */
export function liveAccepted(accepted: readonly AcceptedSpan[], now: number): AcceptedSpan[] {
  return accepted.filter((span) => now - span.at < ACCEPTED_HOLD_MS);
}

function clip(segment: StoredSegment, from: number, to: number): StoredSegment | null {
  const start = Math.max(segment.start, from);
  const end = Math.min(segment.end, to);
  return end > start ? { ...segment, start, end } : null;
}

/** Titles of the dominant app inside a block, most time first. */
function titlesFor(segments: readonly StoredSegment[], key: string, start: number, end: number): string[] {
  const perTitle = new Map<string, number>();
  for (const segment of segments) {
    if (segment.key !== key || segment.label === undefined) continue;
    const overlap = Math.min(segment.end, end) - Math.max(segment.start, start);
    if (overlap <= 0) continue;
    perTitle.set(segment.label, (perTitle.get(segment.label) ?? 0) + overlap);
  }
  return [...perTitle.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, MAX_TITLES)
    .map(([title]) => title);
}

export interface ComposeInput {
  /** The scope's segments overlapping the range, open segment included. */
  segments: readonly StoredSegment[];
  /** Names across everything stored for the scope. */
  names: ReadonlyMap<string, string>;
  from: number;
  to: number;
  /** Tracked entries, dismissals and just-accepted spans alike: time that is accounted for. */
  holes: readonly ActivityInterval[];
  rules: readonly ActivityRule[];
}

export function composeSuggestions(input: ComposeInput): DesktopActivitySuggestion[] {
  const clipped = input.segments
    .map((segment) => clip(segment, input.from, input.to))
    .filter((segment): segment is StoredSegment => segment !== null);
  const core: ActivitySegment[] = clipped.map((segment) => ({
    source: segment.source,
    start: segment.start,
    end: segment.end,
    key: segment.key,
    ...(segment.label !== undefined ? { label: segment.label } : {}),
    afk: segment.afk,
  }));
  return buildSuggestions(core, input.holes, input.rules).map((suggestion) => {
    const dominant = suggestion.topKeys[0]?.key;
    return {
      start: suggestion.start,
      end: suggestion.end,
      topApps: suggestion.topKeys.map((share) => ({
        key: share.key,
        name: input.names.get(share.key) ?? share.key,
        seconds: share.seconds,
        share: share.share,
      })),
      titles: dominant === undefined ? [] : titlesFor(clipped, dominant, suggestion.start, suggestion.end),
      ...(suggestion.ruleId !== undefined ? { ruleId: suggestion.ruleId } : {}),
      proposed: suggestion.proposed,
    };
  });
}

/** The range an accept check rebuilds suggestions over. */
export function acceptRange(start: number, end: number, now: number): { from: number; to: number } {
  return { from: start - ACCEPT_CONTEXT_MS, to: Math.min(now, end + ACCEPT_CONTEXT_MS) };
}

/**
 * Whether a suggestion may still become an entry, from suggestions rebuilt
 * against the entries as they are now (the page's copy can be seconds old):
 *
 * - nothing untracked overlaps the request any more → `already-tracked`;
 * - a plain accept → clipped to the untracked block it overlaps most;
 * - an edited accept → the person's own times, chosen on purpose.
 */
export function checkAccept(
  request: { start: number; end: number; edited: boolean },
  rebuilt: readonly DesktopActivitySuggestion[],
): DesktopActivityAcceptCheck {
  if (!(request.end > request.start)) return { ok: false, reason: "bad-range" };
  const overlap = (block: { start: number; end: number }): number =>
    Math.min(block.end, request.end) - Math.max(block.start, request.start);
  const best = rebuilt.filter((block) => overlap(block) > 0).sort((a, b) => overlap(b) - overlap(a))[0];
  if (best === undefined) return { ok: false, reason: "already-tracked" };
  if (request.edited) return { ok: true, start: request.start, end: request.end };
  return { ok: true, start: Math.max(request.start, best.start), end: Math.min(request.end, best.end) };
}
