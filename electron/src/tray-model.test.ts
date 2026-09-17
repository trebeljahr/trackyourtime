import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DesktopTimerState } from "../../packages/shared/src/desktop-bridge.ts";
import {
  FALLBACK_TRAY_LABELS,
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

  it("running: the entry with Stop, recents, start, unsent count, open, settings, quit", () => {
    const model = trayMenuModel(running);
    assert.deepEqual(
      model.map((item) => (item.type === "item" ? item.id : item.type === "heading" ? `# ${item.label}` : "---")),
      [
        "# Write the plan",
        "stop",
        "---",
        "# Continue",
        "continue:k1",
        "continue:k2",
        "---",
        "start",
        "---",
        "# 2 unsent changes",
        "---",
        "open",
        "settings",
        "---",
        "quit",
      ],
    );
    const labels = model.flatMap((item) => (item.type === "item" ? [item.label] : []));
    assert.ok(labels.includes("Stoppen"), "labels come from the payload");
    assert.ok(labels.includes("Review — Client — Project"));
    assert.ok(labels.includes("(no description)"));
  });

  it("idle with nothing queued: no Stop and no unsent line", () => {
    const ids = trayMenuModel({ ...running, running: null, unsent: 0 }).map((item) =>
      item.type === "item" ? item.id : item.type,
    );
    assert.equal(ids.includes("stop"), false);
    assert.equal(ids.filter((id) => id === "heading").length, 1);
  });
});

describe("title, tooltip and icon", () => {
  it("ticks the macOS title from startedAt and leaves it empty when idle", () => {
    assert.equal(trayTitle(running, at(125), "darwin"), "2:05");
    assert.equal(trayTitle(running, at(125), "win32"), "");
    assert.equal(trayTitle({ ...running, running: null }, at(125), "darwin"), "");
  });

  it("puts the clock and the entry in the tooltip", () => {
    assert.equal(trayTooltip(running, at(3700)), "1:01 · Write the plan");
    assert.equal(trayTooltip(null, at(0)), "Track Your Time");
    const noDescription = { ...running, running: { ...running.running!, description: "  " } };
    assert.equal(trayTooltip(noDescription, at(1)), "0:01 · Desktop");
  });

  it("picks a per-platform icon file", () => {
    assert.equal(trayIconFile("darwin", "idle"), "trayTemplate.png");
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

  it("signed out carries no timer or recents", () => {
    const parsed = parseTimerState({ ...running, signedIn: false });
    assert.equal(parsed?.running, null);
    assert.deepEqual(parsed?.recents, []);
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
