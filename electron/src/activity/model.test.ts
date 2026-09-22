import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DesktopActivitySettings } from "../../../packages/shared/src/desktop-bridge.ts";
import {
  initialCaptureState,
  STALE_AFTER_MS,
  step,
  type CaptureContext,
  type CaptureEffect,
  type CaptureEvent,
  type CaptureState,
  type StoredSegment,
} from "./model.ts";
import { DEFAULT_ACTIVITY_SETTINGS } from "./settings.ts";

const ctx: CaptureContext = { available: true, titlesAvailable: true, selfPid: 4242 };
const on: DesktopActivitySettings = { ...DEFAULT_ACTIVITY_SETTINGS, enabled: true };
const T0 = Date.UTC(2026, 8, 22, 9, 0, 0);
const MIN = 60_000;

const editor = { key: "com.example.Editor", name: "Editor" };
const chat = { key: "com.example.chat", name: "Chat" };

/** Run events in order, collecting every effect. */
function run(
  start: CaptureState,
  events: [number, CaptureEvent][],
  context: CaptureContext = ctx,
): { state: CaptureState; effects: CaptureEffect[] } {
  let state = start;
  const effects: CaptureEffect[] = [];
  for (const [at, event] of events) {
    const result = step(state, event, at, context);
    state = result.state;
    effects.push(...result.effects);
  }
  return { state, effects };
}

const appended = (effects: CaptureEffect[]): StoredSegment[] =>
  effects.flatMap((effect) => (effect.kind === "append" ? [effect.segment] : []));

const scoped = (settings: DesktopActivitySettings = on): CaptureState => initialCaptureState(settings, "u1:w1", null);

describe("detect", () => {
  it("opens, extends in memory and switches", () => {
    const { state, effects } = run(scoped(), [
      [T0, { kind: "detect", target: editor }],
      [T0 + 5_000, { kind: "detect", target: editor }],
      [T0 + 2 * MIN, { kind: "detect", target: editor }],
      [T0 + 3 * MIN, { kind: "heartbeat" }],
      [T0 + 5 * MIN, { kind: "detect", target: chat }],
    ]);
    // Opening and the heartbeat persist; extending does not; switching closes and opens.
    assert.deepEqual(
      effects.map((effect) => effect.kind),
      ["persist-open", "persist-open", "append", "clear-open", "persist-open"],
    );
    assert.deepEqual(appended(effects), [
      {
        scope: "u1:w1",
        source: "desktop",
        start: T0,
        end: T0 + 5 * MIN,
        key: "com.example.editor",
        name: "Editor",
        afk: false,
      },
    ]);
    assert.equal(state.open?.key, "com.example.chat");
    assert.equal(state.open?.start, T0 + 5 * MIN);
  });

  it("closes on null, on this app and on the lock screen", () => {
    for (const target of [
      null,
      { key: "com.trebeljahr.trackyourtime", name: "Track Your Time" },
      { key: "anything", name: "Me", pid: 4242 },
      { key: "com.apple.loginwindow", name: "loginwindow" },
      { key: "LockApp.exe", name: "LockApp" },
    ]) {
      const { state, effects } = run(scoped(), [
        [T0, { kind: "detect", target: editor }],
        [T0 + MIN, { kind: "detect", target }],
      ]);
      assert.equal(state.open, null);
      assert.equal(appended(effects)[0]?.end, T0 + MIN);
    }
  });

  it("records nothing while capture is off, without a scope, or unavailable", () => {
    const cases: [CaptureState, CaptureContext][] = [
      [scoped(DEFAULT_ACTIVITY_SETTINGS), ctx],
      [initialCaptureState(on, null, null), ctx],
      [scoped(), { ...ctx, available: false }],
    ];
    for (const [state, context] of cases) {
      const result = run(state, [[T0, { kind: "detect", target: editor }]], context);
      assert.equal(result.state.open, null);
      assert.deepEqual(result.effects, []);
    }
  });

  it("closes a stale segment at lastSeen before looking at the new detection", () => {
    const { effects } = run(scoped(), [
      [T0, { kind: "detect", target: editor }],
      [T0 + MIN, { kind: "detect", target: editor }],
      [T0 + MIN + STALE_AFTER_MS + 1, { kind: "detect", target: editor }],
    ]);
    assert.equal(appended(effects)[0]?.end, T0 + MIN);
  });

  it("keeps a title only when titles are on and available here", () => {
    const titled = { ...editor, title: "  report.md  — Editor " };
    const withTitles = { ...on, storeTitles: true };
    const kept = run(scoped(withTitles), [
      [T0, { kind: "detect", target: titled }],
      [T0 + MIN, { kind: "detect", target: null }],
    ]);
    assert.equal(appended(kept.effects)[0]?.label, "report.md — Editor");

    const macos = run(
      scoped(withTitles),
      [
        [T0, { kind: "detect", target: titled }],
        [T0 + MIN, { kind: "detect", target: null }],
      ],
      { ...ctx, titlesAvailable: false },
    );
    assert.equal(appended(macos.effects)[0]?.label, undefined);

    const off = run(scoped(), [
      [T0, { kind: "detect", target: titled }],
      [T0 + MIN, { kind: "detect", target: null }],
    ]);
    assert.equal(appended(off.effects)[0]?.label, undefined);
  });
});

describe("heartbeat", () => {
  it("never opens a segment", () => {
    const { state, effects } = run(scoped(), [[T0, { kind: "heartbeat" }]]);
    assert.equal(state.open, null);
    assert.deepEqual(effects, []);
  });

  it("refreshes and persists a live segment", () => {
    const { state, effects } = run(scoped(), [
      [T0, { kind: "detect", target: editor }],
      [T0 + MIN, { kind: "heartbeat" }],
    ]);
    assert.equal(state.open?.lastSeen, T0 + MIN);
    assert.deepEqual(effects.at(-1), { kind: "persist-open", open: state.open });
  });

  it("closes a stale segment AT lastSeen, not at now", () => {
    const { state, effects } = run(scoped(), [
      [T0, { kind: "detect", target: editor }],
      [T0 + 2 * MIN, { kind: "detect", target: editor }],
      [T0 + 60 * MIN, { kind: "heartbeat" }],
    ]);
    assert.equal(state.open, null);
    assert.equal(appended(effects)[0]?.end, T0 + 2 * MIN);
  });
});

describe("presence", () => {
  it("backdates the close to when input stopped", () => {
    const { state, effects } = run(scoped(), [
      [T0, { kind: "detect", target: editor }],
      [T0 + 2 * MIN, { kind: "presence", state: "idle", idleSeconds: 30 }],
      [T0 + 3 * MIN, { kind: "presence", state: "idle", idleSeconds: 120 }],
      [T0 + 3 * MIN + 5_000, { kind: "detect", target: editor }],
    ]);
    assert.equal(appended(effects)[0]?.end, T0 + MIN);
    // While idle, detections open nothing.
    assert.equal(state.open, null);
    const back = run(state, [
      [T0 + 40 * MIN, { kind: "presence", state: "active", idleSeconds: 0 }],
      [T0 + 40 * MIN + 5_000, { kind: "detect", target: editor }],
    ]);
    assert.equal(back.state.open?.start, T0 + 40 * MIN + 5_000);
  });

  it("closes at now on lock and opens nothing after unlock until input", () => {
    const locked = run(scoped(), [
      [T0, { kind: "detect", target: editor }],
      [T0 + 2 * MIN, { kind: "presence", state: "locked", idleSeconds: 1 }],
    ]);
    assert.equal(appended(locked.effects)[0]?.end, T0 + 2 * MIN);

    // Unlocked: the monitor reports "idle" until someone types.
    const resumed = run(locked.state, [
      [T0 + 70 * MIN, { kind: "presence", state: "idle", idleSeconds: 20 }],
      [T0 + 70 * MIN + 5_000, { kind: "detect", target: editor }],
    ]);
    assert.equal(resumed.state.open, null);

    const typed = run(resumed.state, [
      [T0 + 71 * MIN, { kind: "presence", state: "active", idleSeconds: 0 }],
      [T0 + 71 * MIN + 5_000, { kind: "detect", target: editor }],
    ]);
    assert.equal(typed.state.open?.start, T0 + 71 * MIN + 5_000);
  });
});

describe("settings", () => {
  it("writes the open segment under the settings current at close", () => {
    const { effects, state } = run(scoped(), [
      [T0, { kind: "detect", target: chat }],
      [T0 + 5 * MIN, { kind: "settings", settings: { ...on, excludedApps: ["com.example.chat"] } }],
    ]);
    assert.deepEqual(appended(effects), []);
    assert.equal(state.open, null);
    assert.ok(effects.some((e) => e.kind === "purge-apps" && e.patterns[0] === "com.example.chat"));
  });

  it("purges only for newly added patterns", () => {
    const withExclusion = { ...on, excludedApps: ["com.example.chat"] };
    const { effects } = run(scoped(withExclusion), [[T0, { kind: "settings", settings: { ...withExclusion } }]]);
    assert.ok(!effects.some((e) => e.kind === "purge-apps"));
  });

  it("strips stored labels and closes the open one without its label when titles go off", () => {
    const withTitles = { ...on, storeTitles: true };
    const { effects } = run(scoped(withTitles), [
      [T0, { kind: "detect", target: { ...editor, title: "secret.txt" } }],
      [T0 + 5 * MIN, { kind: "settings", settings: on }],
    ]);
    assert.ok(effects.some((e) => e.kind === "strip-labels"));
    const [segment] = appended(effects);
    assert.equal(segment?.end, T0 + 5 * MIN);
    assert.equal(segment?.label, undefined);
  });

  it("closes at now when capture is turned off, and prunes on a retention change", () => {
    const { effects, state } = run(scoped(), [
      [T0, { kind: "detect", target: editor }],
      [T0 + 5 * MIN, { kind: "settings", settings: { ...DEFAULT_ACTIVITY_SETTINGS, retentionDays: 3 } }],
    ]);
    assert.equal(appended(effects)[0]?.end, T0 + 5 * MIN);
    assert.equal(state.open, null);
    assert.ok(effects.some((e) => e.kind === "prune"));
    assert.ok(effects.some((e) => e.kind === "save-state"));
  });
});

describe("scope", () => {
  it("sweeps other accounts and keeps the same person's workspaces", () => {
    const { effects, state } = run(scoped(), [
      [T0, { kind: "detect", target: editor }],
      [T0 + 5 * MIN, { kind: "scope", userId: "u1", workspaceId: "w2" }],
    ]);
    assert.equal(appended(effects)[0]?.scope, "u1:w1");
    assert.ok(effects.some((e) => e.kind === "sweep-scopes" && e.keepPrefix === "u1:"));
    assert.equal(state.scope, "u1:w2");
    assert.equal(state.open, null);
  });

  it("never writes another account's open segment", () => {
    const { effects, state } = run(scoped(), [
      [T0, { kind: "detect", target: editor }],
      [T0 + 5 * MIN, { kind: "scope", userId: "u2", workspaceId: "w9" }],
    ]);
    assert.deepEqual(appended(effects), []);
    assert.ok(effects.some((e) => e.kind === "sweep-scopes" && e.keepPrefix === "u2:"));
    assert.equal(state.scope, "u2:w9");
  });

  it("does nothing for the same scope", () => {
    const { effects } = run(scoped(), [[T0, { kind: "scope", userId: "u1", workspaceId: "w1" }]]);
    assert.deepEqual(effects, []);
  });
});

describe("forget and wipe", () => {
  it("forget drops everything and the scope but keeps the settings", () => {
    const settings = { ...on, excludedApps: ["com.example.*"], retentionDays: 30 };
    const { effects, state } = run(scoped(settings), [
      [T0, { kind: "detect", target: { key: "org.other", name: "Other" } }],
      [T0 + MIN, { kind: "forget" }],
    ]);
    assert.deepEqual(appended(effects), []);
    assert.ok(effects.some((e) => e.kind === "wipe"));
    assert.equal(state.scope, null);
    assert.equal(state.open, null);
    assert.deepEqual(state.settings, settings);
  });

  it("wipe keeps the scope", () => {
    const { state } = run(scoped(), [
      [T0, { kind: "detect", target: editor }],
      [T0 + MIN, { kind: "wipe" }],
    ]);
    assert.equal(state.scope, "u1:w1");
    assert.equal(state.open, null);
  });
});

describe("boot", () => {
  it("closes a stale open segment at lastSeen and keeps a fresh one", () => {
    const open = { scope: "u1:w1", key: "com.example.editor", name: "Editor", start: T0, lastSeen: T0 + MIN };
    const stale = step(initialCaptureState(on, "u1:w1", open), { kind: "boot" }, T0 + 10 * MIN, ctx);
    assert.equal(appended(stale.effects)[0]?.end, T0 + MIN);
    assert.equal(stale.state.open, null);

    const fresh = step(initialCaptureState(on, "u1:w1", open), { kind: "boot" }, T0 + 2 * MIN, ctx);
    assert.deepEqual(fresh.effects, []);
    assert.deepEqual(fresh.state.open, open);
  });

  it("closes an open segment capture no longer covers", () => {
    const open = { scope: "u1:w1", key: "com.example.editor", name: "Editor", start: T0, lastSeen: T0 + MIN };
    const off = step(initialCaptureState(DEFAULT_ACTIVITY_SETTINGS, "u1:w1", open), { kind: "boot" }, T0 + MIN, ctx);
    assert.equal(off.state.open, null);
    assert.equal(appended(off.effects)[0]?.end, T0 + MIN);
  });
});
