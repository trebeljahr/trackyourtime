import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  activityCaptureSupport,
  distributionChannel,
  loginItemMechanism,
  selfUpdates,
  type DistributionInputs,
} from "./distribution.ts";

const base: DistributionInputs = { platform: "linux", isPackaged: true, mas: false, windowsStore: false, env: {} };

describe("distributionChannel", () => {
  it("is unpackaged before anything else", () => {
    assert.equal(distributionChannel({ ...base, isPackaged: false, env: { SNAP: "/snap/x" } }), "unpackaged");
  });

  it("tells the two macOS builds apart by process.mas", () => {
    assert.equal(distributionChannel({ ...base, platform: "darwin", mas: true }), "mac-app-store");
    assert.equal(distributionChannel({ ...base, platform: "darwin" }), "mac-direct");
  });

  it("tells the two Windows builds apart by process.windowsStore", () => {
    assert.equal(distributionChannel({ ...base, platform: "win32", windowsStore: true }), "windows-store");
    assert.equal(distributionChannel({ ...base, platform: "win32" }), "windows-direct");
  });

  it("reads the Linux sandbox from the environment its runtime sets", () => {
    assert.equal(distributionChannel({ ...base, env: { SNAP: "/snap/trackyourtime/12" } }), "snap");
    assert.equal(distributionChannel({ ...base, env: { FLATPAK_ID: "com.ricoslabs.trackyourtime" } }), "flatpak");
    assert.equal(distributionChannel({ ...base, env: { APPIMAGE: "/home/me/T.AppImage" } }), "appimage");
    assert.equal(distributionChannel(base), "linux-package");
  });

  it("ignores a stray SNAP on macOS and Windows", () => {
    assert.equal(distributionChannel({ ...base, platform: "darwin", env: { SNAP: "x" } }), "mac-direct");
  });
});

describe("selfUpdates", () => {
  it("is off for every store and package manager", () => {
    for (const channel of ["mac-app-store", "windows-store", "snap", "flatpak", "linux-package", "unpackaged"] as const) {
      assert.equal(selfUpdates(channel), false, channel);
    }
  });

  it("is on for the direct downloads electron-updater can replace", () => {
    for (const channel of ["mac-direct", "windows-direct", "appimage"] as const) {
      assert.equal(selfUpdates(channel), true, channel);
    }
  });
});

describe("loginItemMechanism", () => {
  const context = { execPath: "/opt/Track Your Time/trackyourtime", env: {}, snapCommand: "trackyourtime" };

  it("uses Electron's API on macOS (App Store too) and direct Windows", () => {
    assert.deepEqual(loginItemMechanism("mac-app-store", context), { kind: "electron" });
    assert.deepEqual(loginItemMechanism("windows-direct", context), { kind: "electron" });
  });

  it("reports the Microsoft Store and Flatpak as unsupported", () => {
    assert.equal(loginItemMechanism("windows-store", context).kind, "unsupported");
    assert.equal(loginItemMechanism("flatpak", context).kind, "unsupported");
  });

  it("points each Linux entry at the right executable", () => {
    assert.deepEqual(loginItemMechanism("snap", context), { kind: "xdg-autostart", exec: "/snap/bin/trackyourtime" });
    assert.deepEqual(loginItemMechanism("appimage", { ...context, env: { APPIMAGE: "/home/me/T.AppImage" } }), {
      kind: "xdg-autostart",
      exec: "/home/me/T.AppImage",
    });
    assert.deepEqual(loginItemMechanism("linux-package", context), {
      kind: "xdg-autostart",
      exec: "/opt/Track Your Time/trackyourtime",
    });
  });
});

describe("activityCaptureSupport", () => {
  const channels = [
    "mac-app-store",
    "mac-direct",
    "windows-store",
    "windows-direct",
    "snap",
    "flatpak",
    "appimage",
    "linux-package",
    "unpackaged",
  ] as const;
  const platformOf = (channel: (typeof channels)[number]): NodeJS.Platform =>
    channel.startsWith("mac") ? "darwin" : channel.startsWith("windows") ? "win32" : "linux";
  const x11 = { DISPLAY: ":0", XDG_SESSION_TYPE: "x11" };
  const wayland = { DISPLAY: ":0", XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0" };

  it("answers every channel, under X11 and under Wayland", () => {
    const expected: Record<(typeof channels)[number], [string, string]> = {
      "mac-app-store": ["store", "store"],
      "mac-direct": ["macos-lsappinfo", "macos-lsappinfo"],
      "windows-store": ["store", "store"],
      "windows-direct": ["windows-powershell", "windows-powershell"],
      snap: ["linux-sandbox", "linux-sandbox"],
      flatpak: ["linux-sandbox", "linux-sandbox"],
      appimage: ["linux-xprop", "wayland"],
      "linux-package": ["linux-xprop", "wayland"],
      unpackaged: ["linux-xprop", "wayland"],
    };
    const answer = (support: ReturnType<typeof activityCaptureSupport>): string =>
      support.kind === "supported" ? support.mechanism : support.reason;
    for (const channel of channels) {
      const platform = platformOf(channel);
      assert.equal(answer(activityCaptureSupport(channel, platform, x11)), expected[channel][0], `${channel} x11`);
      assert.equal(answer(activityCaptureSupport(channel, platform, wayland)), expected[channel][1], `${channel} wayland`);
    }
  });

  it("reads Wayland from WAYLAND_DISPLAY alone too", () => {
    assert.deepEqual(activityCaptureSupport("appimage", "linux", { DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-1" }), {
      kind: "unsupported",
      reason: "wayland",
    });
  });

  it("refuses Linux with no X display at all", () => {
    assert.deepEqual(activityCaptureSupport("linux-package", "linux", {}), {
      kind: "unsupported",
      reason: "unsupported-platform",
    });
  });

  it("is supported unpackaged on macOS and Windows", () => {
    assert.equal(activityCaptureSupport("unpackaged", "darwin", {}).kind, "supported");
    assert.equal(activityCaptureSupport("unpackaged", "win32", {}).kind, "supported");
    assert.equal(activityCaptureSupport("unpackaged", "freebsd", {}).kind, "unsupported");
  });
});
