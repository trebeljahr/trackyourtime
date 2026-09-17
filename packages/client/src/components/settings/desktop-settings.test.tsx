// @vitest-environment jsdom
import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import {
  DEFAULT_DESKTOP_SHORTCUTS,
  DESKTOP_SHORTCUT_ACTIONS,
  type DesktopSettingsPatch,
  type DesktopSettingsSnapshot,
  type DesktopShortcutStatus,
} from "@starter/shared";

import { DesktopSettingsPanel } from "./desktop-settings";

const snapshotWith = (overrides: Partial<DesktopSettingsSnapshot> = {}): DesktopSettingsSnapshot => ({
  settings: {
    openAtLogin: false,
    showInTray: true,
    closeHides: false,
    runningBadge: false,
    shortcuts: { ...DEFAULT_DESKTOP_SHORTCUTS },
  },
  shortcuts: DESKTOP_SHORTCUT_ACTIONS.map((action) => ({
    action,
    accelerator: DEFAULT_DESKTOP_SHORTCUTS[action],
    registered: DEFAULT_DESKTOP_SHORTCUTS[action] !== null,
    problem: null,
  })),
  shortcutsSuspended: false,
  loginItem: "disabled",
  capabilities: { closeHides: false, runningBadge: true },
  ...overrides,
});

function installBridge(initial: DesktopSettingsSnapshot, platform = "darwin") {
  const calls = { patches: [] as DesktopSettingsPatch[], suspended: [] as boolean[] };
  let current = initial;
  let refuse: DesktopShortcutStatus[] = [];
  let taken: string | null = null;
  (window as { electronAPI?: unknown }).electronAPI = {
    isDesktop: true,
    platform,
    desktop: {
      getSettings: () => Promise.resolve(current),
      onSettingsChanged: () => () => undefined,
      suspendShortcuts: (on: boolean) => {
        calls.suspended.push(on);
        return Promise.resolve();
      },
      updateSettings: (patch: DesktopSettingsPatch) => {
        calls.patches.push(patch);
        const shortcuts = { ...current.settings.shortcuts, ...patch.shortcuts };
        current = {
          ...current,
          settings: { ...current.settings, ...patch, shortcuts } as DesktopSettingsSnapshot["settings"],
          shortcuts: DESKTOP_SHORTCUT_ACTIONS.map((action) => ({
            action,
            accelerator: shortcuts[action] ?? null,
            registered: shortcuts[action] != null && shortcuts[action] !== taken,
            problem: shortcuts[action] != null && shortcuts[action] === taken ? "taken" : null,
          })),
        };
        const result = { snapshot: current, refused: refuse };
        refuse = [];
        return Promise.resolve(result);
      },
    },
  };
  return {
    calls,
    refuseNext: (status: DesktopShortcutStatus) => {
      refuse = [status];
    },
    take: (accelerator: string) => {
      taken = accelerator;
    },
  };
}

afterEach(() => {
  cleanup();
  delete (window as { electronAPI?: unknown }).electronAPI;
});

describe("DesktopSettingsPanel", () => {
  it("renders nothing on the web, before and after mount", async () => {
    expect(renderToString(<DesktopSettingsPanel />)).toBe("");
    const { container } = render(<DesktopSettingsPanel />);
    await act(async () => undefined);
    expect(container.innerHTML).toBe("");
  });

  it("shows the default toggle binding in macOS symbols", async () => {
    installBridge(snapshotWith());
    render(<DesktopSettingsPanel />);
    const value = await screen.findByTestId("desktop-shortcut-value-toggle-timer");
    expect(value.textContent).toBe("⌥⇧⌘Space");
    expect(value.dataset.registered).toBe("true");
    expect(screen.getByTestId("desktop-shortcut-value-new-timer").textContent).toBe("Not set");
  });

  it("records a chord with the shortcuts suspended, then saves it", async () => {
    const bridge = installBridge(snapshotWith(), "win32");
    render(<DesktopSettingsPanel />);
    fireEvent.click(await screen.findByTestId("desktop-shortcut-record-new-timer"));
    expect(bridge.calls.suspended).toEqual([true]);
    // Modifiers alone keep listening; a bare letter is refused on screen.
    fireEvent.keyDown(window, { code: "ControlLeft", ctrlKey: true });
    fireEvent.keyDown(window, { code: "KeyN" });
    expect(screen.getByTestId("desktop-shortcut-recording-new-timer").textContent).toContain("N cannot be used");
    await act(async () => {
      fireEvent.keyDown(window, { code: "KeyN", ctrlKey: true, altKey: true });
    });
    expect(bridge.calls.patches).toEqual([{ shortcuts: { "new-timer": "Control+Alt+N" } }]);
    expect(bridge.calls.suspended).toEqual([true, false]);
    expect(screen.getByTestId("desktop-shortcut-value-new-timer").textContent).toBe("Ctrl+Alt+N");
  });

  it("Escape cancels without saving", async () => {
    const bridge = installBridge(snapshotWith());
    render(<DesktopSettingsPanel />);
    fireEvent.click(await screen.findByTestId("desktop-shortcut-record-toggle-timer"));
    fireEvent.keyDown(window, { code: "Escape" });
    expect(bridge.calls.patches).toEqual([]);
    expect(bridge.calls.suspended).toEqual([true, false]);
  });

  it("surfaces a chord another app holds, and a refused duplicate", async () => {
    const bridge = installBridge(snapshotWith(), "linux");
    bridge.take("Control+Alt+K");
    render(<DesktopSettingsPanel />);
    fireEvent.click(await screen.findByTestId("desktop-shortcut-record-open-palette"));
    await act(async () => {
      fireEvent.keyDown(window, { code: "KeyK", ctrlKey: true, altKey: true });
    });
    const taken = screen.getByTestId("desktop-shortcut-problem-open-palette");
    expect(taken.dataset.problem).toBe("taken");
    expect(taken.textContent).toContain("Another app or the system already uses Ctrl+Alt+K");

    bridge.refuseNext({
      action: "new-timer",
      accelerator: "CommandOrControl+Alt+Shift+Space",
      registered: false,
      problem: "duplicate",
      conflictsWith: "toggle-timer",
    });
    fireEvent.click(screen.getByTestId("desktop-shortcut-record-new-timer"));
    await act(async () => {
      fireEvent.keyDown(window, { code: "Space", ctrlKey: true, altKey: true, shiftKey: true });
    });
    expect(screen.getByTestId("desktop-shortcut-problem-new-timer").textContent).toContain(
      "is already set for “Start or stop the timer”",
    );
  });

  it("clears a binding and offers the default back", async () => {
    const bridge = installBridge(snapshotWith());
    render(<DesktopSettingsPanel />);
    const clear = await screen.findByTestId("desktop-shortcut-clear-toggle-timer");
    await act(async () => {
      fireEvent.click(clear);
    });
    expect(bridge.calls.patches).toEqual([{ shortcuts: { "toggle-timer": null } }]);
    await act(async () => {
      fireEvent.click(screen.getByTestId("desktop-shortcut-reset-toggle-timer"));
    });
    expect(bridge.calls.patches.at(-1)).toEqual({ shortcuts: { "toggle-timer": "CommandOrControl+Alt+Shift+Space" } });
  });
});
