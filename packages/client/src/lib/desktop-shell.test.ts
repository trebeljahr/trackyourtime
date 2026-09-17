// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  desktopShell,
  focusTrackerDescription,
  formatAccelerator,
  notifyDesktop,
  recordKey,
  stealsTypedCharacter,
  type KeyWords,
} from "@/lib/desktop-shell";

const press = (code: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) => ({
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

const EN: KeyWords = {
  ctrl: "Ctrl",
  alt: "Alt",
  shift: "Shift",
  win: "Win",
  super: "Super",
  space: "Space",
  enter: "Enter",
  escape: "Esc",
  backspace: "Backspace",
  delete: "Delete",
};

afterEach(() => {
  delete (window as { electronAPI?: unknown }).electronAPI;
  document.body.innerHTML = "";
});

describe("recordKey", () => {
  it("waits while only modifiers are held", () => {
    expect(recordKey(press("ShiftLeft", { shiftKey: true }), "darwin")).toEqual({ kind: "pending" });
    expect(recordKey(press("MetaRight", { metaKey: true }), "win32")).toEqual({ kind: "pending" });
  });

  it("cancels on a bare Escape", () => {
    expect(recordKey(press("Escape"), "linux")).toEqual({ kind: "cancel" });
  });

  it("reads the physical key, whatever character the layout types", () => {
    // Option+T on a Mac reports key "†"; the code is still KeyT.
    expect(recordKey(press("KeyT", { metaKey: true, altKey: true }), "darwin")).toEqual({
      kind: "accelerator",
      accelerator: "Command+Alt+T",
    });
    expect(recordKey(press("Space", { ctrlKey: true, altKey: true, shiftKey: true }), "win32")).toEqual({
      kind: "accelerator",
      accelerator: "Control+Alt+Shift+Space",
    });
    expect(recordKey(press("Slash", { metaKey: true }), "linux")).toEqual({
      kind: "accelerator",
      accelerator: "Super+/",
    });
    expect(recordKey(press("F13"), "darwin")).toEqual({ kind: "accelerator", accelerator: "F13" });
  });

  it("refuses a key that would steal typing, or one Electron cannot name", () => {
    expect(recordKey(press("KeyA"), "darwin")).toEqual({ kind: "invalid", attempted: "A" });
    expect(recordKey(press("KeyA", { shiftKey: true }), "win32")).toEqual({ kind: "invalid", attempted: "Shift+A" });
    expect(recordKey(press("IntlBackslash", { ctrlKey: true }), "linux").kind).toBe("invalid");
  });
});

describe("formatAccelerator", () => {
  it("uses macOS symbols in menu order", () => {
    expect(formatAccelerator("CommandOrControl+Alt+Shift+Space", "darwin", EN)).toBe("⌥⇧⌘Space");
    expect(formatAccelerator("Control+Command+Up", "darwin", EN)).toBe("⌃⌘↑");
  });

  it("spells modifiers out elsewhere, in the reader's language", () => {
    expect(formatAccelerator("CommandOrControl+Alt+Shift+Space", "win32", EN)).toBe("Ctrl+Alt+Shift+Space");
    const de = { ...EN, ctrl: "Strg", shift: "Umschalt", space: "Leertaste" };
    expect(formatAccelerator("CommandOrControl+Alt+Shift+Space", "linux", de)).toBe("Strg+Alt+Umschalt+Leertaste");
    expect(formatAccelerator("Super+K", "win32", EN)).toBe("Win+K");
  });
});

describe("stealsTypedCharacter", () => {
  it("flags Option-only chords on a Mac, and nothing elsewhere", () => {
    expect(stealsTypedCharacter("Alt+T", "darwin")).toBe(true);
    expect(stealsTypedCharacter("Alt+Shift+Space", "darwin")).toBe(true);
    expect(stealsTypedCharacter("Command+Alt+T", "darwin")).toBe(false);
    expect(stealsTypedCharacter("Alt+F5", "darwin")).toBe(false);
    expect(stealsTypedCharacter("Alt+T", "win32")).toBe(false);
  });
});

describe("desktopShell and notifyDesktop", () => {
  it("are inert outside the desktop app", () => {
    expect(desktopShell()).toBeNull();
    expect(() => notifyDesktop({ kind: "idle", title: "t", body: "b", tag: "idle" })).not.toThrow();
  });

  it("hand a notice to the bridge in the desktop app", () => {
    const notify = vi.fn(() => Promise.resolve(true));
    (window as { electronAPI?: unknown }).electronAPI = { isDesktop: true, desktop: { notify } };
    notifyDesktop({ kind: "runaway", title: "t", body: "b", tag: "runaway:1" });
    expect(notify).toHaveBeenCalledWith({ kind: "runaway", title: "t", body: "b", tag: "runaway:1" });
  });
});

describe("focusTrackerDescription", () => {
  it("waits for the field to mount", async () => {
    vi.useFakeTimers();
    focusTrackerDescription(1000);
    const input = document.createElement("input");
    input.dataset.testid = "tracker-description";
    document.body.append(input);
    await vi.advanceTimersByTimeAsync(60);
    expect(document.activeElement).toBe(input);
    vi.useRealTimers();
  });
});
