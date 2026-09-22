/*
 * Desktop activity capture, assembled: the store, the state machine, one
 * source, and the operations the bridge offers. No Electron import — IPC,
 * the idle monitor and pushes are wired in `install.ts` — so the whole
 * service runs under node:test against a temp directory and the fake source.
 *
 * Every mutation runs through `serial()`: a detection, a heartbeat and a
 * settings change arriving together must not each read "no open segment"
 * and each open one.
 *
 * Capture never starts on its own. The source runs only while the person
 * turned capture on, an account is known, the channel supports it, the store
 * is this build's format, and they are neither idle nor locked
 * (`shouldCapture`). Nothing here turns `enabled` on except
 * `updateSettings`, which only the renderer calls.
 */

import { randomUUID } from "node:crypto";

import { hostMatchesAny } from "../../../packages/core/src/activity/index.ts";
import type {
  DesktopActivityAcceptCheck,
  DesktopActivityInterval,
  DesktopActivityRule,
  DesktopActivitySettings,
  DesktopActivitySnapshot,
  DesktopActivitySuggestion,
  DesktopActivitySupport,
} from "../../../packages/shared/src/desktop-bridge.ts";
import type { ActivityCaptureSupport } from "../distribution.ts";
import {
  initialCaptureState,
  shouldCapture,
  step,
  type CaptureContext,
  type CaptureEffect,
  type CaptureEvent,
  type CaptureState,
  type PresenceState,
} from "./model.ts";
import { parseActivitySettings } from "./settings.ts";
import type { FrontmostSource, SourceFailure, SourceKind } from "./source.ts";
import { createActivityStore, type ActivityStore } from "./store.ts";
import {
  acceptRange,
  checkAccept as checkAcceptAgainst,
  composeSuggestions,
  liveAccepted,
  namesOf,
  recentApps,
  withOpenSegment,
  type AcceptedSpan,
} from "./suggest.ts";

export interface ActivityServiceOptions {
  userData: string;
  support: ActivityCaptureSupport;
  /** Whether this OS can record window titles (false on macOS for now). */
  titlesAvailable: boolean;
  /** Null when the channel is unsupported: there is nothing to start. */
  source: FrontmostSource | null;
  selfPid: number;
  now?: () => number;
  /** Called after any change a snapshot would show (install.ts throttles it). */
  onChanged?: () => void;
}

export interface ActivityService {
  snapshot: () => Promise<DesktopActivitySnapshot>;
  updateSettings: (patch: Partial<DesktopActivitySettings>) => Promise<DesktopActivitySnapshot>;
  setScope: (scope: { userId: string; workspaceId: string }) => Promise<void>;
  forget: () => Promise<void>;
  wipe: () => Promise<DesktopActivitySnapshot>;
  suggestions: (input: {
    from: number;
    to: number;
    tracked: DesktopActivityInterval[];
  }) => Promise<DesktopActivitySuggestion[] | null>;
  checkAccept: (input: {
    start: number;
    end: number;
    edited: boolean;
    tracked: DesktopActivityInterval[];
  }) => Promise<DesktopActivityAcceptCheck>;
  markAccepted: (span: DesktopActivityInterval) => Promise<void>;
  dismiss: (span: DesktopActivityInterval) => Promise<boolean>;
  addRule: (rule: Omit<DesktopActivityRule, "id">) => Promise<DesktopActivityRule[]>;
  removeRule: (id: string) => Promise<DesktopActivityRule[]>;

  // ── driven by install.ts ──
  heartbeat: () => Promise<void>;
  presence: (state: PresenceState, idleSeconds: number) => Promise<void>;
  prune: () => Promise<void>;
  /** Wait for every queued operation. */
  settled: () => Promise<void>;
  /** Persist the open segment and stop the source; used on quit. */
  dispose: () => void;

  // ── test seams (the headless hook) ──
  sourceKind: () => SourceKind | null;
  setSupportOverride: (support: DesktopActivitySupport | null) => Promise<void>;
  setTitlesAvailable: (on: boolean) => Promise<void>;
  files: () => ReturnType<ActivityStore["files"]>;
}

export function createActivityService(options: ActivityServiceOptions): ActivityService {
  const now = options.now ?? Date.now;
  const store = createActivityStore(options.userData, now);
  const source = options.source;
  let titlesAvailable = options.titlesAvailable;
  let supportOverride: DesktopActivitySupport | null = null;
  let runtimeFailure: SourceFailure | null = null;
  let sourceRunning = false;
  let sourceRun = 0;
  let accepted: AcceptedSpan[] = [];
  let disposed = false;

  let state: CaptureState = initialCaptureState(store.settings(), store.scope(), store.readOpen());

  // ── serial queue ────────────────────────────────────────────────────
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => T | Promise<T>): Promise<T> => {
    const next = queue.then(task, task);
    queue = next.catch((error: unknown) => {
      console.warn("[activity] step failed", error);
    });
    return next;
  };

  const changed = (): void => {
    options.onChanged?.();
  };

  // ── support ─────────────────────────────────────────────────────────
  const channelSupport = (): DesktopActivitySupport => {
    if (supportOverride !== null) return supportOverride;
    if (options.support.kind === "unsupported") return { supported: false, reason: options.support.reason, hint: null };
    return { supported: true };
  };

  const support = (): DesktopActivitySupport => {
    if (store.status === "newer-format") return { supported: false, reason: "newer-format", hint: null };
    const base = channelSupport();
    if (!base.supported) return base;
    if (runtimeFailure !== null) return { supported: false, reason: runtimeFailure.reason, hint: runtimeFailure.hint };
    return base;
  };

  const ctx = (): CaptureContext => ({
    available: store.status === "ok" && channelSupport().supported && source !== null,
    titlesAvailable,
    selfPid: options.selfPid,
  });

  // ── applying a step ─────────────────────────────────────────────────
  const applyEffect = (effect: CaptureEffect): void => {
    switch (effect.kind) {
      case "append":
        store.append(effect.segment);
        return;
      case "persist-open":
        store.writeOpen(effect.open);
        return;
      case "clear-open":
        store.writeOpen(null);
        return;
      case "purge-apps":
        store.rewriteSegments((segment) => (hostMatchesAny(effect.patterns, segment.key) ? null : segment));
        return;
      case "strip-labels":
        store.rewriteSegments((segment) => {
          if (segment.label === undefined) return segment;
          const { label: _label, ...rest } = segment;
          return rest;
        });
        return;
      case "sweep-scopes":
        store.sweepScopes(effect.keepPrefix);
        return;
      case "wipe":
        store.wipe();
        accepted = [];
        return;
      case "prune":
        store.prune(now(), state.settings.retentionDays);
        return;
      case "save-state":
        store.saveState(state.settings, state.scope);
        return;
    }
  };

  const syncSource = (): void => {
    if (source === null) return;
    const want = !disposed && shouldCapture(state, ctx());
    source.setTitles(state.settings.storeTitles && titlesAvailable);
    if (want && !sourceRunning) {
      sourceRunning = true;
      const run = ++sourceRun;
      // Answers from a run that has since been stopped are dropped.
      const current = (): boolean => sourceRunning && run === sourceRun;
      source.start({
        target: (target) =>
          void serial(() => {
            if (current()) apply({ kind: "detect", target });
          }),
        failure: (failure) =>
          void serial(() => {
            if (!current()) return;
            const before = runtimeFailure;
            runtimeFailure = failure;
            // A source that cannot answer cannot vouch for the open segment.
            if (failure !== null) apply({ kind: "detect", target: null });
            if (before?.reason !== failure?.reason) changed();
          }),
      });
    } else if (!want && sourceRunning) {
      sourceRunning = false;
      runtimeFailure = null;
      source.stop();
    }
  };

  const apply = (event: CaptureEvent): void => {
    if (disposed) return;
    const before = state;
    const result = step(state, event, now(), ctx());
    state = result.state;
    for (const effect of result.effects) applyEffect(effect);
    syncSource();
    if (result.effects.length > 0 || before.idle !== state.idle || before.locked !== state.locked) changed();
  };

  // ── snapshot ────────────────────────────────────────────────────────
  const scopeSegments = (scope: string) => withOpenSegment(store.allSegments(scope), state.open, scope, now());

  const buildSnapshot = (): DesktopActivitySnapshot => {
    const scope = state.scope;
    const segments = scope === null ? [] : scopeSegments(scope);
    const currentSupport = support();
    return {
      settings: { ...state.settings, excludedApps: [...state.settings.excludedApps] },
      support: currentSupport,
      titlesAvailable,
      scoped: scope !== null,
      recording:
        state.settings.enabled && currentSupport.supported && scope !== null && !state.idle && !state.locked,
      storedSegments: scope === null ? 0 : store.allSegments(scope).length,
      recentApps: recentApps(segments),
      rules: scope === null ? [] : store.rules(scope),
    };
  };

  const compose = (scope: string, from: number, to: number, tracked: readonly DesktopActivityInterval[]) => {
    const at = now();
    accepted = liveAccepted(accepted, at);
    const all = scopeSegments(scope);
    return composeSuggestions({
      segments: all.filter((segment) => segment.end > from && segment.start < to),
      names: namesOf(all),
      from,
      to,
      holes: [...tracked, ...store.dismissals(scope), ...accepted.map(({ start, end }) => ({ start, end }))],
      rules: store.rules(scope),
    });
  };

  // ── boot ────────────────────────────────────────────────────────────
  void serial(() => {
    apply({ kind: "boot" });
    store.prune(now(), state.settings.retentionDays);
  });

  return {
    snapshot: () => serial(buildSnapshot),

    updateSettings: (patch) =>
      serial(() => {
        if (store.status !== "ok") return buildSnapshot();
        apply({ kind: "settings", settings: parseActivitySettings({ ...state.settings, ...patch }) });
        return buildSnapshot();
      }),

    setScope: (scope) =>
      serial(() => {
        // A newer build's folder: its own build runs the sweep when it next sees a change.
        if (store.status !== "ok") return;
        if (state.scope !== `${scope.userId}:${scope.workspaceId}`) accepted = [];
        apply({ kind: "scope", userId: scope.userId, workspaceId: scope.workspaceId });
      }),

    forget: () =>
      serial(() => {
        accepted = [];
        apply({ kind: "forget" });
      }),

    wipe: () =>
      serial(() => {
        apply({ kind: "wipe" });
        return buildSnapshot();
      }),

    suggestions: (input) =>
      serial(() => {
        const scope = state.scope;
        if (scope === null || store.status !== "ok") return null;
        return compose(scope, input.from, input.to, input.tracked);
      }),

    checkAccept: (input) =>
      serial((): DesktopActivityAcceptCheck => {
        const scope = state.scope;
        if (scope === null || store.status !== "ok") return { ok: false, reason: "no-scope" };
        if (!(input.end > input.start)) return { ok: false, reason: "bad-range" };
        const range = acceptRange(input.start, input.end, now());
        if (!(range.to > range.from)) return { ok: false, reason: "already-tracked" };
        return checkAcceptAgainst(input, compose(scope, range.from, range.to, input.tracked));
      }),

    markAccepted: (span) =>
      serial(() => {
        accepted = [...liveAccepted(accepted, now()), { ...span, at: now() }];
        changed();
      }),

    dismiss: (span) =>
      serial(() => {
        const scope = state.scope;
        if (scope === null || store.status !== "ok") return false;
        store.addDismissal(scope, span);
        changed();
        return true;
      }),

    addRule: (input) =>
      serial(() => {
        const scope = state.scope;
        if (scope === null || store.status !== "ok") return [];
        store.putRule(scope, { ...input, id: randomUUID() }, now());
        changed();
        return store.rules(scope);
      }),

    removeRule: (id) =>
      serial(() => {
        const scope = state.scope;
        if (scope === null || store.status !== "ok") return [];
        store.deleteRule(scope, id);
        changed();
        return store.rules(scope);
      }),

    heartbeat: () => serial(() => apply({ kind: "heartbeat" })),
    presence: (presence, idleSeconds) =>
      serial(() => apply({ kind: "presence", state: presence, idleSeconds })),
    prune: () =>
      serial(() => {
        if (store.prune(now(), state.settings.retentionDays) > 0) changed();
      }),
    settled: () => serial(() => undefined),

    dispose: () => {
      if (disposed) return;
      // The open segment keeps its lastSeen, so the next launch closes it
      // there — the time the app was not running was not spent in the app.
      if (state.open !== null) store.writeOpen(state.open);
      disposed = true;
      if (sourceRunning) source?.stop();
      sourceRunning = false;
    },

    sourceKind: () => source?.kind ?? null,
    setSupportOverride: (next) =>
      serial(() => {
        supportOverride = next;
        apply({ kind: "detect", target: null });
        changed();
      }),
    setTitlesAvailable: (on) =>
      serial(() => {
        titlesAvailable = on;
        syncSource();
        changed();
      }),
    files: () => store.files(),
  };
}
