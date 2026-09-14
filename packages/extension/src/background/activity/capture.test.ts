import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { buildManifest } from "../../../manifest.config";
import {
  activityIdle,
  activityIdleChanged,
  applyActivitySettings,
  browserBlurred,
  deleteAllActivity,
  heartbeat,
  observeActiveTab,
  recoverActivity,
  setActivityScope,
  STALE_AFTER_MS,
} from "./capture";
import { runPrune } from "./prune";
import { ACTIVITY_SCOPE_KEY, CAPTURE_PERMISSIONS } from "./settings";
import {
  addDismissal,
  appendSegment,
  closeActivityDatabase,
  listDismissals,
  listRules,
  loadOpenSegment,
  putRule,
  readAllSegments,
} from "./store";
import { suggestionsFor } from "./suggestions";

const MIN = 60_000;
const T0 = Date.parse("2026-09-14T09:00:00.000Z");
const SCOPE = "user-1:ws-1";

const at = (minutes: number): void => {
  vi.setSystemTime(T0 + minutes * MIN);
};

/**
 * Move the clock the way a live worker experiences it: one heartbeat alarm per
 * minute on the way. Without them every open segment would go stale.
 */
let clockMinutes = 0;
const advanceTo = async (minutes: number): Promise<void> => {
  while (clockMinutes + 1 <= minutes) {
    clockMinutes += 1;
    at(clockMinutes);
    await heartbeat();
  }
  clockMinutes = minutes;
  at(minutes);
};

const enableCapture = async (patch: Parameters<typeof applyActivitySettings>[0] = {}): Promise<void> => {
  await chrome.permissions.request(CAPTURE_PERMISSIONS);
  await setActivityScope("user-1", "ws-1");
  const result = await applyActivitySettings({ enabled: true, ...patch });
  expect(result.ok).toBe(true);
};

const visit = async (minutes: number, url: string, extra: { incognito?: boolean; title?: string } = {}): Promise<void> => {
  await advanceTo(minutes);
  fakeChrome.showTab({ url, ...extra });
  await observeActiveTab();
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  clockMinutes = 0;
  at(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("with capture off", () => {
  test("the manifest asks for tabs only as an optional permission", () => {
    for (const mode of ["development", "production"] as const) {
      const manifest = buildManifest(mode);
      expect(manifest.permissions).not.toContain("tabs");
      expect(manifest.optional_permissions).toEqual(["tabs"]);
    }
  });

  test("nothing is recorded, even with a scope and the permission", async () => {
    await chrome.permissions.request(CAPTURE_PERMISSIONS);
    await setActivityScope("user-1", "ws-1");
    await visit(0, "https://docs.example.com/a");
    await visit(10, "https://code.example.com/b");
    await browserBlurred();
    expect(await readAllSegments()).toEqual([]);
    expect(await loadOpenSegment()).toBeNull();
  });

  test("enabling without the permission is refused and stays off", async () => {
    await setActivityScope("user-1", "ws-1");
    expect(await applyActivitySettings({ enabled: true })).toEqual({
      ok: false,
      reason: "permission-required",
    });
    await visit(0, "https://docs.example.com/a");
    expect(await loadOpenSegment()).toBeNull();
  });

  test("nothing is recorded without a signed-in scope", async () => {
    await chrome.permissions.request(CAPTURE_PERMISSIONS);
    await applyActivitySettings({ enabled: true });
    await visit(0, "https://docs.example.com/a");
    await visit(10, "https://code.example.com/b");
    expect(await readAllSegments()).toEqual([]);
  });
});

describe("after opting in", () => {
  test("thirty minutes of tab switching becomes suggestions, minus tracked time", async () => {
    await enableCapture();
    const hosts = ["docs.example.com", "code.example.com", "chat.example.com"];
    for (let minute = 0; minute < 30; minute += 2) {
      await visit(minute, `https://${hosts[minute % 3]}/page`);
    }
    await advanceTo(30);
    await browserBlurred();

    const range = { from: T0 - 60 * MIN, to: T0 + 120 * MIN };
    const untracked = await suggestionsFor(SCOPE, range, [], Date.now());
    expect(untracked.map((s) => [(s.start - T0) / MIN, (s.end - T0) / MIN])).toEqual([[0, 30]]);
    expect(untracked[0]?.topKeys.map((k) => k.key).sort()).toEqual([...hosts].sort());

    const tracked = [{ start: T0 + 10 * MIN, end: T0 + 20 * MIN }];
    const split = await suggestionsFor(SCOPE, range, tracked, Date.now());
    expect(split.map((s) => [(s.start - T0) / MIN, (s.end - T0) / MIN])).toEqual([
      [0, 10],
      [20, 30],
    ]);
  });

  test("the segment still open counts up to now", async () => {
    await enableCapture();
    await visit(0, "https://docs.example.com/a");
    await advanceTo(20);
    const [suggestion] = await suggestionsFor(SCOPE, { from: T0, to: T0 + 60 * MIN }, [], Date.now());
    expect(suggestion?.end).toBe(T0 + 20 * MIN);
  });

  test("incognito tabs, excluded hosts and browser pages never reach IndexedDB", async () => {
    await enableCapture({ excludedHosts: ["*.bank.test", "mail.example.com"] });
    await visit(0, "https://docs.example.com/a");
    await visit(5, "https://private.example.com/", { incognito: true });
    await visit(10, "https://online.bank.test/login");
    await visit(15, "https://bank.test/");
    await visit(20, "https://MAIL.example.com/inbox");
    await visit(25, "chrome://settings/");
    await visit(30, "chrome-extension://abc/popup.html");
    await visit(35, "https://code.example.com/");
    await advanceTo(40);
    await browserBlurred();

    const keys = (await readAllSegments()).map((segment) => segment.key);
    expect(keys).toEqual(["docs.example.com", "code.example.com"]);
    const everything = JSON.stringify(await readAllSegments());
    expect(everything).not.toMatch(/private|bank|mail|chrome/);
  });

  test("hostnames only, unless titles were opted into", async () => {
    await enableCapture();
    await visit(0, "https://docs.example.com/secret/path?q=1", { title: "Quarterly numbers" });
    await visit(5, "https://code.example.com/");
    expect(JSON.stringify(await readAllSegments())).not.toMatch(/secret|Quarterly/);

    await applyActivitySettings({ storeTitles: true });
    await visit(10, "https://docs.example.com/x", { title: "Design doc" });
    await visit(15, "https://code.example.com/");
    const titled = (await readAllSegments()).find((s) => s.label !== undefined);
    expect(titled?.label).toBe("Design doc");
  });

  test("turning capture off closes the open segment and stops recording", async () => {
    await enableCapture();
    await visit(0, "https://docs.example.com/");
    await advanceTo(10);
    await applyActivitySettings({ enabled: false });
    expect(await loadOpenSegment()).toBeNull();
    await visit(12, "https://code.example.com/");
    await visit(20, "https://docs.example.com/");
    const segments = await readAllSegments();
    expect(segments.map((s) => [s.key, (s.end - s.start) / MIN])).toEqual([["docs.example.com", 10]]);
  });

  test("going idle closes the segment back to when input stopped", async () => {
    await enableCapture();
    await visit(0, "https://docs.example.com/");
    await advanceTo(20);
    await activityIdleChanged("idle", 300);
    const [segment] = await readAllSegments();
    expect((segment?.end ?? 0) - T0).toBe(15 * MIN);
  });
});

describe("service worker restarts", () => {
  test("a heartbeat keeps an open segment alive across a restart", async () => {
    await enableCapture();
    await visit(0, "https://docs.example.com/");
    await advanceTo(10);
    // Eviction: module state is gone, only storage remains.
    await closeActivityDatabase();
    vi.resetModules();
    const revived = await import("./capture");
    at(11);
    await revived.recoverActivity();
    await revived.observeActiveTab();

    const open = await loadOpenSegment();
    expect(open?.start).toBe(T0);
    expect(await readAllSegments()).toEqual([]);
  });

  test("a segment left open by a dead worker is closed at its last heartbeat", async () => {
    await enableCapture();
    await visit(0, "https://docs.example.com/");
    await advanceTo(7);

    // The worker dies and the machine sleeps; nothing runs for an hour.
    await closeActivityDatabase();
    vi.resetModules();
    const revived = await import("./capture");
    vi.setSystemTime(T0 + 7 * MIN + STALE_AFTER_MS + 60 * MIN);
    await revived.recoverActivity();

    expect(await loadOpenSegment()).toBeNull();
    const [segment] = await readAllSegments();
    expect(segment?.key).toBe("docs.example.com");
    expect(segment?.start).toBe(T0);
    expect(segment?.end).toBe(T0 + 7 * MIN);
  });

  test("the next event after a long gap does not stretch the old segment over it", async () => {
    await enableCapture();
    await visit(0, "https://docs.example.com/");
    await advanceTo(2);
    // No heartbeats from here: the laptop lid is closed.
    clockMinutes = 90;
    await visit(90, "https://docs.example.com/");
    const segments = await readAllSegments();
    expect(segments.map((s) => [(s.start - T0) / MIN, (s.end - T0) / MIN])).toEqual([[0, 2]]);
    expect((await loadOpenSegment())?.start).toBe(T0 + 90 * MIN);
  });

  test("recovery keeps the alarms in step with the setting", async () => {
    await enableCapture();
    fakeChrome.alarms.clear();
    await recoverActivity();
    expect([...fakeChrome.alarms.keys()].sort()).toEqual([
      "tracktime.activity.heartbeat",
      "tracktime.activity.prune",
    ]);
    await applyActivitySettings({ enabled: false });
    expect(fakeChrome.alarms.size).toBe(0);
  });
});

describe("retention and wiping", () => {
  test("prune deletes activity and dismissals older than the retention window", async () => {
    await enableCapture({ retentionDays: 3 });
    const DAY = 24 * 60;
    const row = (key: string, startMin: number, endMin: number) => ({
      scope: SCOPE,
      source: "browser" as const,
      key,
      start: T0 + startMin * MIN,
      end: T0 + endMin * MIN,
      afk: false,
    });
    await appendSegment(row("old.example.com", 0, 4));
    await appendSegment(row("newer.example.com", 4, 30));
    await addDismissal({ scope: SCOPE, start: T0, end: T0 + MIN });
    await putRule(SCOPE, { id: "r1", pattern: "old.example.com", projectId: "p1" }, T0);

    at(3 * DAY + 5);
    expect(await runPrune(Date.now())).toBe(2);
    expect((await readAllSegments()).map((s) => s.key)).toEqual(["newer.example.com"]);
    expect(await listDismissals(SCOPE)).toEqual([]);
    // Rules are decisions, not activity.
    expect(await listRules(SCOPE)).toHaveLength(1);
  });

  test("retention is clamped to 1..90 days", async () => {
    await enableCapture({ retentionDays: 400 });
    const settings = await applyActivitySettings({});
    expect(settings.ok && settings.settings.retentionDays).toBe(90);
    const low = await applyActivitySettings({ retentionDays: 0 });
    expect(low.ok && low.settings.retentionDays).toBe(1);
  });

  test("a different account's scope wipes the previous one's rows", async () => {
    await enableCapture();
    await visit(0, "https://docs.example.com/");
    await visit(10, "https://code.example.com/");
    await putRule(SCOPE, { id: "r1", pattern: "docs.example.com" }, T0);
    await setActivityScope("user-2", "ws-9");
    await activityIdle();
    expect(await readAllSegments()).toEqual([]);
    expect(await listRules(SCOPE)).toEqual([]);
  });

  test("delete all activity with forgetScope stops recording until a scope is set", async () => {
    await enableCapture();
    await visit(0, "https://docs.example.com/");
    await visit(10, "https://code.example.com/");
    await addDismissal({ scope: SCOPE, start: T0, end: T0 + MIN });
    await putRule(SCOPE, { id: "r1", pattern: "docs.example.com" }, T0);

    await deleteAllActivity({ forgetScope: true });
    expect(await readAllSegments()).toEqual([]);
    expect(await loadOpenSegment()).toBeNull();
    expect(await listRules(SCOPE)).toEqual([]);
    expect(await listDismissals(SCOPE)).toEqual([]);
    expect(fakeChrome).toBeDefined();
    expect(await chrome.storage.local.get(ACTIVITY_SCOPE_KEY)).toEqual({});

    await visit(20, "https://docs.example.com/");
    await visit(30, "https://code.example.com/");
    expect(await readAllSegments()).toEqual([]);
  });
});
