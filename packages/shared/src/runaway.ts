/**
 * The runaway-timer guard: the policy values every package has to agree on,
 * and the pure decision the server evaluates against a running entry.
 *
 * This is NOT idle detection, and the two exist for different failures:
 *
 *  - Idle is "the person stopped typing". It is detected on a device, from a
 *    device's own input signal, and it needs a client to be awake and looking.
 *  - Runaway is "the timer started on Friday evening and it is Monday
 *    morning". The laptop was shut. No client was running. Nothing was there
 *    to detect anything.
 *
 * That difference is why the decision lives here rather than in
 * `@starter/core`: `@starter/core` is the clients' shared brain, and the case
 * this guard exists for is precisely the one where no client is running. The
 * server package imports `@starter/shared` and not `@starter/core`, so the
 * decision has to be reachable from here.
 *
 * The evaluation is pure — it takes two instants, the settings and whatever
 * the guard already recorded, and returns what to do. Everything that touches
 * Mongo or the socket is a thin shell around it on the server, which is what
 * makes every branch below testable by driving the clock instead of waiting.
 */

import type {
  MaxDurationSettings,
  RunawayBehavior,
  RunawayMark,
} from "./types.js";

/** Every behaviour, in the order the settings UI offers them. */
export const RUNAWAY_BEHAVIORS: readonly RunawayBehavior[] = [
  "ask",
  "cap",
  "stop",
];

/**
 * Twelve hours, asking rather than acting.
 *
 * Unlike idle detection this is ON by default, and the two defaults disagree
 * for a reason: idle's cheapest behaviour still shortens entries, so being
 * wrong costs the user time they worked. `ask` cannot lose a second — it
 * writes a marker and shows a prompt, and the entry keeps running until the
 * person answers. A guard that is off by default catches nothing, and the
 * failure it catches is one nobody notices until payroll.
 *
 * Twelve hours is chosen to sit above any believable single sitting and below
 * an overnight, so the Friday-evening timer is caught on Saturday morning
 * rather than on Monday.
 */
export const DEFAULT_MAX_DURATION_SETTINGS: MaxDurationSettings = {
  maxHours: 12,
  behavior: "ask",
  emailReminder: false,
};

/** Bounds shared by the zod schema, the Mongoose schema and the UI field. */
export const MIN_MAX_DURATION_HOURS = 1;
/** A week. Past this the setting is indistinguishable from switching it off. */
export const MAX_MAX_DURATION_HOURS = 168;

/**
 * `0` — and `null`/absent, which normalise to it — mean the guard is off.
 *
 * A single off-switch rather than a separate `enabled` flag: two ways to
 * disable one feature is two things to keep in step, and the number alone
 * already answers "after how long", including "never".
 */
export const isRunawayGuardOn = (
  settings: MaxDurationSettings | null | undefined,
): boolean =>
  settings !== null &&
  settings !== undefined &&
  Number.isFinite(settings.maxHours) &&
  settings.maxHours > 0;

/** The configured maximum in seconds, or 0 when the guard is off. */
export const runawayLimitSec = (
  settings: MaxDurationSettings | null | undefined,
): number =>
  isRunawayGuardOn(settings)
    ? Math.round((settings as MaxDurationSettings).maxHours * 3600)
    : 0;

// ── the decision ─────────────────────────────────────────────────────

/** Why the guard chose to do nothing. Carried so tests can assert intent. */
export type RunawaySkipReason =
  /** `maxHours` is 0 (or null/absent). */
  | "disabled"
  /** Long, but still inside the limit. */
  | "under-limit"
  /**
   * The guard has already recorded a mark on this entry.
   *
   * Deliberately once per entry, resolved or not. Re-flagging every time the
   * running entry is read would publish a sync event per read; and answering
   * "keep it" on a genuinely long timer is an answer that should hold for the
   * life of that entry rather than being asked again a minute later.
   */
  | "already-marked";

export type RunawayDecision =
  | { kind: "none"; reason: RunawaySkipReason }
  /** Record the mark, change nothing else. The entry keeps running. */
  | { kind: "flag"; mark: RunawayMark }
  /** End the entry at `endMs` — the limit, or the moment we noticed. */
  | { kind: "end"; endMs: number; mark: RunawayMark };

export type RunawayInput = {
  /** The running entry's start, in ms since the epoch. */
  startMs: number;
  /** Now, in ms since the epoch. */
  nowMs: number;
  settings: MaxDurationSettings | null | undefined;
  /** Whatever the guard already wrote onto this entry, if anything. */
  existing?: RunawayMark | null;
};

/**
 * What the guard should do about one running entry.
 *
 * Absolute elapsed time only: one subtraction of instants, no calendar and no
 * zone arithmetic. An entry that spans a DST change is exactly as long as the
 * clock says it is, which is the whole reason `timezone.ts` has no business
 * here.
 */
export const evaluateRunaway = (input: RunawayInput): RunawayDecision => {
  const limitSec = runawayLimitSec(input.settings);
  if (limitSec <= 0) return { kind: "none", reason: "disabled" };

  const elapsedSec = Math.max(
    0,
    Math.floor((input.nowMs - input.startMs) / 1000),
  );
  if (elapsedSec <= limitSec) return { kind: "none", reason: "under-limit" };

  if (input.existing) return { kind: "none", reason: "already-marked" };

  const behavior = (input.settings as MaxDurationSettings).behavior;
  const mark: RunawayMark = {
    detectedAt: new Date(input.nowMs).toISOString(),
    elapsedSec,
    limitSec,
    action: behavior === "ask" ? "flagged" : behavior === "cap" ? "capped" : "stopped",
    resolvedAt: null,
  };

  if (behavior === "ask") return { kind: "flag", mark };

  // `cap` truncates to the limit and throws the overrun away; `stop` keeps
  // every second and only closes the entry. Both set `end`, which is what
  // frees the one-running-timer slot (a partial unique index on `{ ownerId }`
  // where `end` is null). `ask` sets nothing, so it never touches that slot.
  const endMs =
    behavior === "cap" ? input.startMs + limitSec * 1000 : input.nowMs;

  // An entry must always end after it starts; the bounds make this
  // unreachable, and it is here so a future bound cannot make it reachable.
  return { kind: "end", endMs: Math.max(endMs, input.startMs + 1000), mark };
};

// ── undoing it ───────────────────────────────────────────────────────

/**
 * How the person answered the prompt.
 *
 * Every one of these is reachable from a marked entry, which is the point:
 * capping a 63-hour weekend discards 55 hours, and that must never be a thing
 * that happened invisibly and cannot be walked back. `elapsedSec` on the mark
 * is what makes `restore` possible — with the entry's `start` it reconstructs
 * the exact span the guard saw.
 */
export type RunawayResolution =
  /** Dismiss. Keep running if it is running, keep the cap if it was capped. */
  | "keep"
  /** End at `start + limitSec` — take the cap, or re-take it after a restore. */
  | "cap"
  /** End at `start + elapsedSec` — the full span the guard measured. */
  | "restore"
  /** End at an instant the person supplied. */
  | "end-at";

export const RUNAWAY_RESOLUTIONS: readonly RunawayResolution[] = [
  "keep",
  "cap",
  "restore",
  "end-at",
];

/**
 * The instant a resolution ends the entry at, or null for "change nothing".
 *
 * `end-at` is the only one that trusts a client-supplied instant; the other
 * two are recomputed here from the mark so a stale or edited client cannot
 * move the boundary to somewhere the guard never saw.
 */
export const resolvedEndMs = (
  resolution: RunawayResolution,
  startMs: number,
  mark: RunawayMark,
  suppliedEndMs?: number | null,
): number | null => {
  switch (resolution) {
    case "keep":
      return null;
    case "cap":
      return startMs + mark.limitSec * 1000;
    case "restore":
      return startMs + mark.elapsedSec * 1000;
    case "end-at":
      return suppliedEndMs ?? null;
  }
};

// ── labels ───────────────────────────────────────────────────────────

/** Short label, for the settings option group. */
export const runawayBehaviorLabel = (behavior: RunawayBehavior): string => {
  switch (behavior) {
    case "ask":
      return "Ask me";
    case "cap":
      return "Cap it";
    case "stop":
      return "Stop it";
  }
};

/** One sentence saying what the behaviour actually does to the entry. */
export const runawayBehaviorDescription = (
  behavior: RunawayBehavior,
): string => {
  switch (behavior) {
    case "ask":
      return "Leave the timer running and ask the next time you look. Nothing is shortened unless you say so.";
    case "cap":
      return "End the entry at the maximum and discard the overrun. The original span is kept on the entry so you can put it back.";
    case "stop":
      return "End the entry where it had got to. Every second is kept — the timer just stops growing.";
  }
};

/** Past-tense sentence for the prompt, e.g. after a cap has already happened. */
export const runawayActionSummary = (mark: RunawayMark): string => {
  switch (mark.action) {
    case "flagged":
      return "The timer is still running.";
    case "capped":
      return "The entry was cut back to the maximum.";
    case "stopped":
      return "The timer was stopped and the whole span kept.";
  }
};
