// @vitest-environment jsdom
import * as React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TIMER_MENU_LABELS } from "@starter/shared";
import type { DesktopTimerState } from "@starter/shared";
import { CompactTimer } from "./compact-timer";
import type { DesktopWindowView } from "./use-desktop-window";

vi.mock("@/hooks/use-sync", () => ({
  useRunningEntry: () => ({ entry: { workspaceId: "team" }, elapsedSec: 125 }),
}));
vi.mock("@/lib/format", () => ({
  useFormatSettings: () => ({ duration: (seconds: number) => `${seconds}s` }),
}));
vi.mock("@/components/workspace-switcher", () => ({
  useActiveWorkspace: () => ({
    activeId: "personal",
    workspaces: [{ id: "team", name: "Example team" }],
  }),
}));
afterEach(cleanup);

const state: DesktopTimerState = {
  signedIn: true,
  running: {
    description: "Review design",
    startedAt: "2026-10-23T01:00:00Z",
    projectName: "Website",
    projectColor: "#ff0000",
  },
  recents: [{ key: "review", label: "Review design", hint: "Website" }],
  unsent: 2,
  labels: {
    ...TIMER_MENU_LABELS,
    open: "Open app",
    compactTimer: "Compact timer",
    settings: "Settings",
    quit: "Quit",
    recentHeading: "Continue",
    noDescription: "(no description)",
    idleTooltip: "No timer",
    unsent: "2 changes not sent yet",
    quitUnsentTitle: "Unsent changes",
    quitUnsentBody: "Kept locally",
    quitUnsentButton: "Quit",
    runningBadge: "Timer running",
    restartToUpdate: "Restart",
    autopilotPause: "Pause",
    autopilotResume: "Resume",
    autopilotPaused: "",
  },
};
const view = (): DesktopWindowView => ({
  supported: true,
  compact: true,
  alwaysOnTop: false,
  failed: false,
  setMode: vi.fn(async () => true),
  setAlwaysOnTop: vi.fn(async () => true),
});

it("shows live work, its own workspace and unsent state, and sends the shared commands", () => {
  const command = vi.fn();
  render(
    <CompactTimer
      state={state}
      onCommand={command}
      view={view()}
      busy={false}
    />,
  );
  expect(screen.getByTestId("compact-description").textContent).toBe(
    "Review design",
  );
  expect(screen.getByTestId("compact-duration").textContent).toBe("125s");
  expect(screen.getByTestId("compact-workspace").textContent).toBe(
    "Example team",
  );
  expect(screen.getByTestId("compact-unsent").textContent).toBe(
    "2 changes not sent yet",
  );
  fireEvent.click(screen.getByTestId("compact-primary"));
  fireEvent.click(screen.getByTestId("compact-recent"));
  expect(command.mock.calls).toEqual([
    [{ kind: "stop" }],
    [{ kind: "continue", key: "review" }],
  ]);
});

it("starts new work through the full composer, and pinning is an explicit choice", () => {
  const command = vi.fn();
  const controls = view();
  render(
    <CompactTimer
      state={{ ...state, running: null, recents: [], unsent: 0 }}
      onCommand={command}
      view={controls}
      busy={false}
    />,
  );
  expect(screen.getByTestId("compact-duration").textContent).toBe("0s");
  expect(screen.queryByTestId("compact-unsent")).toBeNull();
  expect(controls.setAlwaysOnTop).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId("compact-primary"));
  expect(command).toHaveBeenCalledWith({ kind: "compose" });
  fireEvent.click(screen.getByTestId("compact-pin"));
  expect(controls.setAlwaysOnTop).toHaveBeenCalledWith(true);
  fireEvent.click(screen.getByTestId("compact-expand"));
  expect(controls.setMode).toHaveBeenCalledWith("full");
});

it("blocks duplicate writes while busy and reports a failed window change inline", () => {
  const command = vi.fn();
  render(
    <CompactTimer
      state={state}
      onCommand={command}
      view={{ ...view(), failed: true }}
      busy
    />,
  );
  fireEvent.click(screen.getByTestId("compact-primary"));
  fireEvent.click(screen.getByTestId("compact-recent"));
  expect(command).not.toHaveBeenCalled();
  expect(screen.getByRole("alert").textContent).toContain("Try again");
});
