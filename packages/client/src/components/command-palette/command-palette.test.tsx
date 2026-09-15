// @vitest-environment jsdom
import * as React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Timer } from "lucide-react";

const mutations = {
  startTimer: vi.fn(),
  startQuickStart: vi.fn(),
  stopTimer: vi.fn(),
  removeEntry: vi.fn(),
};
const push = vi.fn();
let runningEntry: { id: string; description: string } | null = null;

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/components/tracker/use-entry-mutations", () => ({
  useEntryMutations: () => mutations,
}));
vi.mock("@/hooks/use-sync", () => ({
  useRunningEntry: () => ({ entry: runningEntry, elapsedSec: 90, clockSkewed: false }),
}));
vi.mock("@/hooks/use-favorites", () => ({
  useQuickStarts: () => ({ items: [] }),
}));
vi.mock("@/lib/entry-links", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/entry-links")>()),
  useAllTimeRange: () => ({ from: "2026-01-01", to: "2026-12-31" }),
}));
vi.mock("@/lib/format", () => ({
  useFormatSettings: () => ({ duration: (sec: number) => `${sec}s` }),
}));
vi.mock("@/lib/trpc", () => {
  const list = (data: unknown[]) => ({ useQuery: () => ({ data }) });
  return {
    trpc: {
      projects: {
        list: list([
          {
            id: "p1",
            name: "Website",
            color: "#ff0000",
            clientName: "Acme",
            billableDefault: true,
            archived: false,
          },
        ]),
      },
      clients: { list: list([{ id: "c1", name: "Acme", archived: false }]) },
      tasks: { list: list([]) },
      tags: { list: list([]) },
    },
  };
});

import {
  CommandPalette,
  isPaletteShortcut,
  useCommandPaletteShortcut,
} from "./command-palette";

const SECTIONS = [
  { heading: null, items: [{ href: "/app/track", id: "track" as const, icon: Timer }] },
];

function Harness(): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  useCommandPaletteShortcut(() => setOpen((current) => !current));
  return <CommandPalette open={open} onOpenChange={setOpen} sections={SECTIONS} />;
}

beforeAll(() => {
  // cmdk scrolls the selected row into view; jsdom has no layout.
  Element.prototype.scrollIntoView = vi.fn();
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
});

beforeEach(() => {
  runningEntry = null;
  vi.clearAllMocks();
});

afterEach(cleanup);

const pressShortcut = (init: KeyboardEventInit = { key: "k", metaKey: true }): void => {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { ...init, bubbles: true }));
  });
};

const groupIds = (): string[] =>
  screen
    .queryAllByTestId(/^command-palette-group-/)
    .map((node) => node.getAttribute("data-testid") ?? "");

describe("isPaletteShortcut", () => {
  it("is Cmd+K or Ctrl+K and nothing else", () => {
    const base = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
    expect(isPaletteShortcut({ ...base, key: "k", metaKey: true })).toBe(true);
    expect(isPaletteShortcut({ ...base, key: "K", ctrlKey: true })).toBe(true);
    expect(isPaletteShortcut({ ...base, key: "k" })).toBe(false);
    expect(isPaletteShortcut({ ...base, key: "k", metaKey: true, shiftKey: true })).toBe(false);
    expect(isPaletteShortcut({ ...base, key: "d", metaKey: true })).toBe(false);
  });
});

describe("CommandPalette", () => {
  it("opens with Cmd+K and closes with Escape", () => {
    render(<Harness />);
    expect(screen.queryByTestId("command-palette-input")).toBeNull();

    pressShortcut();
    const input = screen.getByTestId("command-palette-input");
    expect(input).toBeTruthy();
    expect(groupIds()).toEqual([
      "command-palette-group-timer",
      "command-palette-group-navigate",
    ]);

    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByTestId("command-palette-input")).toBeNull();
  });

  it("toggles closed with a second Cmd+K, and ignores a bare k", () => {
    render(<Harness />);
    pressShortcut({ key: "k" });
    expect(screen.queryByTestId("command-palette-input")).toBeNull();
    pressShortcut({ key: "k", ctrlKey: true });
    expect(screen.getByTestId("command-palette-input")).toBeTruthy();
    pressShortcut({ key: "k", ctrlKey: true });
    expect(screen.queryByTestId("command-palette-input")).toBeNull();
  });

  it("shows the catalog once typing, and Enter starts a timer on the project", () => {
    render(<Harness />);
    pressShortcut();
    const input = screen.getByTestId("command-palette-input");
    fireEvent.change(input, { target: { value: "Website" } });

    expect(groupIds()).toContain("command-palette-group-projects");
    expect(screen.getByTestId("command-palette-item-report-project-p1")).toBeTruthy();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(mutations.startTimer).toHaveBeenCalledWith({
      description: "",
      projectId: "p1",
      taskId: null,
      billable: true,
      tagIds: [],
    });
    expect(screen.queryByTestId("command-palette-input")).toBeNull();
  });

  it("stops the running timer through the tracker's mutation", () => {
    runningEntry = { id: "e1", description: "Writing" };
    render(<Harness />);
    pressShortcut();
    fireEvent.click(screen.getByTestId("command-palette-item-timer-stop"));
    expect(mutations.stopTimer).toHaveBeenCalled();
  });

  it("confirms before discarding the running timer", () => {
    runningEntry = { id: "e1", description: "Writing" };
    render(<Harness />);
    pressShortcut();
    fireEvent.click(screen.getByTestId("command-palette-item-timer-discard"));
    expect(mutations.removeEntry).not.toHaveBeenCalled();
    expect(groupIds()).toEqual(["command-palette-group-discard"]);

    fireEvent.click(screen.getByTestId("command-palette-item-discard-confirm"));
    expect(mutations.removeEntry).toHaveBeenCalledWith(
      expect.objectContaining({ id: "e1" }),
    );
  });

  it("navigates to a destination", () => {
    render(<Harness />);
    pressShortcut();
    fireEvent.click(screen.getByTestId("command-palette-item-nav-track"));
    expect(push).toHaveBeenCalledWith("/app/track");
  });
});
