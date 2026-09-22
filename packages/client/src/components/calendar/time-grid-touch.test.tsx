// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DetailedEntry } from "@starter/shared";

// Same reason as time-grid.test.tsx: the grid needs display preferences, and
// pulling those through tRPC would drag the whole provider tree in.
vi.mock("@/lib/format", () => ({
  useFormatSettings: () => ({
    timeFormat: "24h" as const,
    durationFormat: "hm" as const,
    weekStartsOn: 1 as const,
    duration: (seconds: number) => `${Math.round(seconds / 60)}m`,
    durationShort: (seconds: number) => `${Math.round(seconds / 60)}m`,
    clock: () => "09:00",
    entryDuration: (entry: DetailedEntry) => entry.durationSec,
  }),
  formatDayLabel: () => "Tue 3 Feb",
}));

// The inline editor pulls the catalog pickers in, and those are tRPC-backed.
// This file is about which pointer opens it, not what it contains.
vi.mock("@/components/entry-fields/entry-fields-editor", () => ({
  EntryFieldsEditor: () => null,
}));
vi.mock("@/components/entry-fields/use-entry-fields", () => ({
  useEntryFields: () => ({
    fields: {
      description: "",
      projectId: null,
      taskId: null,
      tagIds: [],
      billable: false,
    },
    setFields: () => {},
  }),
  useWriteThroughEntryFields: () => ({
    fields: {
      description: "",
      projectId: null,
      taskId: null,
      tagIds: [],
      billable: false,
    },
    set: () => {},
  }),
}));

import { DEFAULT_VISIBLE_RANGE } from "./calendar-math";
import { TimeGrid } from "./time-grid";
import type { CalendarActions } from "./use-calendar-entries";

/**
 * jsdom ships no `matchMedia` at all — which is exactly why every existing
 * calendar spec keeps exercising the mouse branch untouched. Install one whose
 * answer this file can flip, so both branches are covered here and nowhere
 * else has to change.
 */
let coarse = false;

const media = {
  get matches(): boolean {
    return coarse;
  },
  media: "(pointer: coarse)",
  onchange: null,
  addEventListener: (): void => {},
  removeEventListener: (): void => {},
  addListener: (): void => {},
  removeListener: (): void => {},
  dispatchEvent: (): boolean => false,
};

window.matchMedia = (() => media) as unknown as typeof window.matchMedia;

// jsdom implements none of the pointer-capture API the drag machine calls.
Element.prototype.setPointerCapture ??= function setPointerCapture(): void {};
Element.prototype.releasePointerCapture ??=
  function releasePointerCapture(): void {};
Element.prototype.hasPointerCapture ??= function hasPointerCapture(): boolean {
  return false;
};

const DAY = new Date(2026, 1, 3);
const DAY_KEY = "2026-02-03";

const at = (hour: number, minute: number): string =>
  new Date(2026, 1, 3, hour, minute, 0, 0).toISOString();

const ENTRY = {
  id: "e1",
  workspaceId: "w1",
  authorId: "u1",
  description: "Entry e1",
  projectId: null,
  taskId: null,
  billable: false,
  start: at(9, 0),
  end: at(10, 30),
  durationSec: 5400,
  hourlyRate: null,
  currency: "EUR",
  source: "web",
  timeZone: null,
  runaway: null,
  tagIds: [],
  invoiceId: null,
  createdAt: at(9, 0),
  updatedAt: at(9, 0),
  projectName: null,
  projectColor: null,
  clientName: null,
  taskName: null,
  amount: 0,
} as unknown as DetailedEntry;

const actions = {
  update: vi.fn(),
  remove: vi.fn(),
  create: vi.fn(),
} as unknown as CalendarActions;

const renderGrid = () =>
  render(
    <TimeGrid
      days={[DAY]}
      entries={[ENTRY]}
      isLoading={false}
      actions={actions}
      preferredRange={DEFAULT_VISIBLE_RANGE}
      pxPerMinute={1}
    />
  );

/** A press-drag-release well past DRAG_THRESHOLD_PX. */
const dragColumn = (pointerType: "touch" | "mouse"): void => {
  const column = screen.getByTestId(`calendar-day-column-${DAY_KEY}`);
  fireEvent.pointerDown(column, {
    pointerId: 1,
    pointerType,
    button: 0,
    clientY: 40,
  });
  fireEvent.pointerMove(column, { pointerId: 1, pointerType, clientY: 160 });
  fireEvent.pointerUp(column, { pointerId: 1, pointerType, clientY: 160 });
};

beforeEach(() => {
  coarse = false;
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("TimeGrid under a coarse pointer", () => {
  it("lets the browser pan the grid instead of swallowing the scroll", () => {
    coarse = true;
    renderGrid();

    expect(
      screen.getByTestId(`calendar-day-column-${DAY_KEY}`).style.touchAction
    ).toBe("pan-y");
    expect(screen.getByTestId("calendar-entry-e1").style.touchAction).toBe(
      "pan-y"
    );
    expect(
      screen.getByTestId("calendar-entry-resize-start-e1").style.touchAction
    ).toBe("pan-y");
    expect(
      screen.getByTestId("calendar-entry-resize-end-e1").style.touchAction
    ).toBe("pan-y");
  });

  it("never turns a finger drag across empty grid into a new entry", () => {
    coarse = true;
    renderGrid();

    dragColumn("touch");

    expect(screen.queryByTestId("calendar-create-draft")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("calendar-create-preview")
    ).not.toBeInTheDocument();
  });

  it("puts a draft down on a tap on empty grid, from the click after it", () => {
    coarse = true;
    renderGrid();

    const column = screen.getByTestId(`calendar-day-column-${DAY_KEY}`);
    fireEvent.pointerDown(column, {
      pointerId: 1,
      pointerType: "touch",
      button: 0,
      clientY: 40,
    });
    fireEvent.pointerUp(column, { pointerId: 1, pointerType: "touch", clientY: 40 });
    fireEvent.click(column, { clientY: 40 });

    expect(screen.getByTestId("calendar-create-draft")).toBeInTheDocument();
  });

  it("does not put a draft down when the finger panned instead", () => {
    coarse = true;
    renderGrid();

    const column = screen.getByTestId(`calendar-day-column-${DAY_KEY}`);
    fireEvent.pointerDown(column, {
      pointerId: 1,
      pointerType: "touch",
      button: 0,
      clientY: 40,
    });
    fireEvent.pointerCancel(column, { pointerId: 1, pointerType: "touch" });
    fireEvent.click(column, { clientY: 40 });

    expect(screen.queryByTestId("calendar-create-draft")).not.toBeInTheDocument();
  });

  it("never turns a finger drag on a block into a move or a resize", () => {
    coarse = true;
    renderGrid();

    const block = screen.getByTestId("calendar-entry-e1");
    fireEvent.pointerDown(block, {
      pointerId: 1,
      pointerType: "touch",
      button: 0,
      clientY: 40,
    });
    fireEvent.pointerMove(block, {
      pointerId: 1,
      pointerType: "touch",
      clientY: 200,
    });
    fireEvent.pointerUp(block, {
      pointerId: 1,
      pointerType: "touch",
      clientY: 200,
    });

    expect(actions.update).not.toHaveBeenCalled();
  });

  it("does not open the editor after a mouse drag that followed a tap", () => {
    coarse = true;
    renderGrid();

    const block = screen.getByTestId("calendar-entry-e1");
    // A finger pressed the block and then panned away — no click, so the tap
    // is left unresolved. The mouse drag that follows must not inherit it.
    fireEvent.pointerDown(block, {
      pointerId: 1,
      pointerType: "touch",
      button: 0,
      clientY: 40,
    });
    fireEvent.pointerDown(block, {
      pointerId: 2,
      pointerType: "mouse",
      button: 0,
      clientY: 40,
    });
    fireEvent.pointerMove(block, {
      pointerId: 2,
      pointerType: "mouse",
      clientY: 160,
    });
    fireEvent.pointerUp(block, {
      pointerId: 2,
      pointerType: "mouse",
      clientY: 160,
    });
    fireEvent.click(block);

    expect(actions.update).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByTestId("calendar-edit-popover")
    ).not.toBeInTheDocument();
  });

  it("opens the editor when the finger tapped rather than panned", () => {
    coarse = true;
    renderGrid();

    const block = screen.getByTestId("calendar-entry-e1");
    fireEvent.pointerDown(block, {
      pointerId: 1,
      pointerType: "touch",
      button: 0,
      clientY: 40,
    });
    // A pan fires no click at all, so the click IS the tap.
    fireEvent.click(block);

    expect(screen.getByTestId("calendar-edit-popover")).toBeInTheDocument();
    expect(actions.update).not.toHaveBeenCalled();
  });
});

describe("TimeGrid under a fine pointer", () => {
  it("keeps owning every gesture, so drag-to-create still works", () => {
    renderGrid();

    expect(
      screen.getByTestId(`calendar-day-column-${DAY_KEY}`).style.touchAction
    ).toBe("none");
    expect(screen.getByTestId("calendar-entry-e1").style.touchAction).toBe(
      "none"
    );

    dragColumn("mouse");

    expect(screen.getByTestId("calendar-create-draft")).toBeInTheDocument();
  });

  it("does not open the editor from a bare mouse click", () => {
    renderGrid();

    // The mouse resolves a click through the drag machine on pointer-up, so
    // the touch-only click path must stay dormant — this is the assertion
    // that the coarse branch cannot leak into the desktop one.
    fireEvent.click(screen.getByTestId("calendar-entry-e1"));

    expect(
      screen.queryByTestId("calendar-edit-popover")
    ).not.toBeInTheDocument();
  });
});
