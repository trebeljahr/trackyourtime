import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DesktopTimerState } from "../../packages/shared/src/desktop-bridge.ts";
import {
  AUTOPILOT_MARK,
  FALLBACK_TRAY_LABELS,
  autopilotPausedAt,
  parseNotice,
  parseTimerState,
  trayClock,
  trayIconFile,
  trayMenuModel,
  trayTitle,
  trayTooltip,
} from "./tray-model.ts";

const start = "2026-09-17T10:00:00.000Z";
const at = (sec: number): number => Date.parse(start) + sec * 1000;

const running: DesktopTimerState = {
  signedIn: true,
  running: { description: "Write the plan", startedAt: start, projectName: "Desktop", projectColor: "#4f46e5" },
  recents: [
    { key: "k1", label: "Review", hint: "Client — Project" },
    { key: "k2", label: "", hint: null },
  ],
  unsent: 2,
  labels: { ...FALLBACK_TRAY_LABELS, unsent: "2 unsent changes", stop: "Stoppen" },
};

describe("trayClock", () => {
  it("is m:ss under an hour and h:mm from an hour", () => {
    assert.equal(trayClock(0), "0:00");
    assert.equal(trayClock(65.9), "1:05");
    assert.equal(trayClock(3599), "59:59");
    assert.equal(trayClock(3600), "1:00");
    assert.equal(trayClock(3 * 3600 + 7 * 60 + 59), "3:07");
    assert.equal(trayClock(-5), "0:00");
  });
});

describe("trayMenuModel", () => {
  it("signed out, or before any state: Open and Quit only", () => {
    for (const state of [null, { ...running, signedIn: false }]) {
      assert.deepEqual(
        trayMenuModel(state).flatMap((item) => (item.type === "item" ? [item.id] : [])),
        ["open", "quit"],
      );
    }
  });

  it("running: matching summary and controls, without idle start choices", () => {
    const model = trayMenuModel(running, { nowMs: at(125) });
    assert.deepEqual(
      model.map((item) => (item.type === "item" ? item.id : item.type === "heading" ? `# ${item.label}` : "---")),
      ["edit", "# Running for 2m", "---", "stop", "edit", "---", "# 2 unsent changes", "---", "open", "settings", "---", "quit"],
    );
    assert.equal(model[0].type === "item" && model[0].label, "Write the plan");
    assert.ok(model.some((item) => item.type === "item" && item.label === "Stoppen"));
    const idle = trayMenuModel({ ...running, running: null });
    assert.ok(idle.some((item) => item.type === "item" && item.label === "Review — Client — Project"));
    assert.ok(idle.some((item) => item.type === "item" && item.label === "(no description)"));
  });

  it("offers Restart to update above Quit only once an update is downloaded", () => {
    const ids = (state: DesktopTimerState | null, updateReady: boolean): string[] =>
      trayMenuModel(state, { updateReady }).flatMap((item) => (item.type === "item" ? [item.id] : []));
    assert.equal(ids(running, false).includes("restart-to-update"), false);
    assert.deepEqual(ids(running, true).slice(-2), ["restart-to-update", "quit"]);
    assert.deepEqual(ids(null, true), ["open", "restart-to-update", "quit"]);
    const item = trayMenuModel({ ...running, labels: { ...running.labels, restartToUpdate: "Neu starten" } }, { updateReady: true }).find(
      (candidate) => candidate.type === "item" && candidate.id === "restart-to-update",
    );
    assert.equal(item?.type === "item" ? item.label : null, "Neu starten");
  });

  it("offers to pause Autopilot while it is on, and to resume it while paused", () => {
    const outline = (state: DesktopTimerState, nowMs: number): string[] =>
      trayMenuModel(state, { nowMs }).map((item) =>
        item.type === "item" ? item.id : item.type === "heading" ? `# ${item.label}` : "---",
      );
    const off = outline({ ...running, unsent: 0 }, at(0));
    assert.equal(off.some((id) => id.startsWith("autopilot-")), false, "no item while Autopilot is off");

    const on = { ...running, unsent: 0, autopilot: { pausedUntil: null } };
    assert.ok(outline(on, at(0)).includes("autopilot-pause"));

    const paused: DesktopTimerState = {
      ...on,
      autopilot: { pausedUntil: at(3600) },
      labels: { ...on.labels, autopilotPaused: "Autopilot paused until 11:00", autopilotResume: "Fortsetzen" },
    };
    assert.ok(outline(paused, at(60)).includes("# Autopilot paused until 11:00"));
    assert.ok(outline(paused, at(60)).includes("autopilot-resume"));
    const resume = trayMenuModel(paused, { nowMs: at(60) }).find(
      (item) => item.type === "item" && item.id === "autopilot-resume",
    );
    assert.equal(resume?.type === "item" ? resume.label : null, "Fortsetzen", "labels come from the payload");
    // A pause that has run out is no pause, whatever the payload last said.
    assert.equal(outline(paused, at(3600)).includes("autopilot-pause"), true);
    assert.equal(outline(paused, at(3600)).includes("# Autopilot paused until 11:00"), false);
  });

  it("marks a timer Autopilot opened in the menu heading", () => {
    const owned = { ...running, running: { ...running.running!, autopilot: true } };
    const heading = trayMenuModel(owned)[0];
    assert.equal(heading?.type === "item" ? heading.label : null, `${AUTOPILOT_MARK} Write the plan`);
    const plain = trayMenuModel(running)[0];
    assert.equal(plain?.type === "item" ? plain.label : null, "Write the plan");
  });

  it("idle with nothing queued: no Stop and no unsent line", () => {
    const ids = trayMenuModel({ ...running, running: null, unsent: 0 }).map((item) =>
      item.type === "item" ? item.id : item.type,
    );
    assert.equal(ids.includes("stop"), false);
    assert.equal(ids.filter((id) => id === "heading").length, 2);
  });
});

describe("title, tooltip and icon", () => {
  it("ticks the macOS title from startedAt and leaves it empty when idle", () => {
    assert.equal(trayTitle(running, at(125), "darwin"), "2m");
    assert.equal(trayTitle(running, at(125), "win32"), "");
    assert.equal(trayTitle({ ...running, running: null }, at(125), "darwin"), "");
  });

  it("marks a timer Autopilot opened, in the macOS title and every tooltip", () => {
    const owned = { ...running, running: { ...running.running!, autopilot: true } };
    assert.equal(trayTitle(owned, at(125), "darwin"), "✦ 2m");
    assert.equal(trayTitle(owned, at(125), "linux"), "");
    assert.equal(trayTooltip(owned, at(3700)), "✦ Write the plan — 1h 01m");
    assert.equal(trayTooltip({ ...owned, running: null }, at(1)), "Track Your Time");
  });

  it("puts the clock and the entry in the tooltip", () => {
    assert.equal(trayTooltip(running, at(3700)), "Write the plan — 1h 01m");
    assert.equal(trayTooltip(null, at(0)), "Track Your Time");
    const noDescription = { ...running, running: { ...running.running!, description: "  " } };
    assert.equal(trayTooltip(noDescription, at(1)), "Desktop — <1m");
  });

  it("picks a per-platform icon file", () => {
    assert.equal(trayIconFile("darwin", "idle"), "tray-mac.png");
    assert.equal(trayIconFile("win32", "running"), "tray-running.ico");
    assert.equal(trayIconFile("linux", "running"), "tray-running.png");
  });
});

describe("parseTimerState", () => {
  it("refuses a payload without signedIn", () => {
    assert.equal(parseTimerState({ running: null }), null);
    assert.equal(parseTimerState("x"), null);
  });

  it("drops a running entry with a bad start, a bad colour, extra recents and foreign labels", () => {
    const parsed = parseTimerState({
      signedIn: true,
      running: { description: "x", startedAt: "yesterday", projectName: null, projectColor: null },
      recents: Array.from({ length: 9 }, (_, i) => ({ key: `k${i}`, label: `r${i}`, hint: null })),
      unsent: 3.7,
      labels: { stop: "Stop!", evil: "<script>" },
    });
    assert.equal(parsed?.running, null);
    assert.equal(parsed?.recents.length, 5);
    assert.equal(parsed?.unsent, 3);
    assert.equal(parsed?.labels.stop, "Stop!");
    assert.equal("evil" in (parsed?.labels ?? {}), false);
    const colour = parseTimerState({
      signedIn: true,
      running: { description: "", startedAt: start, projectName: "P", projectColor: "red; x" },
    });
    assert.equal(colour?.running?.projectColor, null);
  });

  it("signed out carries no timer, recents or Autopilot", () => {
    const parsed = parseTimerState({ ...running, signedIn: false, autopilot: { pausedUntil: 5 } });
    assert.equal(parsed?.running, null);
    assert.deepEqual(parsed?.recents, []);
    assert.equal(parsed?.autopilot, null);
  });

  it("reads the Autopilot mark and pause, and nothing else in their place", () => {
    const parsed = parseTimerState({
      ...running,
      running: { ...running.running, autopilot: true },
      autopilot: { pausedUntil: at(60) },
    });
    assert.equal(parsed?.running?.autopilot, true);
    assert.deepEqual(parsed?.autopilot, { pausedUntil: at(60) });
    const odd = parseTimerState({
      ...running,
      running: { ...running.running, autopilot: "yes" },
      autopilot: { pausedUntil: "soon" },
    });
    assert.equal(odd?.running?.autopilot, undefined);
    assert.deepEqual(odd?.autopilot, { pausedUntil: null });
    assert.equal(parseTimerState({ ...running, autopilot: true })?.autopilot, null);
    assert.equal(autopilotPausedAt(odd, at(0)), false);
    assert.equal(autopilotPausedAt(parsed, at(59)), true);
    assert.equal(autopilotPausedAt(parsed, at(60)), false);
  });
});

describe("parseNotice", () => {
  it("needs a known kind and a title", () => {
    assert.equal(parseNotice({ kind: "other", title: "x" }), null);
    assert.equal(parseNotice({ kind: "idle", title: " " }), null);
    assert.deepEqual(parseNotice({ kind: "idle", title: "Away", body: "24 min" }), {
      kind: "idle",
      title: "Away",
      body: "24 min",
      tag: "idle",
    });
  });
});
