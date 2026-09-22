/*
 * The capture state machine, pure.
 *
 * Every input — a detection from the source, the one-minute heartbeat, an
 * idle or lock report, a settings change, a new account or workspace,
 * sign-out — is one `step`, which answers the next state and the storage
 * effects to apply. `install.ts` applies them through one serial queue; this
 * file reads no clock and touches no file, so every rule below is a unit test.
 *
 * The rules are the browser extension's (`background/activity/capture.ts`),
 * ported:
 *
 * - The open segment is persisted when it opens or changes and by the
 *   heartbeat; a detection of the same app only moves `lastSeen` in memory.
 * - A segment whose `lastSeen` is more than {@link STALE_AFTER_MS} old is
 *   closed AT `lastSeen`: the machine slept or the app died, and none of that
 *   time was spent in the app.
 * - The heartbeat never opens a segment. Only a detection says attention is
 *   somewhere.
 * - A segment is written under the settings current when it CLOSES, so
 *   excluding the app on screen, or switching titles off, never stores what
 *   the person just asked not to be stored.
 */

import { hostMatchesAny } from "../../../packages/core/src/activity/index.ts";
import type { DesktopActivitySettings } from "../../../packages/shared/src/desktop-bridge.ts";
import {
  ACTIVITY_KEY_MAX_LENGTH,
  cleanName,
  isBuiltInNeverRecord,
  toActivityKey,
  type DescribedTarget,
  type FrontmostTarget,
} from "./keys.ts";
import { accountPrefixOf, activityScopeOf } from "./settings.ts";

/** Three missed heartbeats: late timers must not split a stretch; a sleeping laptop misses far more. */
export const STALE_AFTER_MS = 3 * 60_000;
export const HEARTBEAT_MS = 60_000;
/** Below this many seconds without input the person is still at the machine. */
export const IDLE_THRESHOLD_SECONDS = 60;
export const TITLE_MAX_LENGTH = ACTIVITY_KEY_MAX_LENGTH;

export interface OpenSegment {
  scope: string;
  key: string;
  name: string;
  label?: string;
  start: number;
  lastSeen: number;
}

/** One closed segment as stored: core's `ActivitySegment` plus its scope and a display name. */
export interface StoredSegment {
  scope: string;
  source: "desktop";
  start: number;
  end: number;
  key: string;
  name: string;
  label?: string;
  afk: false;
}

export interface CaptureState {
  settings: DesktopActivitySettings;
  /** `<userId>:<workspaceId>`, or null before sign-in and after sign-out. */
  scope: string | null;
  open: OpenSegment | null;
  /** No input for at least {@link IDLE_THRESHOLD_SECONDS}. */
  idle: boolean;
  /** The screen is locked or the machine suspended. */
  locked: boolean;
  /**
   * Set by a lock or suspend and cleared only by input. Coming back from a
   * closed lid is not attention on whatever app happens to be in front.
   */
  awaitingInput: boolean;
}

export interface CaptureContext {
  /** Supported on this channel and OS, and the store is this build's format. */
  available: boolean;
  /** Whether this OS can record window titles at all (false on macOS for now). */
  titlesAvailable: boolean;
  /** This app's own process, never recorded. */
  selfPid: number;
}

export type PresenceState = "active" | "idle" | "locked";

export type CaptureEvent =
  | { kind: "boot" }
  | { kind: "detect"; target: FrontmostTarget | null }
  | { kind: "heartbeat" }
  | { kind: "presence"; state: PresenceState; idleSeconds: number }
  | { kind: "settings"; settings: DesktopActivitySettings }
  | { kind: "scope"; userId: string; workspaceId: string }
  /** Sign-out, a revoked device, account deletion: every row and the scope. */
  | { kind: "forget" }
  /** "Delete all activity now": every row; the scope stays. */
  | { kind: "wipe" };

export type CaptureEffect =
  | { kind: "append"; segment: StoredSegment }
  | { kind: "persist-open"; open: OpenSegment }
  | { kind: "clear-open" }
  /** Delete every stored segment whose key matches one of these patterns. */
  | { kind: "purge-apps"; patterns: string[] }
  /** Remove the label from every stored segment. */
  | { kind: "strip-labels" }
  /** Delete every segment, rule and dismissal whose scope does not start with this. */
  | { kind: "sweep-scopes"; keepPrefix: string }
  /** Delete every segment, rule and dismissal. */
  | { kind: "wipe" }
  | { kind: "prune" }
  /** Settings or scope changed: write them. */
  | { kind: "save-state" };

export interface StepResult {
  state: CaptureState;
  effects: CaptureEffect[];
}

export function initialCaptureState(
  settings: DesktopActivitySettings,
  scope: string | null,
  open: OpenSegment | null,
): CaptureState {
  return { settings, scope, open, idle: false, locked: false, awaitingInput: false };
}

/** Whether a detection may open a segment now. */
export function canRecord(state: CaptureState, ctx: CaptureContext): boolean {
  return (
    ctx.available &&
    state.settings.enabled &&
    state.scope !== null &&
    !state.idle &&
    !state.locked &&
    !state.awaitingInput
  );
}

/**
 * Whether the source should run at all. Not while idle or locked: presence
 * comes from the idle monitor, never from the source, so nothing is lost.
 */
export function shouldCapture(state: CaptureState, ctx: CaptureContext): boolean {
  return ctx.available && state.settings.enabled && state.scope !== null && !state.idle && !state.locked;
}

/** The recordable identity of what is in front, or null when it must not be recorded. */
export function describeTarget(
  target: FrontmostTarget | null,
  settings: DesktopActivitySettings,
  ctx: CaptureContext,
): DescribedTarget | null {
  if (target === null) return null;
  const key = toActivityKey(target.key);
  if (key === "") return null;
  if (isBuiltInNeverRecord(key, target.pid, ctx.selfPid)) return null;
  if (hostMatchesAny(settings.excludedApps, key)) return null;
  const name = cleanName(target.name, key);
  const title = target.title?.replace(/\s+/g, " ").trim();
  return settings.storeTitles && ctx.titlesAvailable && title !== undefined && title !== ""
    ? { key, name, label: title.slice(0, TITLE_MAX_LENGTH) }
    : { key, name };
}

/** The segment `open` becomes when closed at `end`, or null when it must not be written. */
export function closedSegment(
  open: OpenSegment,
  end: number,
  settings: DesktopActivitySettings,
  ctx: CaptureContext,
): StoredSegment | null {
  if (hostMatchesAny(settings.excludedApps, open.key)) return null;
  const stop = Math.max(open.start, end);
  if (stop <= open.start) return null;
  const keepLabel = open.label !== undefined && settings.storeTitles && ctx.titlesAvailable;
  return {
    scope: open.scope,
    source: "desktop",
    start: open.start,
    end: stop,
    key: open.key,
    name: open.name,
    ...(keepLabel ? { label: open.label } : {}),
    afk: false,
  };
}

/** A small builder so each branch below reads as the rule it is. */
class Step {
  effects: CaptureEffect[] = [];
  constructor(
    public state: CaptureState,
    readonly ctx: CaptureContext,
  ) {}

  set(patch: Partial<CaptureState>): void {
    this.state = { ...this.state, ...patch };
  }

  /** Close the open segment at `end` under the current settings, and forget it. */
  close(end: number): void {
    const open = this.state.open;
    if (open === null) return;
    const segment = closedSegment(open, end, this.state.settings, this.ctx);
    if (segment !== null) this.effects.push({ kind: "append", segment });
    this.drop();
  }

  /** Forget the open segment without writing it. */
  drop(): void {
    if (this.state.open === null) return;
    this.set({ open: null });
    this.effects.push({ kind: "clear-open" });
  }

  /** A segment nobody has confirmed for too long ended when it was last seen. */
  closeStale(now: number): void {
    const open = this.state.open;
    if (open !== null && now - open.lastSeen > STALE_AFTER_MS) this.close(open.lastSeen);
  }

  result(): StepResult {
    return { state: this.state, effects: this.effects };
  }
}

export function step(state: CaptureState, event: CaptureEvent, now: number, ctx: CaptureContext): StepResult {
  const s = new Step(state, ctx);

  switch (event.kind) {
    case "boot": {
      s.closeStale(now);
      const open = s.state.open;
      // Written by an earlier run under settings or an account that no longer
      // hold: it ended when it was last seen.
      if (open !== null && (!s.state.settings.enabled || open.scope !== s.state.scope || !ctx.available)) {
        s.close(open.lastSeen);
      }
      return s.result();
    }

    case "detect": {
      s.closeStale(now);
      const target = canRecord(s.state, ctx) ? describeTarget(event.target, s.state.settings, ctx) : null;
      const open = s.state.open;
      if (target === null) {
        s.close(now);
        return s.result();
      }
      if (open !== null && open.scope === s.state.scope && open.key === target.key && open.label === target.label) {
        // Same app, same title: only `lastSeen` moves, in memory. The
        // heartbeat persists it; a write per poll would be a write every 5 s.
        s.set({ open: { ...open, lastSeen: now, name: target.name } });
        return s.result();
      }
      s.close(now);
      const next: OpenSegment = {
        scope: s.state.scope as string,
        key: target.key,
        name: target.name,
        ...(target.label !== undefined ? { label: target.label } : {}),
        start: now,
        lastSeen: now,
      };
      s.set({ open: next });
      s.effects.push({ kind: "persist-open", open: next });
      return s.result();
    }

    case "heartbeat": {
      s.closeStale(now);
      const open = s.state.open;
      if (open === null) return s.result();
      if (!canRecord(s.state, ctx) || open.scope !== s.state.scope) {
        s.close(now);
        return s.result();
      }
      const refreshed = { ...open, lastSeen: now };
      s.set({ open: refreshed });
      s.effects.push({ kind: "persist-open", open: refreshed });
      return s.result();
    }

    case "presence": {
      s.closeStale(now);
      if (event.state === "locked") {
        s.close(now);
        s.set({ locked: true, awaitingInput: true });
        return s.result();
      }
      if (event.state === "active") {
        s.set({ locked: false, idle: false, awaitingInput: false });
        return s.result();
      }
      s.set({ locked: false });
      if (event.idleSeconds >= IDLE_THRESHOLD_SECONDS) {
        // The OS reports idleness once it has already lasted: those seconds
        // were not spent in the app, so the segment ends where input stopped.
        const open = s.state.open;
        if (open !== null) s.close(Math.max(open.start, now - event.idleSeconds * 1000));
        s.set({ idle: true });
      } else if (s.state.idle) {
        // Input landed between two samples.
        s.set({ idle: false });
      }
      return s.result();
    }

    case "settings": {
      const previous = s.state.settings;
      const next = event.settings;
      s.set({ settings: next });
      s.effects.push({ kind: "save-state" });

      const added = next.excludedApps.filter((pattern) => !previous.excludedApps.includes(pattern));
      if (added.length > 0) {
        // "Never record" covers what is already stored, not just what comes next.
        s.effects.push({ kind: "purge-apps", patterns: added });
        const open = s.state.open;
        if (open !== null && hostMatchesAny(added, open.key)) s.drop();
      }
      if (previous.storeTitles && !next.storeTitles) {
        // Stricter than the extension on purpose: off means no stored titles.
        s.effects.push({ kind: "strip-labels" });
        s.close(now);
      }
      if (previous.retentionDays !== next.retentionDays) s.effects.push({ kind: "prune" });
      if (!canRecord(s.state, ctx)) s.close(now);
      return s.result();
    }

    case "scope": {
      const scope = activityScopeOf(event.userId, event.workspaceId);
      if (scope === s.state.scope) return s.result();
      const prefix = accountPrefixOf(event.userId);
      const open = s.state.open;
      // The same person's other workspace keeps what it recorded; another
      // account's open segment is never written.
      if (open !== null && open.scope.startsWith(prefix)) s.close(now);
      else s.drop();
      s.effects.push({ kind: "sweep-scopes", keepPrefix: prefix });
      s.set({ scope });
      s.effects.push({ kind: "save-state" });
      return s.result();
    }

    case "forget": {
      s.drop();
      s.effects.push({ kind: "wipe" });
      s.set({ scope: null });
      s.effects.push({ kind: "save-state" });
      return s.result();
    }

    case "wipe": {
      s.drop();
      s.effects.push({ kind: "wipe" });
      return s.result();
    }
  }
}
