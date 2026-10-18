import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { filingKeyOf } from "../../../packages/core/src/activity/index.ts";
import type { DesktopAutopilotPlan, DesktopAutopilotRunning } from "../../../packages/shared/src/desktop-bridge.ts";
import { HOLD_BREAK_MS, SETTLE_MS } from "./autopilot.ts";
import { parseAutopilotApplied, parseAutopilotHistory, parseAutopilotHold, parseAutopilotPlanInput } from "./ipc-parse.ts";
import { createActivityService, type ActivityService } from "./service.ts";
import { createFakeFrontmostSource, type FakeFrontmostSource } from "./source-fake.ts";
import { createActivityTestHook, type ActivityTestHook } from "./test-hook.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 19, 9, 0, 0);

const FIGMA = { key: "com.figma.desktop", name: "Figma" };
const CODE = { key: "com.microsoft.vscode", name: "Code" };
const CHROME = { key: "com.google.chrome", name: "Chrome" };

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
    titlesAvailable: false,
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

/** `target` in front from `from` to `to`, a detection every 30 s. */
async function stay(target: { key: string; name: string } | null, from: number, to: number): Promise<void> {
  hook.setFrontmost(target);
  for (let at = from; at <= to; at += 30_000) {
    hook.setNow(at);
    await hook.tick();
  }
}

const WEBSITE = { description: "Website redesign", projectId: "p-web", taskId: null };
const API = { description: "API work", projectId: "p-api", taskId: null };

const running = (start: number, fields: { description: string; projectId: string | null; taskId: string | null }): DesktopAutopilotRunning => ({
  start,
  ...fields,
});

const plan = (input: { running?: DesktopAutopilotRunning | null; tracked?: { start: number; end: number }[] } = {}) =>
  service.autopilotPlan({ running: input.running ?? null, tracked: input.tracked ?? [] });

async function setUp(): Promise<void> {
  await service.setScope({ userId: "u1", workspaceId: "w1" });
  await service.updateSettings({ enabled: true, autopilot: true });
  await service.addRule({ pattern: FIGMA.key, description: WEBSITE.description, projectId: WEBSITE.projectId });
  await service.addRule({ pattern: CODE.key, description: API.description, projectId: API.projectId });
}

const assertKind = <K extends DesktopAutopilotPlan["kind"]>(
  value: DesktopAutopilotPlan,
  kind: K,
): Extract<DesktopAutopilotPlan, { kind: K }> => {
  assert.equal(value.kind, kind);
  return value as Extract<DesktopAutopilotPlan, { kind: K }>;
};

beforeEach(() => {
  userData = mkdtempSync(path.join(tmpdir(), "tyt-autopilot-"));
  clock = T0;
  boot();
});
afterEach(() => {
  service.dispose();
  rmSync(userData, { recursive: true, force: true });
});

describe("autopilot", () => {
  it("is off by default, and does nothing while off", async () => {
    await service.setScope({ userId: "u1", workspaceId: "w1" });
    await service.updateSettings({ enabled: true });
    await service.addRule({ pattern: FIGMA.key, description: "Website redesign" });
    await stay(FIGMA, T0, T0 + 10 * MIN);
    const snapshot = await service.snapshot();
    assert.equal(snapshot.settings.autopilot, false);
    assert.equal(snapshot.autopilot.active, false);
    assert.deepEqual(await plan(), { kind: "none" });
  });

  it("needs capture on as well", async () => {
    await service.setScope({ userId: "u1", workspaceId: "w1" });
    await service.updateSettings({ autopilot: true });
    assert.equal((await service.snapshot()).autopilot.active, false);
  });

  it("watches, then starts a filed app's timer dated to its first minute", async () => {
    await setUp();
    await stay(FIGMA, T0, T0 + 3 * MIN);
    assert.deepEqual(await plan(), { kind: "none" });
    const watched = (await service.snapshot()).autopilot.watch;
    assert.equal(watched?.app.name, "Figma");
    assert.equal(watched?.filing?.fields.description, "Website redesign");

    await stay(FIGMA, T0 + 3 * MIN + 30_000, T0 + 6 * MIN);
    const start = assertKind(await plan(), "start");
    assert.equal(start.at, T0);
    assert.equal(start.app.name, "Figma");
    assert.equal(start.filing.via, "rule");
    assert.equal(start.filing.key, filingKeyOf(WEBSITE));
  });

  it("owns the timer once the write is reported, and switches it later", async () => {
    await setUp();
    await stay(FIGMA, T0, T0 + 6 * MIN);
    const start = assertKind(await plan(), "start");
    await service.autopilotApplied({ token: start.token, ok: true, written: WEBSITE });
    const owned = (await service.snapshot()).autopilot.owned;
    assert.equal(owned?.start, T0);
    assert.equal((await service.snapshot()).autopilot.log[0]?.kind, "start");

    await stay(FIGMA, T0 + 6 * MIN + 30_000, T0 + 20 * MIN);
    await stay(CODE, T0 + 20 * MIN + 30_000, T0 + 31 * MIN);
    const switched = assertKind(await plan({ running: running(T0, WEBSITE) }), "switch");
    assert.equal(switched.filing.key, filingKeyOf(API));
    // The first minute of Code: the detection at 20:30.
    assert.equal(switched.at, T0 + 20 * MIN + 30_000);
  });

  it("does not read a lagging renderer as a stop by hand", async () => {
    await setUp();
    await stay(FIGMA, T0, T0 + 6 * MIN);
    const start = assertKind(await plan(), "start");
    await service.autopilotApplied({ token: start.token, ok: true, written: WEBSITE });
    // The running entry has not shown up yet: nothing is decided or held.
    assert.deepEqual(await plan({ running: null }), { kind: "none" });
    assert.notEqual((await service.snapshot()).autopilot.owned, null);
    const later = await plan({ running: running(T0, WEBSITE) });
    assert.equal(later.kind, "none");
    assert.notEqual((await service.snapshot()).autopilot.owned, null);
  });

  it("a timer edited by hand is the person's", async () => {
    await setUp();
    await stay(FIGMA, T0, T0 + 6 * MIN);
    const start = assertKind(await plan(), "start");
    await service.autopilotApplied({ token: start.token, ok: true, written: WEBSITE });
    await plan({ running: running(T0, WEBSITE) });
    await plan({ running: running(T0, { ...WEBSITE, description: "Client call" }) });
    assert.equal((await service.snapshot()).autopilot.owned, null);
    await stay(CODE, T0 + 6 * MIN + 30_000, T0 + 20 * MIN);
    assert.deepEqual(
      await plan({ running: running(T0, { ...WEBSITE, description: "Client call" }) }),
      { kind: "none" },
    );
  });

  it("a timer stopped by hand is not restarted until a break", async () => {
    await setUp();
    await stay(FIGMA, T0, T0 + 6 * MIN);
    const start = assertKind(await plan(), "start");
    await service.autopilotApplied({ token: start.token, ok: true, written: WEBSITE });
    await plan({ running: running(T0, WEBSITE) });
    // Stopped by hand at 6:00; Figma stays in front.
    const tracked = [{ start: T0, end: T0 + 6 * MIN }];
    await stay(FIGMA, T0 + 6 * MIN + 30_000, T0 + 16 * MIN);
    clock = T0 + 16 * MIN + SETTLE_MS;
    assert.deepEqual(await plan({ running: null, tracked }), { kind: "none" });
    assert.equal((await service.snapshot()).autopilot.watch?.held, true);

    // A break, then Figma again: it starts.
    const back = T0 + 16 * MIN + HOLD_BREAK_MS + MIN;
    await stay(FIGMA, back, back + 6 * MIN);
    const again = assertKind(await plan({ running: null, tracked }), "start");
    assert.equal(again.at, back);
  });

  it("undo holds the filing and treats the span as accounted for", async () => {
    await setUp();
    await stay(FIGMA, T0, T0 + 6 * MIN);
    const start = assertKind(await plan(), "start");
    await service.autopilotApplied({ token: start.token, ok: true, written: WEBSITE });
    const logId = (await service.snapshot()).autopilot.log[0]?.id;
    assert.ok(logId);
    await service.autopilotHold({ filingKey: start.filing.key, dismiss: { start: T0, end: clock }, logId });
    const snapshot = await service.snapshot();
    assert.equal(snapshot.autopilot.owned, null);
    assert.equal(snapshot.autopilot.log[0]?.undone, true);
    await stay(FIGMA, T0 + 6 * MIN + 30_000, T0 + 14 * MIN);
    clock += SETTLE_MS;
    assert.deepEqual(await plan(), { kind: "none" });
    assert.deepEqual(
      await service.suggestions({ from: T0, to: T0 + 6 * MIN, tracked: [] }),
      [],
    );
  });

  it("an unknown app is only watched, and 'not work' holds it", async () => {
    await setUp();
    await stay(CHROME, T0, T0 + 10 * MIN);
    assert.deepEqual(await plan(), { kind: "none" });
    const watched = (await service.snapshot()).autopilot.watch;
    assert.equal(watched?.app.key, CHROME.key);
    assert.equal(watched?.filing, null);
    await service.autopilotHold({ appKey: CHROME.key });
    await plan();
    assert.equal((await service.snapshot()).autopilot.watch?.held, true);
  });

  it("learns from the person's entries", async () => {
    await service.setScope({ userId: "u1", workspaceId: "w1" });
    await service.updateSettings({ enabled: true, autopilot: true });
    await stay(CHROME, T0, T0 + 30 * MIN);
    await service.autopilotLearn([
      { start: T0, end: T0 + 30 * MIN, description: "Research", projectId: "p-r", taskId: null, tagIds: [], billable: false },
    ]);
    assert.equal((await service.snapshot()).autopilot.learnedApps, 1);
    const later = T0 + 60 * MIN;
    await stay(CHROME, later, later + 6 * MIN);
    const start = assertKind(await plan({ tracked: [{ start: T0, end: T0 + 30 * MIN }] }), "start");
    assert.equal(start.filing.via, "learned");
    assert.equal(start.at, later);
  });

  it("keeps its timer across a restart, and forgets it on sign-out", async () => {
    await setUp();
    await stay(FIGMA, T0, T0 + 6 * MIN);
    const start = assertKind(await plan(), "start");
    await service.autopilotApplied({ token: start.token, ok: true, written: WEBSITE });
    service.dispose();
    boot();
    assert.equal((await service.snapshot()).autopilot.owned?.start, T0);
    await service.forget();
    assert.equal((await service.snapshot()).autopilot.owned, null);
  });

  it("an unknown token changes nothing", async () => {
    await setUp();
    await service.autopilotApplied({ token: "nope", ok: true });
    assert.deepEqual((await service.snapshot()).autopilot.log, []);
  });
});

describe("autopilot ipc parsing", () => {
  it("narrows plan input", () => {
    assert.deepEqual(parseAutopilotPlanInput({ running: null, tracked: [] }), { running: null, tracked: [] });
    assert.equal(parseAutopilotPlanInput({ running: { start: 1 }, tracked: [] }), null);
    assert.equal(parseAutopilotPlanInput({ running: null, tracked: [{ start: 2, end: 1 }] }), null);
    assert.equal(parseAutopilotPlanInput(null), null);
  });

  it("narrows history, applied and hold", () => {
    assert.deepEqual(
      parseAutopilotHistory([{ start: 1, end: 2, description: "x", projectId: null, taskId: null, tagIds: ["t"], billable: true }]),
      [{ start: 1, end: 2, description: "x", projectId: null, taskId: null, tagIds: ["t"], billable: true }],
    );
    assert.equal(parseAutopilotHistory([{ start: 1, end: 2, description: "x" }]), null);
    assert.deepEqual(parseAutopilotApplied({ token: "a", ok: true }), { token: "a", ok: true });
    assert.equal(parseAutopilotApplied({ token: "", ok: true }), null);
    assert.equal(parseAutopilotApplied({ token: "a", ok: true, written: { description: 1 } }), null);
    assert.deepEqual(parseAutopilotHold({ appKey: " Com.Example.App " }), { appKey: "com.example.app" });
    assert.equal(parseAutopilotHold({ dismiss: { start: 2, end: 1 } }), null);
  });
});
