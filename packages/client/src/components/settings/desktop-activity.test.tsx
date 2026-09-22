// @vitest-environment jsdom
/**
 * Settings → Desktop → Activity capture: off by default, every switch goes to
 * main through `updateSettings`, each unavailable reason says why in one
 * sentence, macOS offers no titles, and "Delete all" asks first.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import type {
  DesktopActivitySettings,
  DesktopActivitySnapshot,
  DesktopActivityUnavailableReason,
} from "@starter/shared";

let shell: "web" | "electron" = "electron";
vi.mock("@/lib/shell", async () => (await import("@/lib/shell-mock")).mockShellModule(() => shell));

const { DesktopActivityCard, captureSwitchable } = await import("./desktop-activity");

const baseSnapshot = (over: Partial<DesktopActivitySnapshot> = {}): DesktopActivitySnapshot => ({
  settings: { enabled: false, storeTitles: false, excludedApps: [], retentionDays: 14 },
  support: { supported: true },
  titlesAvailable: true,
  scoped: true,
  recording: false,
  paused: null,
  storedSegments: 0,
  recentApps: [],
  rules: [],
  ...over,
});

type Listener = (snapshot: DesktopActivitySnapshot) => void;

function installBridge(initial: DesktopActivitySnapshot, platform = "win32") {
  let current = initial;
  let listener: Listener | null = null;
  const patches: Partial<DesktopActivitySettings>[] = [];
  const wipe = vi.fn(async () => {
    current = { ...current, storedSegments: 0 };
    return current;
  });
  (window as { electronAPI?: unknown }).electronAPI = {
    isDesktop: true,
    platform,
    activity: {
      snapshot: async () => current,
      onChanged: (next: Listener) => {
        listener = next;
        return () => {
          listener = null;
        };
      },
      updateSettings: async (patch: Partial<DesktopActivitySettings>) => {
        patches.push(patch);
        current = { ...current, settings: { ...current.settings, ...patch } };
        return current;
      },
      wipe,
    },
  };
  return {
    patches,
    wipe,
    push: (next: DesktopActivitySnapshot) => {
      current = next;
      act(() => listener?.(next));
    },
  };
}

const renderCard = async (): Promise<void> => {
  render(<DesktopActivityCard />);
  await screen.findByTestId("settings-desktop-activity");
};

beforeEach(() => {
  shell = "electron";
});
afterEach(() => {
  cleanup();
  delete (window as { electronAPI?: unknown }).electronAPI;
});

describe("DesktopActivityCard", () => {
  it("renders nothing on the web, or before hydration", () => {
    installBridge(baseSnapshot());
    expect(renderToString(<DesktopActivityCard />)).toBe("");
    shell = "web";
    render(<DesktopActivityCard />);
    expect(screen.queryByTestId("settings-desktop-activity")).toBeNull();
  });

  it("renders nothing when the preload has no activity bridge", async () => {
    (window as { electronAPI?: unknown }).electronAPI = { isDesktop: true, platform: "darwin" };
    render(<DesktopActivityCard />);
    await act(async () => undefined);
    expect(screen.queryByTestId("settings-desktop-activity")).toBeNull();
  });

  it("is off by default, and the switch writes to main", async () => {
    const bridge = installBridge(baseSnapshot());
    await renderCard();
    const toggle = screen.getByTestId("desktop-activity-enabled");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByTestId("desktop-activity-status").textContent).toBe("Off.");
    // Titles wait for capture itself.
    expect(screen.getByTestId("desktop-activity-titles").hasAttribute("disabled")).toBe(true);

    fireEvent.click(toggle);
    await waitFor(() => expect(bridge.patches).toEqual([{ enabled: true }]));
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));

    fireEvent.click(screen.getByTestId("desktop-activity-titles"));
    await waitFor(() => expect(bridge.patches.at(-1)).toEqual({ storeTitles: true }));
    expect(screen.getByText(/Turning this off deletes the titles already stored/)).toBeTruthy();
  });

  it("offers no window titles on macOS", async () => {
    installBridge(
      baseSnapshot({ titlesAvailable: false, settings: { enabled: true, storeTitles: false, excludedApps: [], retentionDays: 14 } }),
      "darwin",
    );
    await renderCard();
    expect(screen.getByTestId("desktop-activity-titles").hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Window titles are not recorded on macOS yet.")).toBeTruthy();
  });

  it.each<[DesktopActivityUnavailableReason, RegExp, boolean]>([
    ["store", /not available in copies from an app store/, false],
    ["linux-sandbox", /Snap and Flatpak copies cannot see other apps/, false],
    ["wayland", /Wayland does not tell apps/, false],
    ["unsupported-platform", /does not work on this system/, false],
    ["newer-format", /A newer version of Track Your Time/, false],
    ["tool-missing", /Install the x11-utils package/, true],
    ["blocked-by-policy", /A Windows policy on this computer/, true],
    ["source-failed", /stopped answering/, true],
  ])("explains %s, and the switch is usable only for a runtime reason", async (reason, text, switchable) => {
    const snapshot = baseSnapshot({
      support: { supported: false, reason, hint: reason === "tool-missing" ? "x11-utils" : null },
    });
    installBridge(snapshot, "linux");
    await renderCard();
    const status = screen.getByTestId("desktop-activity-status");
    expect(status.textContent).toMatch(text);
    expect(status.getAttribute("data-reason")).toBe(reason);
    expect(screen.getByTestId("desktop-activity-enabled").hasAttribute("disabled")).toBe(!switchable);
    expect(captureSwitchable(snapshot)).toBe(switchable);
  });

  it("follows main's pushes into the status line", async () => {
    const bridge = installBridge(baseSnapshot({ settings: { enabled: true, storeTitles: false, excludedApps: [], retentionDays: 14 }, recording: true }));
    await renderCard();
    const status = screen.getByTestId("desktop-activity-status");
    expect(status.textContent).toBe("Recording.");
    bridge.push(baseSnapshot({ settings: { enabled: true, storeTitles: false, excludedApps: [], retentionDays: 14 }, paused: "idle" }));
    expect(status.textContent).toBe("Paused: no input for a while.");
    bridge.push(baseSnapshot({ settings: { enabled: true, storeTitles: false, excludedApps: [], retentionDays: 14 }, paused: "locked" }));
    expect(status.textContent).toBe("Paused while the screen is locked.");
    bridge.push(baseSnapshot({ settings: { enabled: true, storeTitles: false, excludedApps: [], retentionDays: 14 }, scoped: false }));
    expect(status.textContent).toBe("Starts once your account and workspace have loaded.");
  });

  it("adds a never-record app from the recent list or by pattern, and removes it", async () => {
    const bridge = installBridge(
      baseSnapshot({
        recentApps: [
          { key: "com.example.chat", name: "Chat" },
          { key: "com.example.editor", name: "Editor" },
        ],
      }),
    );
    await renderCard();
    expect(screen.getByText(/Adding one removes what is already recorded for it/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Never record Chat" }));
    await waitFor(() => expect(bridge.patches).toEqual([{ excludedApps: ["com.example.chat"] }]));
    // Listed by name, and no longer offered as a recent app.
    await waitFor(() => expect(screen.getByTestId("desktop-activity-excluded-app").textContent).toContain("Chat"));
    expect(screen.queryByRole("button", { name: "Never record Chat" })).toBeNull();

    const input = screen.getByTestId("desktop-activity-exclude-input");
    fireEvent.change(input, { target: { value: "com.jetbrains.*" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(bridge.patches.at(-1)).toEqual({ excludedApps: ["com.example.chat", "com.jetbrains.*"] }),
    );
    await waitFor(() => expect((input as HTMLInputElement).value).toBe(""));

    fireEvent.click(screen.getByRole("button", { name: "Record Chat again" }));
    await waitFor(() => expect(bridge.patches.at(-1)).toEqual({ excludedApps: ["com.jetbrains.*"] }));
  });

  it("clamps and saves the retention", async () => {
    const bridge = installBridge(baseSnapshot());
    await renderCard();
    const field = screen.getByTestId("desktop-activity-retention");
    fireEvent.change(field, { target: { value: "365" } });
    fireEvent.blur(field);
    await waitFor(() => expect(bridge.patches).toEqual([{ retentionDays: 90 }]));
  });

  it("deletes everything only after the confirm", async () => {
    const bridge = installBridge(baseSnapshot({ storedSegments: 3 }));
    await renderCard();
    expect(screen.getByText(/3 stored stretches of activity/)).toBeTruthy();

    fireEvent.click(screen.getByTestId("desktop-activity-wipe"));
    expect(bridge.wipe).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByTestId("confirm-cancel"));
    expect(bridge.wipe).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("desktop-activity-wipe"));
    fireEvent.click(await screen.findByTestId("confirm-accept"));
    await waitFor(() => expect(bridge.wipe).toHaveBeenCalledTimes(1));
    await screen.findByTestId("desktop-activity-wiped");
    expect(screen.getByText(/No activity is stored for this account/)).toBeTruthy();
  });
});
