// @vitest-environment jsdom
/**
 * The bar adopts the running entry's fields when the timer changes — and only
 * then. A start shows its entry under a temp id until the server answers with
 * the real one; that rename is the same timer, so text typed into the bar in
 * between must survive it.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { TimeEntry } from "@starter/shared";

let running: TimeEntry | null = null;
vi.mock("@/hooks/use-sync", () => ({
  useRunningEntry: () => ({ entry: running, elapsedSec: 0, clockSkewed: false }),
}));

const mutations = {
  startTimer: vi.fn(),
  stopTimer: vi.fn(),
  updateEntry: vi.fn(),
};
vi.mock("@/components/tracker/use-entry-mutations", () => ({
  useEntryMutations: () => mutations,
}));
vi.mock("@/components/tracker/use-runaway-guard", () => ({ useRunawayGuard: () => undefined }));
vi.mock("@/components/tracker/use-idle-guard", () => ({ useIdleGuard: () => undefined }));
vi.mock("@/components/tracker/use-description-suggestions", () => ({
  useDescriptionSuggestions: (text: string) => ({ rows: [], rowsFor: text.trim() }),
}));
vi.mock("@/providers/offline-queue-provider", () => ({
  useOfflineQueueState: () => ({ pending: 0, foreign: 0, held: 0, online: true, authBlocked: false }),
}));
vi.mock("@/components/workspace-switcher", () => ({
  useActiveWorkspace: () => ({ activeId: "ws", workspaces: [] }),
}));
vi.mock("@/lib/trpc", () => ({
  trpc: { projects: { list: { useQuery: () => ({ data: [], isSuccess: true }) } } },
}));
vi.mock("@/lib/format", () => ({
  useFormatSettings: () => ({ locale: "en", timeFormat: "24h", currency: "EUR", duration: () => "0:00:00" }),
}));
vi.mock("@/i18n/use-t", () => ({ useT: () => (key: string) => key }));
vi.mock("@/lib/shell", () => ({ isCapacitor: () => false }));

// Children with data or portals of their own; the bar's state is what is
// under test, so each renders only what the assertions read.
vi.mock("@/components/entry-fields/project-task-picker", () => ({
  ProjectTaskPicker: ({ value }: { value: { projectId: string | null } }) => (
    <output data-testid="tracker-project">{value.projectId ?? ""}</output>
  ),
}));
vi.mock("@/components/tags/tag-picker", () => ({
  TagPicker: ({ value }: { value: string[] }) => (
    <output data-testid="tracker-tags">{value.join(",")}</output>
  ),
}));
vi.mock("@/components/tracker/quick-start-menu", () => ({ QuickStartMenu: () => null }));
vi.mock("@/components/tracker/manual-entry-dialog", () => ({ ManualEntryDialog: () => null }));
vi.mock("@/components/tracker/time-field", () => ({ TimeField: () => null }));
vi.mock("@/components/activity/autopilot-strip", () => ({ AutopilotStrip: () => null }));

const { TrackerBar } = await import("@/components/tracker/tracker-bar");
const { noteResolvedTempId, __resetResolvedTempIdsForTests } = await import(
  "@/lib/resolved-temp-ids"
);

const entry = (over: Partial<TimeEntry>): TimeEntry =>
  ({
    workspaceId: "ws",
    authorId: "u1",
    description: "Started",
    clientId: null,
    projectId: "p1",
    taskId: null,
    billable: false,
    start: "2026-10-19T09:00:00.000Z",
    end: null,
    durationSec: 0,
    hourlyRate: null,
    currency: "EUR",
    tagIds: ["t1"],
    ...over,
  }) as TimeEntry;

const description = (): HTMLInputElement =>
  screen.getByTestId("tracker-description") as HTMLInputElement;

// jsdom has none; the bar only publishes its height with it.
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe(): void {}
    disconnect(): void {}
  }
);

beforeEach(() => {
  running = null;
  __resetResolvedTempIdsForTests();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("TrackerBar", () => {
  it("keeps text typed after Start when the server names the temp entry", () => {
    const { rerender } = render(<TrackerBar />);

    running = entry({ id: "temp-a" });
    rerender(<TrackerBar />);
    expect(description().value).toBe("Started");

    fireEvent.change(description(), { target: { value: "Started, then typed" } });

    // What the start's onSuccess does: record the rename, then hand the
    // running entry back under its server id with the same fields.
    noteResolvedTempId("temp-a", "e-a");
    running = entry({ id: "e-a" });
    rerender(<TrackerBar />);

    expect(description().value).toBe("Started, then typed");
    expect(screen.getByTestId("tracker-bar").getAttribute("data-running-id")).toBe("e-a");
  });

  it("adopts the fields of a different timer that replaces a temp one", () => {
    const { rerender } = render(<TrackerBar />);
    running = entry({ id: "temp-b" });
    rerender(<TrackerBar />);
    fireEvent.change(description(), { target: { value: "Typed for mine" } });

    // Another device's timer, not the server's answer to this start.
    running = entry({ id: "e-other", description: "From the phone", projectId: "p2", tagIds: [] });
    rerender(<TrackerBar />);

    expect(description().value).toBe("From the phone");
    expect(screen.getByTestId("tracker-project").textContent).toBe("p2");
    expect(screen.getByTestId("tracker-tags").textContent).toBe("");
  });

  it("clears the bar when the timer stops", () => {
    running = entry({ id: "e-c" });
    const { rerender } = render(<TrackerBar />);
    fireEvent.change(description(), { target: { value: "Edited" } });

    running = null;
    rerender(<TrackerBar />);

    expect(description().value).toBe("");
    expect(screen.getByTestId("tracker-project").textContent).toBe("");
  });
});
