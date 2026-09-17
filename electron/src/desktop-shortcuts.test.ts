import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  acceleratorChord,
  normalizeAccelerator,
} from "../../packages/shared/src/desktop-shortcuts.ts";

describe("normalizeAccelerator", () => {
  it("spells modifiers canonically and in a fixed order", () => {
    assert.equal(normalizeAccelerator("shift+alt+cmdorctrl+space"), "CommandOrControl+Alt+Shift+Space");
    assert.equal(normalizeAccelerator("Option+Cmd+t"), "Command+Alt+T");
    assert.equal(normalizeAccelerator("ctrl+meta+f5"), "Control+Super+F5");
    assert.equal(normalizeAccelerator("Control+Plus"), "Control+Plus");
    assert.equal(normalizeAccelerator("Control+/"), "Control+/");
  });

  it("allows F13 to F24 alone, and nothing else without a modifier", () => {
    assert.equal(normalizeAccelerator("F13"), "F13");
    assert.equal(normalizeAccelerator("shift+F24"), "Shift+F24");
    for (const bad of ["A", "Shift+A", "F5", "Space", "Shift+Space"]) {
      assert.equal(normalizeAccelerator(bad), null, bad);
    }
  });

  it("refuses what globalShortcut would throw on or misread", () => {
    for (const bad of [
      "",
      "Control",
      "Control+A+B",
      "Control+Control+A",
      "CommandOrControl+Command+A",
      "Control+Banana",
      "Control++",
      "Hyper+A",
      `Control+${"A".repeat(90)}`,
    ]) {
      assert.equal(normalizeAccelerator(bad), null, bad);
    }
  });
});

describe("acceleratorChord", () => {
  it("resolves CommandOrControl and Super per platform", () => {
    assert.equal(acceleratorChord("CommandOrControl+K", "darwin"), "Command+K");
    assert.equal(acceleratorChord("Super+K", "darwin"), "Command+K");
    assert.equal(acceleratorChord("CommandOrControl+K", "win32"), "Control+K");
    assert.equal(acceleratorChord("Super+K", "linux"), "Super+K");
  });
});
