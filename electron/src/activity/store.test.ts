import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { StoredSegment } from "./model.ts";
import { DEFAULT_ACTIVITY_SETTINGS } from "./settings.ts";
import { ACTIVITY_DIR, createActivityStore, dayFileOf } from "./store.ts";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 22, 23, 30, 0);

const segment = (patch: Partial<StoredSegment> = {}): StoredSegment => ({
  scope: "u1:w1",
  source: "desktop",
  start: T0,
  end: T0 + 10 * 60_000,
  key: "com.example.editor",
  name: "Editor",
  afk: false,
  ...patch,
});

let userData = "";
const activityDir = (): string => path.join(userData, ACTIVITY_DIR);
const segmentsDir = (): string => path.join(activityDir(), "segments");

beforeEach(() => {
  userData = mkdtempSync(path.join(tmpdir(), "tyt-activity-"));
});
afterEach(() => {
  rmSync(userData, { recursive: true, force: true });
});

describe("activity store", () => {
  it("appends and reads across UTC days, by scope and range", () => {
    const store = createActivityStore(userData);
    store.append(segment());
    store.append(segment({ start: T0 + DAY, end: T0 + DAY + 60_000 }));
    store.append(segment({ scope: "u2:w1" }));
    assert.deepEqual(readdirSync(segmentsDir()).sort(), [dayFileOf(T0), dayFileOf(T0 + DAY)].sort());

    const again = createActivityStore(userData);
    assert.equal(again.allSegments("u1:w1").length, 2);
    assert.equal(again.segments("u1:w1", T0 + 5 * 60_000, T0 + 6 * 60_000).length, 1);
    assert.equal(again.segments("u1:w1", T0 + DAY - 1, T0 + DAY).length, 0);
  });

  it("skips a torn line", () => {
    const store = createActivityStore(userData);
    store.append(segment());
    appendFileSync(path.join(segmentsDir(), dayFileOf(T0)), '{"scope":"u1:w1","start":');
    store.append(segment({ start: T0 + 60_000 }));
    assert.equal(createActivityStore(userData).allSegments("u1:w1").length, 1);
  });

  it("rewrites by predicate, atomically, and deletes emptied files", () => {
    const store = createActivityStore(userData);
    store.append(segment({ label: "secret" }));
    store.append(segment({ key: "com.example.chat", start: T0 + DAY, end: T0 + DAY + 60_000 }));
    const changed = store.rewriteSegments((s) => (s.key === "com.example.chat" ? null : s));
    assert.equal(changed, 1);
    assert.deepEqual(readdirSync(segmentsDir()), [dayFileOf(T0)]);
    store.rewriteSegments((s) => {
      const { label: _label, ...rest } = s;
      return s.label === undefined ? s : rest;
    });
    assert.equal(store.allSegments("u1:w1")[0]?.label, undefined);
    assert.ok(!readdirSync(segmentsDir()).some((file) => file.endsWith(".tmp")));
  });

  it("prunes by retention, trims dismissals and keeps rules", () => {
    const now = T0 + 20 * DAY;
    const store = createActivityStore(userData);
    store.append(segment());
    store.append(segment({ start: now - DAY, end: now - DAY + 60_000 }));
    store.addDismissal("u1:w1", { start: T0, end: T0 + 1000 });
    store.putRule("u1:w1", { id: "r1", pattern: "com.example.*" }, T0);
    assert.equal(store.prune(now, 14), 1);
    assert.equal(store.allSegments("u1:w1").length, 1);
    assert.deepEqual(store.dismissals("u1:w1"), []);
    assert.equal(store.rules("u1:w1").length, 1);
  });

  it("sweeps other accounts and keeps the same person's workspaces", () => {
    const store = createActivityStore(userData);
    store.append(segment());
    store.append(segment({ scope: "u1:w2" }));
    store.append(segment({ scope: "u2:w1" }));
    store.putRule("u2:w1", { id: "r", pattern: "x" }, 0);
    store.addDismissal("u2:w1", { start: 1, end: 2 });
    store.sweepScopes("u1:");
    assert.deepEqual(
      store.files().segments.map((s) => (s as StoredSegment).scope).sort(),
      ["u1:w1", "u1:w2"],
    );
    assert.deepEqual(store.rules("u2:w1"), []);
    assert.deepEqual(store.dismissals("u2:w1"), []);
  });

  it("replaces a rule with the same pattern", () => {
    const store = createActivityStore(userData);
    store.putRule("u1:w1", { id: "a", pattern: "com.example.*", description: "Old" }, 1);
    store.putRule("u1:w1", { id: "b", pattern: "com.example.*", description: "New" }, 2);
    assert.deepEqual(store.rules("u1:w1"), [{ id: "b", pattern: "com.example.*", description: "New" }]);
  });

  it("wipes segments, rules, dismissals and the open segment, keeping settings and scope", () => {
    const store = createActivityStore(userData);
    const settings = { ...DEFAULT_ACTIVITY_SETTINGS, enabled: true, retentionDays: 30 };
    store.saveState(settings, "u1:w1");
    store.append(segment());
    store.writeOpen({ scope: "u1:w1", key: "k", name: "K", start: T0, lastSeen: T0 });
    store.putRule("u1:w1", { id: "r", pattern: "k" }, 0);
    store.wipe();
    const again = createActivityStore(userData);
    assert.deepEqual(again.allSegments("u1:w1"), []);
    assert.equal(again.readOpen(), null);
    assert.deepEqual(again.rules("u1:w1"), []);
    assert.deepEqual(again.settings(), settings);
    assert.equal(again.scope(), "u1:w1");
  });

  it("locks on a newer format and writes nothing at all", () => {
    mkdirSync(segmentsDir(), { recursive: true });
    const newer = JSON.stringify({ v: 2, settings: { enabled: true, retentionDays: 5 }, scope: "u1:w1" });
    writeFileSync(path.join(activityDir(), "state.json"), newer);
    writeFileSync(path.join(segmentsDir(), dayFileOf(T0)), `${JSON.stringify(segment())}\n`);

    const store = createActivityStore(userData);
    assert.equal(store.status, "newer-format");
    assert.equal(store.settings().enabled, false);
    store.saveState({ ...DEFAULT_ACTIVITY_SETTINGS, enabled: true }, "u9:w9");
    store.append(segment({ start: T0 + DAY, end: T0 + DAY + 1 }));
    store.writeOpen({ scope: "u1:w1", key: "k", name: "K", start: T0, lastSeen: T0 });
    store.putRule("u1:w1", { id: "r", pattern: "k" }, 0);
    store.sweepScopes("u9:");
    store.wipe();
    store.prune(T0 + 100 * DAY, 1);

    assert.equal(readFileSync(path.join(activityDir(), "state.json"), "utf8"), newer);
    assert.deepEqual(readdirSync(segmentsDir()), [dayFileOf(T0)]);
    assert.deepEqual(readdirSync(activityDir()).sort(), ["segments", "state.json"]);
  });

  it("copies an unreadable state.json aside and starts from the defaults", () => {
    mkdirSync(activityDir(), { recursive: true });
    writeFileSync(path.join(activityDir(), "state.json"), "{not json");
    const store = createActivityStore(userData, () => 1234);
    assert.equal(store.status, "ok");
    assert.deepEqual(store.settings(), DEFAULT_ACTIVITY_SETTINGS);
    assert.equal(readFileSync(path.join(activityDir(), "state.json.corrupt.1234"), "utf8"), "{not json");
  });

  it("keeps the folder 0700 and its files 0600", { skip: process.platform === "win32" }, () => {
    const store = createActivityStore(userData);
    store.saveState(DEFAULT_ACTIVITY_SETTINGS, "u1:w1");
    store.append(segment());
    store.writeOpen({ scope: "u1:w1", key: "k", name: "K", start: T0, lastSeen: T0 });
    const mode = (target: string): number => statSync(target).mode & 0o777;
    assert.equal(mode(activityDir()), 0o700);
    assert.equal(mode(segmentsDir()), 0o700);
    assert.equal(mode(path.join(activityDir(), "state.json")), 0o600);
    assert.equal(mode(path.join(activityDir(), "open.json")), 0o600);
    assert.equal(mode(path.join(segmentsDir(), dayFileOf(T0))), 0o600);
  });
});
