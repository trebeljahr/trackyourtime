import assert from "node:assert/strict";
import { it } from "node:test";
import { defaultDesktopSettings } from "./desktop-settings.ts";
import { desktopWindowPolicy } from "./window-policy.ts";

it("keeps a default Linux login launch reachable without an indicator host", () => {
  assert.deepEqual(desktopWindowPolicy("linux", defaultDesktopSettings("linux")), {
    hideOnClose: false, allowHiddenLaunch: false,
  });
});

it("allows Linux background launches only after opting into close-to-tray", () => {
  const settings = { ...defaultDesktopSettings("linux"), closeHides: true };
  assert.equal(desktopWindowPolicy("linux", settings).allowHiddenLaunch, true);
  assert.deepEqual(desktopWindowPolicy("linux", { ...settings, showInTray: false }), {
    hideOnClose: false, allowHiddenLaunch: false,
  });
});

it("preserves Windows tray launches and macOS Dock recovery", () => {
  assert.deepEqual(desktopWindowPolicy("win32", defaultDesktopSettings("win32")), {
    hideOnClose: true, allowHiddenLaunch: true,
  });
  assert.deepEqual(desktopWindowPolicy("darwin", { showInTray: false, closeHides: false }), {
    hideOnClose: true, allowHiddenLaunch: false,
  });
  assert.deepEqual(desktopWindowPolicy("win32", { showInTray: false, closeHides: true }), {
    hideOnClose: false, allowHiddenLaunch: false,
  });
});
