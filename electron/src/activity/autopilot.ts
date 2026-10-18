/*
 * Autopilot, in the main process: the memory around core's `decideAutopilot`.
 *
 * Core decides from one moment's facts. What has to be remembered between
 * moments lives here:
 *
 * - **Which timer is Autopilot's.** A write is only counted once the renderer
 *   reports it made (`applied`), and the running entry stays Autopilot's only
 *   while its start and filing are exactly what was written. An edit, a stop
 *   or a new start by hand makes it the person's, for good.
 * - **What the person said no to.** A timer stopped or replaced by hand, an
 *   Undo, or "not work" puts that filing (or app) on hold until the next break
 *   of {@link HOLD_BREAK_MS} — so a stopped timer does not come straight back.
 * - **What was learned** from the person's own entries, per scope.
 * - **What it did**, as a short log for the screen.
 *
 * No Electron and no file access: the service hands everything in and persists
 * `owned` through the store, so all of it runs under node:test.
 */

import { randomUUID } from "node:crypto";

import {
  DEFAULT_AUTOPILOT_OPTIONS,
  createFilingResolver,
  decideAutopilot,
  filingKeyOf,
  hadBreakSince,
  learnFilings,
  appHoldKey,
  type ActivityInterval,
  type ActivityRule,
  type ActivitySegment,
  type AutopilotDecision,
  type AutopilotFiling,
} from "../../../packages/core/src/activity/index.ts";
import type {
  DesktopActivityApp,
  DesktopActivitySettings,
  DesktopAutopilotHistoryEntry,
  DesktopAutopilotLogEntry,
  DesktopAutopilotPlan,
  DesktopAutopilotRunning,
  DesktopAutopilotState,
  DesktopAutopilotWatch,
} from "../../../packages/shared/src/desktop-bridge.ts";

const MINUTE_MS = 60_000;

/** A hold ends at the first stretch this long with no activity at all. */
export const HOLD_BREAK_MS = 10 * MINUTE_MS;
/** …or after this long, whatever happened. */
export const HOLD_MAX_MS = 4 * 60 * MINUTE_MS;
/** How long the renderer's running entry may lag a write it reported made. */
export const SETTLE_MS = 30_000;
/** A plan not reported back within this long is forgotten. */
export const PENDING_TTL_MS = 60_000;
/** Two starts this close are one start (the server keeps milliseconds; be lenient). */
export const SAME_START_MS = 1_000;
export const LOG_MAX = 30;
export const LOG_TTL_MS = 24 * 60 * MINUTE_MS;
/** How much activity a decision reads back. */
export const AUTOPILOT_WINDOW_MS = DEFAULT_AUTOPILOT_OPTIONS.lookbackMs + HOLD_BREAK_MS;

/** The Autopilot-owned timer, as persisted (state.json) so a restart keeps it. */
export interface OwnedTimer {
  scope: string;
  start: number;
  filingKey: string;
  app: DesktopActivityApp | null;
  via: "rule" | "learned";
  logId: string;
}

export interface PlanContext {
  scope: string;
  now: number;
  settings: DesktopActivitySettings;
  /** Switched on, capture supported and recording for an account. */
  active: boolean;
  /** The scope's segments for the last {@link AUTOPILOT_WINDOW_MS}, the open one included. */
  segments: readonly ActivitySegment[];
  names: ReadonlyMap<string, string>;
  rules: readonly ActivityRule[];
  /** Everything tracked without the running entry, plus dismissals and just-accepted spans. */
  holes: readonly ActivityInterval[];
  running: DesktopAutopilotRunning | null;
}

interface Pending {
  token: string;
  scope: string;
  at: number;
  decision: Exclude<AutopilotDecision, { kind: "none" }>;
  /** The app the plan named, with the name it showed. */
  app: DesktopActivityApp | null;
}

interface RunningKey {
  start: number;
  filingKey: string;
}

interface LoggedAction extends DesktopAutopilotLogEntry {
  scope: string;
}

export interface AutopilotController {
  learn: (scope: string, history: readonly DesktopAutopilotHistoryEntry[], segments: readonly ActivitySegment[]) => void;
  plan: (context: PlanContext) => DesktopAutopilotPlan;
  /**
   * The renderer made (or failed to make) the write for `token`. `written`
   * is what it actually filed, which can differ from the plan when the
   * catalog no longer had a project. Returns whether anything changed.
   */
  applied: (
    result: { token: string; ok: boolean; written?: { description: string; projectId: string | null; taskId: string | null } },
    now: number,
  ) => boolean;
  hold: (scope: string, input: { filingKey?: string; appKey?: string; logId?: string }, now: number) => void;
  state: (scope: string | null, active: boolean, now: number) => DesktopAutopilotState;
  /** Forget everything: sign-out, wipe, another scope. */
  reset: () => void;
}

const runningKeyOf = (running: DesktopAutopilotRunning | null): RunningKey | null =>
  running === null ? null : { start: running.start, filingKey: filingKeyOf(running) };

const sameRunning = (a: RunningKey | null, b: RunningKey | null): boolean =>
  a === null || b === null
    ? a === b
    : Math.abs(a.start - b.start) < SAME_START_MS && a.filingKey === b.filingKey;

const appOf = (key: string, names: ReadonlyMap<string, string>): DesktopActivityApp => ({
  key,
  name: names.get(key) ?? key,
});

const copyFiling = (filing: AutopilotFiling): AutopilotFiling => ({
  key: filing.key,
  via: filing.via,
  fields: { ...filing.fields, ...(filing.fields.tagIds !== undefined ? { tagIds: [...filing.fields.tagIds] } : {}) },
  ...(filing.ruleId !== undefined ? { ruleId: filing.ruleId } : {}),
});

export function createAutopilotController(options: {
  /** The persisted owned timer, read at boot. */
  initialOwned: OwnedTimer | null;
  saveOwned: (owned: OwnedTimer | null) => void;
  newId?: () => string;
}): AutopilotController {
  const newId = options.newId ?? randomUUID;
  let owned: OwnedTimer | null = options.initialOwned;
  /** What the running entry was at the last plan, to notice it change by hand. */
  let lastRunning: { scope: string; key: RunningKey | null } | null = null;
  /** The last write reported made, until the renderer's running entry shows it. */
  let settling: { scope: string; at: number; expect: RunningKey | null } | null = null;
  const holds = new Map<string, { scope: string; at: number }>();
  const learned = new Map<string, Map<string, AutopilotFiling>>();
  const pending = new Map<string, Pending>();
  let log: LoggedAction[] = [];
  let watch: { scope: string; value: DesktopAutopilotWatch } | null = null;

  const setOwned = (next: OwnedTimer | null): void => {
    if (owned === next) return;
    owned = next;
    options.saveOwned(next);
  };

  const addHold = (scope: string, key: string, now: number): void => {
    holds.set(`${scope}\u0000${key}`, { scope, at: now });
  };

  const heldKeys = (scope: string): Set<string> => {
    const out = new Set<string>();
    for (const [compound, hold] of holds) {
      if (hold.scope === scope) out.add(compound.slice(scope.length + 1));
    }
    return out;
  };

  const releaseHolds = (scope: string, segments: readonly ActivitySegment[], now: number): void => {
    for (const [compound, hold] of holds) {
      if (hold.scope !== scope) continue;
      if (now - hold.at > HOLD_MAX_MS || hadBreakSince(segments, hold.at, now, HOLD_BREAK_MS)) holds.delete(compound);
    }
  };

  const prunePending = (now: number): void => {
    for (const [token, entry] of pending) if (now - entry.at > PENDING_TTL_MS) pending.delete(token);
  };

  return {
    learn: (scope, history, segments) => {
      learned.set(
        scope,
        learnFilings(
          segments,
          history.map((entry) => ({ ...entry, tagIds: [...entry.tagIds] })),
        ),
      );
    },

    plan: (context) => {
      const { scope, now } = context;
      prunePending(now);
      if (!context.active) {
        watch = null;
        lastRunning = null;
        return { kind: "none" };
      }
      releaseHolds(scope, context.segments, now);

      const current = runningKeyOf(context.running);

      // A write reported made that the renderer does not show yet: decide
      // nothing, and above all do not read the gap as a stop by hand.
      if (settling !== null && settling.scope === scope) {
        if (sameRunning(current, settling.expect)) settling = null;
        else if (now - settling.at < SETTLE_MS) return { kind: "none" };
        else settling = null;
      }

      // The running entry changed, and not by Autopilot's hand: whatever was
      // running before was the person's decision to end. Hold it.
      const previous = lastRunning !== null && lastRunning.scope === scope ? lastRunning.key : null;
      if (previous !== null && !sameRunning(previous, current)) addHold(scope, previous.filingKey, now);
      lastRunning = { scope, key: current };

      const ownedNow =
        owned !== null &&
        owned.scope === scope &&
        current !== null &&
        sameRunning(current, { start: owned.start, filingKey: owned.filingKey });
      if (owned !== null && owned.scope === scope && !ownedNow) setOwned(null);

      const decision = decideAutopilot({
        now,
        segments: context.segments,
        tracked: context.holes,
        running: current === null ? null : { ...current, owned: ownedNow },
        resolve: createFilingResolver(context.rules, learned.get(scope) ?? new Map()),
        held: heldKeys(scope),
        options: { startAfterMs: context.settings.autopilotStartMinutes * MINUTE_MS },
      });

      if (decision.kind === "none") {
        const seen = decision.watch;
        watch =
          seen === null
            ? null
            : {
                scope,
                value: {
                  app: appOf(seen.appKey, context.names),
                  since: seen.since,
                  creditedMs: seen.creditedMs,
                  filing: seen.filing === null ? null : copyFiling(seen.filing),
                  held: seen.held,
                },
              };
        return { kind: "none" };
      }

      watch = null;
      const token = newId();
      if (decision.kind === "stop") {
        const app = owned?.app ?? null;
        pending.set(token, { token, scope, at: now, decision, app });
        return { kind: "stop", token, at: decision.at, app };
      }
      const app = appOf(decision.appKey, context.names);
      pending.set(token, { token, scope, at: now, decision, app });
      return {
        kind: decision.kind,
        token,
        at: decision.at,
        filing: copyFiling(decision.filing),
        app,
        creditedMs: decision.creditedMs,
      };
    },

    applied: (result, now) => {
      const entry = pending.get(result.token);
      if (entry === undefined) return false;
      pending.delete(result.token);
      const { decision, scope, app } = entry;

      if (!result.ok) {
        // Refused or failed: do not try the same thing again until a break.
        if (decision.kind !== "stop") addHold(scope, decision.filing.key, now);
        return false;
      }

      const logId = newId();
      if (decision.kind === "stop") {
        setOwned(null);
        settling = { scope, at: now, expect: null };
        lastRunning = { scope, key: null };
        log = [{ scope, id: logId, kind: "stop", at: decision.at, decidedAt: now, app, filing: null, undone: false }, ...log];
      } else {
        const writtenKey = result.written === undefined ? decision.filing.key : filingKeyOf(result.written);
        const expect: RunningKey = { start: decision.at, filingKey: writtenKey };
        setOwned({ scope, start: decision.at, filingKey: writtenKey, app, via: decision.filing.via, logId });
        settling = { scope, at: now, expect };
        lastRunning = { scope, key: expect };
        log = [
          {
            scope,
            id: logId,
            kind: decision.kind,
            at: decision.at,
            decidedAt: now,
            app,
            filing: copyFiling(decision.filing),
            undone: false,
          },
          ...log,
        ];
      }
      log = log.filter((action) => now - action.decidedAt < LOG_TTL_MS).slice(0, LOG_MAX);
      return true;
    },

    hold: (scope, input, now) => {
      if (input.filingKey !== undefined) addHold(scope, input.filingKey, now);
      if (input.appKey !== undefined) addHold(scope, appHoldKey(input.appKey), now);
      if (input.logId !== undefined) {
        log = log.map((action) => (action.scope === scope && action.id === input.logId ? { ...action, undone: true } : action));
        if (owned !== null && owned.scope === scope && owned.logId === input.logId) setOwned(null);
      }
    },

    state: (scope, active, now) => {
      const mine = scope === null ? [] : log.filter((action) => action.scope === scope && now - action.decidedAt < LOG_TTL_MS);
      return {
        active,
        owned:
          active && owned !== null && owned.scope === scope
            ? { start: owned.start, filingKey: owned.filingKey, app: owned.app, via: owned.via, logId: owned.logId }
            : null,
        watch: active && watch !== null && watch.scope === scope ? watch.value : null,
        log: mine.map(({ scope: _scope, ...action }) => action),
        learnedApps: scope === null ? 0 : (learned.get(scope)?.size ?? 0),
      };
    },

    reset: () => {
      setOwned(null);
      lastRunning = null;
      settling = null;
      holds.clear();
      learned.clear();
      pending.clear();
      log = [];
      watch = null;
    },
  };
}
