import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { applySettingsPatch, defaultDesktopSettings, parseDesktopSettings } from "./desktop-settings.ts";

describe("defaultDesktopSettings", () => {
  it("binds only the toggle, and hides on close only where a tray is certain", () => {
    for (const platform of ["darwin", "win32", "linux"]) {
      const settings = defaultDesktopSettings(platform);
      assert.equal(settings.shortcuts["toggle-timer"], "CommandOrControl+Alt+Shift+Space");
      assert.deepEqual(
        Object.entries(settings.shortcuts).filter(([, value]) => value !== null).map(([key]) => key),
        ["toggle-timer"],
      );
      assert.equal(settings.openAtLogin, false);
      assert.equal(settings.runningBadge, false);
      assert.equal(settings.showInTray, true);
    }
    assert.equal(defaultDesktopSettings("win32").closeHides, true);
    assert.equal(defaultDesktopSettings("linux").closeHides, false);
  });
});

describe("parseDesktopSettings", () => {
  it("falls back to defaults for a missing, corrupt or foreign file", () => {
    const defaults = defaultDesktopSettings("darwin");
    assert.deepEqual(parseDesktopSettings(null, "darwin"), defaults);
    assert.deepEqual(parseDesktopSettings("{nope", "darwin"), defaults);
    assert.deepEqual(parseDesktopSettings("[1,2]", "darwin"), defaults);
    assert.deepEqual(parseDesktopSettings(JSON.stringify({ openAtLogin: "yes" }), "darwin"), defaults);
  });

  it("keeps a cleared default, normalises bindings and drops ones Electron would throw on", () => {
    const parsed = parseDesktopSettings(
      JSON.stringify({
        openAtLogin: true,
        shortcuts: { "toggle-timer": null, "new-timer": "ctrl+shift+n", "open-palette": "Cmd+Banana", unknown: "F13" },
      }),
      "linux",
    );
    assert.equal(parsed.openAtLogin, true);
    assert.equal(parsed.shortcuts["toggle-timer"], null);
    assert.equal(parsed.shortcuts["new-timer"], "Control+Shift+N");
    assert.equal(parsed.shortcuts["open-palette"], null);
    assert.equal("unknown" in parsed.shortcuts, false);
  });

  it("gives a repeated chord to the earlier action only", () => {
    const parsed = parseDesktopSettings(
      JSON.stringify({ shortcuts: { "toggle-timer": "Command+K", "open-palette": "CommandOrControl+K" } }),
      "darwin",
    );
    assert.equal(parsed.shortcuts["toggle-timer"], "Command+K");
    assert.equal(parsed.shortcuts["open-palette"], null);
    // On Windows the same two strings are different keys.
    const win = parseDesktopSettings(
      JSON.stringify({ shortcuts: { "toggle-timer": "Super+K", "open-palette": "CommandOrControl+K" } }),
      "win32",
    );
    assert.equal(win.shortcuts["open-palette"], "CommandOrControl+K");
  });
});

describe("applySettingsPatch", () => {
  const base = defaultDesktopSettings("darwin");

  it("applies booleans and ignores anything that is not one", () => {
    const { next } = applySettingsPatch(base, { openAtLogin: true, showInTray: "no", runningBadge: 1 }, "darwin");
    assert.equal(next.openAtLogin, true);
    assert.equal(next.showInTray, true);
    assert.equal(next.runningBadge, false);
    assert.equal(base.openAtLogin, false, "the current settings are not mutated");
  });

  it("refuses an invalid accelerator without saving it", () => {
    const { next, refused } = applySettingsPatch(base, { shortcuts: { "new-timer": "Shift+A" } }, "darwin");
    assert.equal(next.shortcuts["new-timer"], null);
    assert.deepEqual(refused, [{ action: "new-timer", accelerator: "Shift+A", registered: false, problem: "invalid" }]);
  });

  it("refuses a chord another action holds, naming it", () => {
    const { next, refused } = applySettingsPatch(
      base,
      { shortcuts: { "open-palette": "Command+Alt+Shift+Space" } },
      "darwin",
    );
    assert.equal(next.shortcuts["open-palette"], null);
    assert.equal(refused[0]?.problem, "duplicate");
    assert.equal(refused[0]?.conflictsWith, "toggle-timer");
  });

  it("moves a chord between actions in one patch, clearing first", () => {
    const { next, refused } = applySettingsPatch(
      base,
      { shortcuts: { "open-palette": "CommandOrControl+Alt+Shift+Space", "toggle-timer": null } },
      "darwin",
    );
    assert.deepEqual(refused, []);
    assert.equal(next.shortcuts["toggle-timer"], null);
    assert.equal(next.shortcuts["open-palette"], "CommandOrControl+Alt+Shift+Space");
  });

  it("ignores unknown actions and non-object patches", () => {
    assert.deepEqual(applySettingsPatch(base, { shortcuts: { nope: "F13" } }, "darwin").next, base);
    assert.deepEqual(applySettingsPatch(base, "openAtLogin", "darwin").next, base);
  });
});
