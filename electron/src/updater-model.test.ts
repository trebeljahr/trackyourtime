import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DesktopUpdateSnapshot, DesktopUpdateStatus } from "../../packages/shared/src/desktop-bridge.ts";
import { selfUpdates, type DistributionChannel } from "./distribution.ts";
import {
  createUpdateController,
  DISABLE_UPDATES_ENV,
  FIRST_CHECK_DELAY_MS,
  mayCheck,
  nextUpdateStatus,
  UPDATE_CHECK_INTERVAL_MS,
  updaterPolicy,
  type Scheduler,
  type UpdaterLike,
  type UpdaterPolicy,
} from "./updater-model.ts";

const NOW = "2026-09-17T10:00:00.000Z";

describe("updaterPolicy", () => {
  it("updates only the three direct downloads, and only with a feed", () => {
    for (const channel of ["mac-direct", "windows-direct", "appimage"] as const) {
      assert.deepEqual(updaterPolicy({ channel, hasFeed: true, env: {} }), { enabled: true }, channel);
      assert.deepEqual(updaterPolicy({ channel, hasFeed: false, env: {} }), { enabled: false, reason: "no-feed" }, channel);
    }
  });

  it("leaves every store, sandbox and package manager alone, feed or not", () => {
    const expected: [DistributionChannel, string][] = [
      ["mac-app-store", "store"],
      ["windows-store", "store"],
      ["snap", "sandbox"],
      ["flatpak", "sandbox"],
      ["linux-package", "package-manager"],
      ["unpackaged", "unpackaged"],
    ];
    for (const [channel, reason] of expected) {
      // electron-builder writes app-update.yml into deb, rpm and snap builds
      // too, so the feed alone must never switch updates on.
      assert.deepEqual(updaterPolicy({ channel, hasFeed: true, env: {} }), { enabled: false, reason }, channel);
    }
  });

  it("agrees with selfUpdates for every channel", () => {
    const channels: DistributionChannel[] = ["mac-app-store", "mac-direct", "windows-store", "windows-direct", "snap", "flatpak", "appimage", "linux-package", "unpackaged"];
    for (const channel of channels) {
      assert.equal(updaterPolicy({ channel, hasFeed: true, env: {} }).enabled, selfUpdates(channel), channel);
    }
  });

  it("can be turned off on a managed machine", () => {
    assert.deepEqual(updaterPolicy({ channel: "mac-direct", hasFeed: true, env: { [DISABLE_UPDATES_ENV]: "1" } }), {
      enabled: false,
      reason: "turned-off",
    });
    assert.deepEqual(updaterPolicy({ channel: "mac-direct", hasFeed: true, env: { [DISABLE_UPDATES_ENV]: "0" } }), {
      enabled: true,
    });
  });
});

describe("nextUpdateStatus", () => {
  const idle: DesktopUpdateStatus = { kind: "idle", lastCheckedAt: null };

  it("walks check → download → ready", () => {
    let status = nextUpdateStatus(idle, { kind: "checking" }, NOW);
    assert.deepEqual(status, { kind: "checking", lastCheckedAt: null });
    status = nextUpdateStatus(status, { kind: "available", version: "0.1.1" }, NOW);
    assert.deepEqual(status, { kind: "downloading", version: "0.1.1", percent: null });
    status = nextUpdateStatus(status, { kind: "progress", percent: 41.6 }, NOW);
    assert.deepEqual(status, { kind: "downloading", version: "0.1.1", percent: 42 });
    status = nextUpdateStatus(status, { kind: "downloaded", version: "0.1.1" }, NOW);
    assert.deepEqual(status, { kind: "ready", version: "0.1.1" });
  });

  it("records when a check found nothing", () => {
    const status = nextUpdateStatus({ kind: "checking", lastCheckedAt: null }, { kind: "not-available" }, NOW);
    assert.deepEqual(status, { kind: "idle", lastCheckedAt: NOW });
  });

  it("keeps a downloaded update through later checks and their errors", () => {
    const ready: DesktopUpdateStatus = { kind: "ready", version: "0.1.1" };
    for (const event of [{ kind: "checking" }, { kind: "not-available" }, { kind: "error" }, { kind: "available", version: "0.1.2" }] as const) {
      assert.deepEqual(nextUpdateStatus(ready, event, NOW), ready, event.kind);
    }
    assert.deepEqual(nextUpdateStatus(ready, { kind: "downloaded", version: "0.1.2" }, NOW), { kind: "ready", version: "0.1.2" });
  });

  it("does not let a check interrupt a download", () => {
    const downloading: DesktopUpdateStatus = { kind: "downloading", version: "0.1.1", percent: 10 };
    assert.deepEqual(nextUpdateStatus(downloading, { kind: "checking" }, NOW), downloading);
    assert.equal(mayCheck(downloading), false);
    assert.equal(mayCheck({ kind: "checking", lastCheckedAt: null }), false);
    assert.equal(mayCheck({ kind: "error", lastCheckedAt: null }), true);
  });

  it("never leaves disabled", () => {
    const disabled: DesktopUpdateStatus = { kind: "disabled", reason: "store" };
    assert.deepEqual(nextUpdateStatus(disabled, { kind: "downloaded", version: "9.9.9" }, NOW), disabled);
  });
});

function fakeUpdater(): UpdaterLike & {
  listeners: Map<string, (...args: unknown[]) => void>;
  checks: number;
  installs: [boolean | undefined, boolean | undefined][];
  emit: (event: string, ...args: unknown[]) => void;
} {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const fake = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    allowPrerelease: true,
    allowDowngrade: true,
    listeners,
    checks: 0,
    installs: [] as [boolean | undefined, boolean | undefined][],
    checkForUpdates: () => {
      fake.checks += 1;
      return Promise.resolve(null);
    },
    quitAndInstall: (isSilent?: boolean, isForceRunAfter?: boolean) => {
      fake.installs.push([isSilent, isForceRunAfter]);
    },
    on: (event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, listener);
      return fake;
    },
    emit: (event: string, ...args: unknown[]) => listeners.get(event)?.(...args),
  };
  return fake;
}

function fakeScheduler(): Scheduler & { timeouts: [() => void, number][]; intervals: [() => void, number][]; cleared: number } {
  const scheduler = {
    timeouts: [] as [() => void, number][],
    intervals: [] as [() => void, number][],
    cleared: 0,
    setTimeout: (fn: () => void, ms: number) => {
      scheduler.timeouts.push([fn, ms]);
      return scheduler.timeouts.length;
    },
    setInterval: (fn: () => void, ms: number) => {
      scheduler.intervals.push([fn, ms]);
      return -scheduler.intervals.length;
    },
    clear: () => {
      scheduler.cleared += 1;
    },
  };
  return scheduler;
}

function setup(policy: UpdaterPolicy = { enabled: true }) {
  const updater = fakeUpdater();
  const scheduler = fakeScheduler();
  const changes: DesktopUpdateSnapshot[] = [];
  let loads = 0;
  let beforeInstall = 0;
  const controller = createUpdateController({
    policy,
    currentVersion: "0.1.0",
    loadUpdater: () => {
      loads += 1;
      return updater;
    },
    scheduler,
    now: () => new Date(NOW),
    onChange: (snapshot) => changes.push(snapshot),
    beforeInstall: () => {
      beforeInstall += 1;
    },
  });
  return { controller, updater, scheduler, changes, loads: () => loads, beforeInstall: () => beforeInstall };
}

describe("createUpdateController", () => {
  it("never loads the updater, schedules or checks when updates are off", () => {
    const { controller, scheduler, updater, loads } = setup({ enabled: false, reason: "store" });
    assert.equal(loads(), 0);
    assert.equal(scheduler.timeouts.length + scheduler.intervals.length, 0);
    assert.deepEqual(controller.check(), { currentVersion: "0.1.0", status: { kind: "disabled", reason: "store" } });
    assert.equal(updater.checks, 0);
    assert.equal(controller.restart(), false);
  });

  it("downloads in the background and installs on quit, stable releases only", () => {
    const { updater } = setup();
    assert.equal(updater.autoDownload, true);
    assert.equal(updater.autoInstallOnAppQuit, true);
    assert.equal(updater.allowPrerelease, false);
    assert.equal(updater.allowDowngrade, false);
  });

  it("checks after launch and every six hours", () => {
    const { scheduler, updater } = setup();
    assert.deepEqual(scheduler.timeouts.map(([, ms]) => ms), [FIRST_CHECK_DELAY_MS]);
    assert.deepEqual(scheduler.intervals.map(([, ms]) => ms), [UPDATE_CHECK_INTERVAL_MS]);
    assert.equal(UPDATE_CHECK_INTERVAL_MS, 21_600_000);
    scheduler.timeouts[0]![0]();
    assert.equal(updater.checks, 1);
    // Still checking: the interval firing now must not start a second request.
    scheduler.intervals[0]![0]();
    assert.equal(updater.checks, 1);
    updater.emit("update-not-available", { version: "0.1.0" });
    scheduler.intervals[0]![0]();
    assert.equal(updater.checks, 2);
  });

  it("never restarts on its own when an update arrives", () => {
    const { updater, controller, changes, beforeInstall } = setup();
    controller.check();
    updater.emit("update-available", { version: "0.1.1" });
    updater.emit("download-progress", { percent: 99.9 });
    updater.emit("update-downloaded", { version: "0.1.1" });
    assert.deepEqual(controller.snapshot().status, { kind: "ready", version: "0.1.1" });
    assert.equal(changes.at(-1)?.status.kind, "ready");
    // Downloaded and announced, and nothing quit.
    assert.equal(updater.installs.length, 0);
    assert.equal(beforeInstall(), 0);
  });

  it("restarts only when asked and only with an update ready", () => {
    const { updater, controller, beforeInstall } = setup();
    assert.equal(controller.restart(), false);
    updater.emit("update-available", { version: "0.1.1" });
    assert.equal(controller.restart(), false, "still downloading");
    updater.emit("update-downloaded", { version: "0.1.1" });
    assert.equal(controller.restart(), true);
    assert.deepEqual(updater.installs, [[false, true]]);
    assert.equal(beforeInstall(), 1);
  });

  it("turns a rejected check into an error status, and tries again later", async () => {
    const { updater, controller, scheduler } = setup();
    updater.checkForUpdates = () => {
      updater.checks += 1;
      return Promise.reject(new Error("offline"));
    };
    controller.check();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(controller.snapshot().status, { kind: "error", lastCheckedAt: null });
    scheduler.intervals[0]![0]();
    assert.equal(updater.checks, 2);
  });

  it("stops its timers on dispose", () => {
    const { controller, scheduler } = setup();
    controller.dispose();
    assert.equal(scheduler.cleared, 2);
  });
});

describe("no forced restart, in the source", () => {
  it("calls quitAndInstall in one place, and restart only from a tray click or the Settings button", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const dir = new URL(".", import.meta.url);
    const sources = readdirSync(dir)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .map((name) => ({ name, text: readFileSync(new URL(name, dir), "utf8") }));
    const callers = (pattern: RegExp): string[] =>
      sources.flatMap(({ name, text }) => (text.match(pattern) ?? []).map(() => name));
    assert.deepEqual(callers(/\.quitAndInstall\(/g), ["updater-model.ts"]);
    // desktop.ts: the tray's "restart-to-update" item and the update:restart
    // IPC handler, which only the "Restart to update" button invokes.
    assert.deepEqual(callers(/controller\.restart\(\)/g), ["desktop.ts", "desktop.ts"]);
    const desktop = sources.find(({ name }) => name === "desktop.ts")!.text;
    assert.match(desktop, /id === "restart-to-update"\) updates\.controller\.restart\(\)/);
    assert.match(desktop, /DESKTOP_IPC\.updateRestart, \(\) => updates\.controller\.restart\(\)/);
  });
});
