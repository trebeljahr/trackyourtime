/**
 * Autopilot: when captured activity should start, switch or stop a timer by
 * itself.
 *
 * Suggestions (`suggest.ts`) wait for a person to look at them. Autopilot acts:
 * somebody who has worked in an app for a few minutes with no timer running
 * gets one, opened at the moment that work began. Everything it does is
 * decided here, pure — no clock, no zone, no storage — so the same rows give
 * the same decision on every host, and every rule below is a unit test.
 *
 * Four rules keep it from getting in the way:
 *
 * 1. **It only starts what it can name.** An app is filed by a rule ("Always
 *    file Figma under …"), else by what this person tracked while that app
 *    was in front ({@link learnFilings}). An app with neither — or a browser
 *    used for five different projects — is never auto-started; it stays a
 *    suggestion. A timer called nothing is worse than no timer.
 * 2. **It never touches a timer it did not start.** Switching and stopping
 *    apply only to `running.owned`, which the host sets when the running
 *    entry is still exactly the one Autopilot opened. A timer the person
 *    started, or edited, is theirs.
 * 3. **It is retroactive, never ahead of the facts.** A start or a switch is
 *    dated to the first minute of the work that justified it, and a drift stop
 *    to the last minute of the timer's own work. Nothing is dated in the
 *    future, and a start never reaches back across time that is tracked.
 * 4. **Glances do not count.** Attention is read in one-minute buckets, and a
 *    short stretch of something else inside a run belongs to the run.
 */

import { hostMatches, matchRule, ruleProposal } from "./rules.js";
import { mergeSegments, subtractIntervals, unionIntervals } from "./segments.js";
import type {
  ActivityInterval,
  ActivityRule,
  ActivitySegment,
  ProposedEntryFields,
} from "./types.js";

const MINUTE_MS = 60_000;

export const DEFAULT_AUTOPILOT_START_MINUTES = 5;
export const AUTOPILOT_START_MINUTE_CHOICES = [3, 5, 10, 15] as const;

/** Everything a decision is tuned by. Defaults in {@link DEFAULT_AUTOPILOT_OPTIONS}. */
export type AutopilotOptions = {
  /** Time on one filing, with no timer running, before Autopilot starts it. */
  startAfterMs: number;
  /** Time on a different filing, inside an Autopilot timer, before it switches. */
  switchAfterMs: number;
  /** Time present but not on the timer's own work before an Autopilot timer stops. */
  driftAfterMs: number;
  /** Activity must have been seen this recently for anything to happen. */
  liveMs: number;
  /** A run survives a stretch of other activity or absence up to this long. */
  maxInterruptMs: number;
  /** A run ends at a stretch of one other KNOWN filing this long. */
  absorbOtherMs: number;
  /** How far back a run may reach. */
  lookbackMs: number;
  /** The bucket attention is read in. */
  bucketMs: number;
};

export const DEFAULT_AUTOPILOT_OPTIONS: AutopilotOptions = {
  startAfterMs: DEFAULT_AUTOPILOT_START_MINUTES * MINUTE_MS,
  switchAfterMs: 10 * MINUTE_MS,
  driftAfterMs: 20 * MINUTE_MS,
  liveMs: 3 * MINUTE_MS,
  maxInterruptMs: 10 * MINUTE_MS,
  absorbOtherMs: 5 * MINUTE_MS,
  lookbackMs: 4 * 60 * MINUTE_MS,
  bucketMs: MINUTE_MS,
};

export type AutopilotFilingSource = "rule" | "learned";

/** What Autopilot would file work in one app under. */
export type AutopilotFiling = {
  /** {@link filingKeyOf} the fields: equal keys are the same work. */
  key: string;
  fields: ProposedEntryFields;
  via: AutopilotFilingSource;
  /** The rule that named it, for `via: "rule"`. */
  ruleId?: string;
};

/** One tracked entry, as {@link learnFilings} reads it. */
export type LearnableEntry = {
  start: number;
  /** The running entry is passed with `end` at now. */
  end: number;
  description: string;
  projectId: string | null;
  taskId: string | null;
  tagIds: readonly string[];
  billable: boolean;
};

export type LearnFilingsOptions = {
  /** An app must have been in front this long during one filing's entries. Default 15 min. */
  minEvidenceMs?: number;
  /** That filing's share of the app's tracked time. Default 0.6. */
  minShare?: number;
};

export const DEFAULT_LEARN_MIN_EVIDENCE_MS = 15 * MINUTE_MS;
export const DEFAULT_LEARN_MIN_SHARE = 0.6;

const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The identity of a filing: description (case and spacing folded), project
 * and task. Billable and tags are left out — they follow the work rather than
 * define it, and a person who once forgot a tag is still doing the same job.
 */
export function filingKeyOf(
  fields: Pick<ProposedEntryFields, "description" | "projectId" | "taskId">,
): string {
  const description = (fields.description ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  return JSON.stringify([description, fields.projectId ?? null, fields.taskId ?? null]);
}

/** Whether a filing names anything: a description or a project. */
export function isFileable(fields: ProposedEntryFields): boolean {
  return (fields.description ?? "").trim() !== "" || (fields.projectId ?? null) !== null;
}

/** The key a "not this app" hold is stored under, beside filing keys. */
export function appHoldKey(appKey: string): string {
  return `app:${appKey}`;
}

/**
 * What each app has been filed under, learned from this person's own entries.
 *
 * Every entry credits the apps that were in front during it with the overlap.
 * An app is learned when one filing holds at least `minShare` of its credited
 * time and at least `minEvidenceMs` of it: an editor used for one client
 * learns that client, a browser used for everything learns nothing. The
 * fields come from the newest entry of the winning filing, so a renamed tag or
 * a changed billable flag follows the person's latest choice.
 *
 * Entries with neither a description nor a project teach nothing.
 */
export function learnFilings(
  segments: readonly ActivitySegment[],
  entries: readonly LearnableEntry[],
  options: LearnFilingsOptions = {},
): Map<string, AutopilotFiling> {
  const minEvidence = options.minEvidenceMs ?? DEFAULT_LEARN_MIN_EVIDENCE_MS;
  const minShare = options.minShare ?? DEFAULT_LEARN_MIN_SHARE;

  const active = mergeSegments(segments.filter((segment) => !segment.afk));
  /** app → filing key → ms */
  const credit = new Map<string, Map<string, number>>();
  /** filing key → the newest entry filed under it */
  const newest = new Map<string, LearnableEntry>();

  for (const entry of entries) {
    if (!(entry.end > entry.start)) continue;
    if (!isFileable(entry)) continue;
    const key = filingKeyOf(entry);
    const known = newest.get(key);
    if (known === undefined || entry.end > known.end) newest.set(key, entry);

    for (const segment of active) {
      const overlap = Math.min(segment.end, entry.end) - Math.max(segment.start, entry.start);
      if (overlap <= 0) continue;
      const perFiling = credit.get(segment.key) ?? new Map<string, number>();
      perFiling.set(key, (perFiling.get(key) ?? 0) + overlap);
      credit.set(segment.key, perFiling);
    }
  }

  const learned = new Map<string, AutopilotFiling>();
  for (const [app, perFiling] of credit) {
    let total = 0;
    let bestKey: string | null = null;
    let bestMs = 0;
    for (const [key, ms] of [...perFiling].sort((a, b) => compareStrings(a[0], b[0]))) {
      total += ms;
      if (ms > bestMs) {
        bestKey = key;
        bestMs = ms;
      }
    }
    if (bestKey === null || bestMs < minEvidence || bestMs / total < minShare) continue;
    const entry = newest.get(bestKey);
    if (entry === undefined) continue;
    learned.set(app, {
      key: bestKey,
      via: "learned",
      fields: {
        description: entry.description,
        projectId: entry.projectId,
        taskId: entry.taskId,
        tagIds: [...entry.tagIds],
        billable: entry.billable,
      },
    });
  }
  return learned;
}

/**
 * How an app is filed: its rule first (the person said so), else what was
 * learned. A rule that names neither a description nor a project files
 * nothing, and does not fall through to learning either — the person wrote a
 * rule for this app, and it is not ours to second-guess.
 */
export function createFilingResolver(
  rules: readonly ActivityRule[],
  learned: ReadonlyMap<string, AutopilotFiling>,
): (appKey: string) => AutopilotFiling | null {
  const cache = new Map<string, AutopilotFiling | null>();
  return (appKey) => {
    const cached = cache.get(appKey);
    if (cached !== undefined) return cached;
    let filing: AutopilotFiling | null;
    const rule = matchRule(rules, [appKey]);
    if (rule !== null) {
      const fields = ruleProposal(rule);
      filing = isFileable(fields) ? { key: filingKeyOf(fields), fields, via: "rule", ruleId: rule.id } : null;
    } else {
      filing = learned.get(appKey) ?? null;
    }
    cache.set(appKey, filing);
    return filing;
  };
}

/** Whether `appKey` is covered by any rule (used to tell "unknown" from "filed as nothing"). */
export function hasRuleFor(rules: readonly ActivityRule[], appKey: string): boolean {
  return rules.some((rule) => hostMatches(rule.pattern, appKey));
}

// ── attention ─────────────────────────────────────────────────────────

/** A piece of untracked activity, labelled with the filing its app resolves to. */
export type LabelledPiece = ActivityInterval & {
  app: string;
  /** Null for an app Autopilot cannot file. */
  filing: string | null;
};

/** A stretch of attention on one filing, read backwards from now. */
export type AutopilotRun = {
  filingKey: string;
  /** The first instant of the filing's own activity in the run. */
  start: number;
  /** The end of the filing's last activity in the run. */
  lastAt: number;
  /** Time spent on the filing inside the run (not its span). */
  creditedMs: number;
  /** The app that contributed most of it. */
  appKey: string;
};

const UNKNOWN = "?";

type Bucket = {
  ms: Map<string, number>;
  /** Earliest piece start per label inside the bucket. */
  first: Map<string, number>;
  /** Latest piece end per label inside the bucket. */
  last: Map<string, number>;
  /** ms per app, per label. */
  apps: Map<string, Map<string, number>>;
};

/** Pieces shorter than this in a bucket do not make it "present". */
const PRESENCE_MS = 1_000;

const bucketLabel = (bucket: Bucket): string | null => {
  let total = 0;
  let bestKnown: string | null = null;
  let bestKnownMs = 0;
  for (const [label, ms] of [...bucket.ms].sort((a, b) => compareStrings(a[0], b[0]))) {
    total += ms;
    if (label !== UNKNOWN && ms > bestKnownMs) {
      bestKnown = label;
      bestKnownMs = ms;
    }
  }
  if (total < PRESENCE_MS) return null;
  const unknownMs = bucket.ms.get(UNKNOWN) ?? 0;
  return bestKnown !== null && bestKnownMs >= unknownMs ? bestKnown : UNKNOWN;
};

/**
 * The run of attention that is going on now: the most recent filing, followed
 * back through time for as long as it holds.
 *
 * Read in buckets of `bucketMs`, aligned to `now`. A bucket belongs to the
 * known filing with the most time in it, unless unfiled apps had more. Walking
 * backwards from now, the first known filing is the target; the run then
 * extends over every bucket of it, and over interruptions — absence, unfiled
 * apps, other filings — until one lasts longer than `maxInterruptMs`, or one
 * other filing holds for `absorbOtherMs` in a row. Nothing before `from`.
 */
export function trailingRun(
  pieces: readonly LabelledPiece[],
  from: number,
  now: number,
  options: Pick<AutopilotOptions, "bucketMs" | "maxInterruptMs" | "absorbOtherMs">,
): AutopilotRun | null {
  const size = options.bucketMs;
  const count = Math.ceil((now - from) / size);
  if (count <= 0) return null;

  // Bucket k covers [now - (k + 1) * size, now - k * size); k = 0 is the newest.
  const buckets: Bucket[] = Array.from({ length: count }, () => ({
    ms: new Map(),
    first: new Map(),
    last: new Map(),
    apps: new Map(),
  }));
  for (const piece of pieces) {
    const start = Math.max(piece.start, from);
    const end = Math.min(piece.end, now);
    if (end <= start) continue;
    const label = piece.filing ?? UNKNOWN;
    const newest = Math.floor((now - end) / size);
    const oldest = Math.min(count - 1, Math.floor((now - start - 1) / size));
    for (let k = Math.max(0, newest); k <= oldest; k += 1) {
      const bucket = buckets[k] as Bucket;
      const bucketEnd = now - k * size;
      const bucketStart = bucketEnd - size;
      const a = Math.max(start, bucketStart);
      const b = Math.min(end, bucketEnd);
      if (b <= a) continue;
      bucket.ms.set(label, (bucket.ms.get(label) ?? 0) + (b - a));
      bucket.first.set(label, Math.min(bucket.first.get(label) ?? Number.POSITIVE_INFINITY, a));
      bucket.last.set(label, Math.max(bucket.last.get(label) ?? Number.NEGATIVE_INFINITY, b));
      const apps = bucket.apps.get(label) ?? new Map<string, number>();
      apps.set(piece.app, (apps.get(piece.app) ?? 0) + (b - a));
      bucket.apps.set(label, apps);
    }
  }

  let target: string | null = null;
  let sinceTarget = 0;
  let otherStreak = 0;
  let credited = 0;
  let start = 0;
  let lastAt = 0;
  const appMs = new Map<string, number>();

  for (let k = 0; k < count; k += 1) {
    const bucket = buckets[k] as Bucket;
    const label = bucketLabel(bucket);
    if (target === null && label !== null && label !== UNKNOWN) {
      target = label;
      lastAt = bucket.last.get(label) ?? now - k * size;
    }
    if (target !== null && label === target) {
      credited += bucket.ms.get(target) ?? 0;
      start = bucket.first.get(target) ?? now - (k + 1) * size;
      for (const [app, ms] of bucket.apps.get(target) ?? []) appMs.set(app, (appMs.get(app) ?? 0) + ms);
      sinceTarget = 0;
      otherStreak = 0;
      continue;
    }
    sinceTarget += size;
    otherStreak = label !== null && label !== UNKNOWN ? otherStreak + size : 0;
    if (sinceTarget > options.maxInterruptMs) break;
    if (target !== null && otherStreak >= options.absorbOtherMs) break;
  }

  if (target === null || credited <= 0) return null;
  const appKey = [...appMs].sort((a, b) => b[1] - a[1] || compareStrings(a[0], b[0]))[0]?.[0] ?? "";
  return { filingKey: target, start, lastAt, creditedMs: credited, appKey };
}

/**
 * The app that has had most of the attention since the last real break, for
 * the "what is this?" prompt. Walks back from now while gaps stay under
 * `maxInterruptMs`.
 */
export function trailingStreak(
  pieces: readonly LabelledPiece[],
  from: number,
  now: number,
  maxInterruptMs: number,
): { appKey: string; since: number; appMs: number } | null {
  const sorted = [...pieces]
    .map((piece) => ({ ...piece, start: Math.max(piece.start, from), end: Math.min(piece.end, now) }))
    .filter((piece) => piece.end > piece.start)
    .sort((a, b) => b.end - a.end || b.start - a.start);
  let cursor = now;
  const perApp = new Map<string, { ms: number; since: number }>();
  for (const piece of sorted) {
    if (cursor - piece.end > maxInterruptMs) break;
    const known = perApp.get(piece.app) ?? { ms: 0, since: piece.start };
    perApp.set(piece.app, { ms: known.ms + (piece.end - piece.start), since: Math.min(known.since, piece.start) });
    cursor = Math.min(cursor, piece.start);
  }
  const best = [...perApp].sort((a, b) => b[1].ms - a[1].ms || compareStrings(a[0], b[0]))[0];
  return best === undefined ? null : { appKey: best[0], since: best[1].since, appMs: best[1].ms };
}

// ── deciding ──────────────────────────────────────────────────────────

/** The running entry, as Autopilot sees it. */
export type AutopilotRunning = {
  start: number;
  /** {@link filingKeyOf} its fields. */
  filingKey: string;
  /** Still exactly the entry Autopilot opened (same start, same filing). */
  owned: boolean;
};

export type AutopilotInput = {
  now: number;
  /** Recent activity, the open segment included. */
  segments: readonly ActivitySegment[];
  /**
   * Time accounted for — entries, queued writes, dismissals — WITHOUT the
   * running entry, which `running` describes.
   */
  tracked: readonly ActivityInterval[];
  running: AutopilotRunning | null;
  resolve: (appKey: string) => AutopilotFiling | null;
  /** Filing keys and {@link appHoldKey}s Autopilot must not start right now. */
  held: ReadonlySet<string>;
  options?: Partial<AutopilotOptions>;
};

/** What Autopilot is looking at, for the screen. */
export type AutopilotWatch = {
  appKey: string;
  /** When the watched stretch began. */
  since: number;
  /** Time on it so far. */
  creditedMs: number;
  /** What it would be filed under; null when Autopilot cannot tell. */
  filing: AutopilotFiling | null;
  /** On hold until the next break (undone, stopped by hand, or "not work"). */
  held: boolean;
};

export type AutopilotDecision =
  | { kind: "none"; watch: AutopilotWatch | null }
  | { kind: "start"; at: number; filing: AutopilotFiling; appKey: string; creditedMs: number }
  | { kind: "switch"; at: number; filing: AutopilotFiling; appKey: string; creditedMs: number }
  /** An Autopilot timer whose work stopped while the person stayed: ended at its last minute. */
  | { kind: "stop"; at: number };

const isHeld = (held: ReadonlySet<string>, filingKey: string | null, appKey: string): boolean =>
  (filingKey !== null && held.has(filingKey)) || held.has(appHoldKey(appKey));

/**
 * One decision, for now.
 *
 * - **Nothing running:** start the trailing run's filing, dated to its first
 *   minute, once it holds `startAfterMs` — unless it is on hold.
 * - **An Autopilot timer running:** switch to a different filing that has
 *   held `switchAfterMs`, at its first minute; or, when the person is here but
 *   nothing of the timer's own work has happened for `driftAfterMs`, stop it
 *   at the end of that work.
 * - **Anything else running, or nobody here** (no activity within `liveMs`):
 *   nothing. Absence belongs to the idle guard, which asks.
 */
export function decideAutopilot(input: AutopilotInput): AutopilotDecision {
  const options: AutopilotOptions = { ...DEFAULT_AUTOPILOT_OPTIONS, ...input.options };
  const { now, running } = input;
  const none = (watch: AutopilotWatch | null = null): AutopilotDecision => ({ kind: "none", watch });

  const active = mergeSegments(input.segments.filter((segment) => !segment.afk));
  const lastSeen = active.reduce((max, segment) => Math.max(max, Math.min(segment.end, now)), Number.NEGATIVE_INFINITY);
  if (!(now - lastSeen <= options.liveMs)) return none();

  if (running !== null && !running.owned) return none();

  const tracked = unionIntervals(input.tracked);
  // Something tracked covers now — a queued start the running entry does not
  // show yet. Nothing to do until the two agree.
  if (running === null && tracked.some((t) => t.start <= now && t.end > now)) return none();

  // A run never reaches back across tracked time: a start dated before the
  // last entry ended would overlap it.
  let from = now - options.lookbackMs;
  for (const interval of tracked) if (interval.end <= now) from = Math.max(from, interval.end);
  if (running !== null) from = Math.max(from, running.start);

  const resolved = new Map<string, AutopilotFiling | null>();
  const filingOf = (app: string): AutopilotFiling | null => {
    if (!resolved.has(app)) resolved.set(app, input.resolve(app));
    return resolved.get(app) ?? null;
  };

  const pieces: LabelledPiece[] = [];
  for (const segment of active) {
    if (segment.end <= from || segment.start >= now) continue;
    const clipped = { start: Math.max(segment.start, from), end: Math.min(segment.end, now) };
    for (const piece of subtractIntervals(clipped, tracked)) {
      pieces.push({ ...piece, app: segment.key, filing: filingOf(segment.key)?.key ?? null });
    }
  }

  const run = trailingRun(pieces, from, now, options);
  const runFiling = run === null ? null : filingOf(run.appKey);

  if (running === null) {
    if (run !== null && runFiling !== null && runFiling.key === run.filingKey) {
      const held = isHeld(input.held, run.filingKey, run.appKey);
      if (!held && run.creditedMs >= options.startAfterMs) {
        return { kind: "start", at: run.start, filing: runFiling, appKey: run.appKey, creditedMs: run.creditedMs };
      }
      return none({ appKey: run.appKey, since: run.start, creditedMs: run.creditedMs, filing: runFiling, held });
    }
    const streak = trailingStreak(pieces, from, now, options.maxInterruptMs);
    if (streak === null) return none();
    return none({
      appKey: streak.appKey,
      since: streak.since,
      creditedMs: streak.appMs,
      filing: filingOf(streak.appKey),
      held: isHeld(input.held, filingOf(streak.appKey)?.key ?? null, streak.appKey),
    });
  }

  // An Autopilot timer is running.
  if (
    run !== null &&
    runFiling !== null &&
    runFiling.key === run.filingKey &&
    run.filingKey !== running.filingKey &&
    run.start > running.start &&
    run.creditedMs >= options.switchAfterMs &&
    !isHeld(input.held, run.filingKey, run.appKey)
  ) {
    return { kind: "switch", at: run.start, filing: runFiling, appKey: run.appKey, creditedMs: run.creditedMs };
  }

  const ownLast = pieces
    .filter((piece) => piece.filing === running.filingKey)
    .reduce((max, piece) => Math.max(max, piece.end), Number.NEGATIVE_INFINITY);
  if (Number.isFinite(ownLast) && ownLast > running.start) {
    // Absence is the idle guard's to judge — it may have asked, and been told
    // to keep it. Drift counts only time the person was here doing something
    // else, so it is measured from the end of the last break, and the stop
    // never takes back time on the far side of one.
    const anchor = Math.max(ownLast, lastBreakEnd(active, ownLast, now, options.maxInterruptMs) ?? ownLast);
    if (now - anchor >= options.driftAfterMs) return { kind: "stop", at: anchor };
  }

  if (run !== null && run.filingKey === running.filingKey) {
    return none({
      appKey: run.appKey,
      since: run.start,
      creditedMs: run.creditedMs,
      filing: runFiling,
      held: false,
    });
  }
  return none();
}

/** Activity in `[since, now)`, as a sorted, disjoint union. */
const busyBetween = (segments: readonly ActivitySegment[], since: number, now: number): ActivityInterval[] =>
  unionIntervals(
    segments
      .filter((segment) => !segment.afk && segment.end > since && segment.start < now)
      .map((segment) => ({ start: Math.max(segment.start, since), end: Math.min(segment.end, now) })),
  );

/**
 * Where the last stretch of no activity at all lasting `breakMs` or more,
 * between `since` and `now`, ended — or null when there was none. A trailing
 * one (the person is away now) ends at `now`.
 */
export function lastBreakEnd(
  segments: readonly ActivitySegment[],
  since: number,
  now: number,
  breakMs: number,
): number | null {
  let cursor = since;
  let found: number | null = null;
  for (const interval of busyBetween(segments, since, now)) {
    if (interval.start - cursor >= breakMs) found = interval.start;
    cursor = Math.max(cursor, interval.end);
  }
  if (now - cursor >= breakMs) found = now;
  return found;
}

/**
 * Whether the person took a break of at least `breakMs` between `since` and
 * `now` — a stretch with no activity at all, the trailing one included. A
 * hold ("not now", an undo, a timer stopped by hand) lasts until one.
 */
export function hadBreakSince(
  segments: readonly ActivitySegment[],
  since: number,
  now: number,
  breakMs: number,
): boolean {
  if (now - since < breakMs) return false;
  return lastBreakEnd(segments, since, now, breakMs) !== null;
}
