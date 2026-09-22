import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { StoredSegment } from "./model.ts";
import { createActivityService, type ActivityService } from "./service.ts";
import { createFakeFrontmostSource, type FakeFrontmostSource } from "./source-fake.ts";
import { createActivityTestHook, type ActivityTestHook } from "./test-hook.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 22, 9, 0, 0);

let userData = "";
let clock = T0;
let service: ActivityService;
let fake: FakeFrontmostSource;
let hook: ActivityTestHook;

function boot(): void {
  fake = createFakeFrontmostSource();
  service = createActivityService({
    userData,
    support: { kind: "supported", mechanism: "macos-lsappinfo" },
    titlesAvailable: true,
    source: fake,
    selfPid: 1,
    now: () => clock,
  });
  hook = createActivityTestHook({
    service,
    fake,
    spawns: [],
    setNow: (ms) => {
      clock = ms ?? Date.now();
    },
  });
}

/** Detections every 30 s from `from` to `to`, with a heartbeat each minute. */
async function stay(target: { key: string; name: string; title?: string } | null, from: number, to: number): Promise<void> {
  hook.setFrontmost(target);
  for (let at = from; at <= to; at += 30_000) {
    hook.setNow(at);
    await hook.tick();
    if ((at - from) % MIN === 0) await hook.heartbeat();
  }
}

const segments = (): StoredSegment[] => hook.files().segments as StoredSegment[];

beforeEach(() => {
  userData = mkdtempSync(path.join(tmpdir(), "tyt-activity-service-"));
  clock = T0;
  boot();
});
afterEach(() => {
  service.dispose();
  rmSync(userData, { recursive: true, force: true });
});

describe("activity service", () => {
  it("is off by default and never starts capture on its own", async () => {
    const snapshot = await service.snapshot();
    assert.equal(snapshot.settings.enabled, false);
    assert.equal(snapshot.recording, false);
    // Even with an account, nothing records until the person turns it on.
    await service.setScope({ userId: "u1", workspaceId: "w1" });
    await stay({ key: "com.example.editor", name: "Editor" }, T0, T0 + 5 * MIN);
    assert.equal(hook.capturing(), false);
    assert.deepEqual(segments(), []);
    assert.equal(hook.files().open, null);
  });

  it("needs a scope as well as the switch", async () => {
    await service.updateSettings({ enabled: true });
    assert.equal(hook.capturing(), false);
    await service.setScope({ userId: "u1", workspaceId: "w1" });
    assert.equal(hook.capturing(), true);
  });

  it("records, suggests with names, and honours dismissals and accepts", async () => {
    await service.setScope({ userId: "u1", workspaceId: "w1" });
    await service.updateSettings({ enabled: true });
    await stay({ key: "com.example.editor", name: "Editor" }, T0, T0 + 25 * MIN);
    await stay({ key: "com.example.chat", name: "Chat" }, T0 + 25 * MIN + 30_000, T0 + 27 * MIN);
    hook.setFrontmost(null);
    hook.setNow(T0 + 27 * MIN + 30_000);
    await hook.tick();

    const suggestions = await service.suggestions({ from: T0 - 60 * MIN, to: T0 + 60 * MIN, tracked: [] });
    assert.equal(suggestions?.length, 1);
    assert.equal(suggestions?.[0]?.topApps[0]?.name, "Editor");
    assert.equal(suggestions?.[0]?.start, T0);

    const snapshot = await service.snapshot();
    assert.deepEqual(
      snapshot.recentApps.map((app) => app.name),
      ["Chat", "Editor"],
    );
    assert.ok(snapshot.storedSegments >= 2);

    const check = await service.checkAccept({ start: T0, end: T0 + 27 * MIN + 30_000, edited: false, tracked: [] });
    assert.equal(check.ok, true);
    await service.markAccepted({ start: T0, end: T0 + 27 * MIN + 30_000 });
    assert.deepEqual(await service.suggestions({ from: T0 - 60 * MIN, to: T0 + 60 * MIN, tracked: [] }), []);
    assert.deepEqual(await service.checkAccept({ start: T0, end: T0 + 10 * MIN, edited: false, tracked: [] }), {
      ok: false,
      reason: "already-tracked",
    });
  });

  it("purges an app that is excluded, and strips titles when they go off", async () => {
    await service.setScope({ userId: "u1", workspaceId: "w1" });
    await service.updateSettings({ enabled: true, storeTitles: true });
    await stay({ key: "com.example.chat", name: "Chat", title: "DM with Sam" }, T0, T0 + 3 * MIN);
    await stay({ key: "com.example.editor", name: "Editor", title: "notes.md" }, T0 + 3 * MIN + 30_000, T0 + 6 * MIN);
    assert.equal(segments().find((s) => s.key === "com.example.chat")?.label, "DM with Sam");

    await service.updateSettings({ excludedApps: ["com.example.chat"] });
    assert.ok(!segments().some((s) => s.key === "com.example.chat"));

    await service.updateSettings({ storeTitles: false });
    assert.ok(segments().every((s) => s.label === undefined));
    assert.ok(segments().some((s) => s.key === "com.example.editor"));
  });

  it("keeps the same person's other workspace, drops another account, and forgets on sign-out", async () => {
    await service.setScope({ userId: "u1", workspaceId: "w1" });
    await service.updateSettings({ enabled: true });
    await stay({ key: "a", name: "A" }, T0, T0 + 2 * MIN);
    await service.setScope({ userId: "u1", workspaceId: "w2" });
    await stay({ key: "b", name: "B" }, T0 + 3 * MIN, T0 + 5 * MIN);
    await service.setScope({ userId: "u1", workspaceId: "w1" });
    assert.deepEqual([...new Set(segments().map((s) => s.scope))].sort(), ["u1:w1", "u1:w2"]);

    await service.setScope({ userId: "u2", workspaceId: "w1" });
    assert.deepEqual(segments(), []);

    await stay({ key: "c", name: "C" }, T0 + 6 * MIN, T0 + 8 * MIN);
    await service.addRule({ pattern: "c" });
    await service.dismiss({ start: T0, end: T0 + MIN });
    await service.forget();
    const files = hook.files();
    assert.deepEqual(files.segments, []);
    assert.equal(files.open, null);
    const state = files.state as { scope: unknown; rules: unknown[]; dismissals: unknown[]; settings: { enabled: boolean } };
    assert.equal(state.scope, null);
    assert.deepEqual(state.rules, []);
    assert.deepEqual(state.dismissals, []);
    // Device preferences stay; capture simply has nobody to record for.
    assert.equal(state.settings.enabled, true);
    assert.equal(hook.capturing(), false);
  });

  it("pauses on idle and lock, and stops on an unsupported channel", async () => {
    await service.setScope({ userId: "u1", workspaceId: "w1" });
    await service.updateSettings({ enabled: true });
    await stay({ key: "a", name: "A" }, T0, T0 + 2 * MIN);
    hook.setNow(T0 + 2 * MIN + 10_000);
    await hook.idle("idle", 90);
    assert.equal(hook.capturing(), false);
    assert.equal((await service.snapshot()).recording, false);
    assert.equal(segments()[0]?.end, T0 + 2 * MIN + 10_000 - 90_000);

    await hook.idle("active");
    assert.equal(hook.capturing(), true);

    await hook.setSupport({ supported: false, reason: "store", hint: null });
    assert.equal(hook.capturing(), false);
    assert.deepEqual((await service.snapshot()).support, { supported: false, reason: "store", hint: null });
  });

  it("closes a segment left open by a previous run at its lastSeen", async () => {
    await service.setScope({ userId: "u1", workspaceId: "w1" });
    await service.updateSettings({ enabled: true });
    await stay({ key: "a", name: "A" }, T0, T0 + 2 * MIN);
    service.dispose();
    assert.ok(hook.files().open !== null);

    clock = T0 + 60 * MIN;
    boot();
    await service.settled();
    assert.equal(hook.files().open, null);
    assert.equal(segments()[0]?.end, T0 + 2 * MIN);
  });
});
