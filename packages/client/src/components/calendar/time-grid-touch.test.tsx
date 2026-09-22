// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
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
import { LONG_PRESS_MS, TOUCH_CREATE_MINUTES, TimeGrid } from "./time-grid";
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

const onSwipe = vi.fn();
const onZoomBy = vi.fn();

const renderGrid = () =>
  render(
    <TimeGrid
      days={[DAY]}
      entries={[ENTRY]}
      isLoading={false}
      actions={actions}
      preferredRange={DEFAULT_VISIBLE_RANGE}
      pxPerMinute={1}
      onZoomBy={onZoomBy}
      onSwipe={onSwipe}
    />
  );

type Touch = { pointerId: number; clientX?: number; clientY: number };

const touchDown = (target: Element, touch: Touch): void => {
  fireEvent.pointerDown(target, {
    pointerType: "touch",
    button: 0,
    clientX: 0,
    ...touch,
  });
};
const touchMove = (target: Element, touch: Touch): void => {
  fireEvent.pointerMove(target, { pointerType: "touch", clientX: 0, ...touch });
};
const touchUp = (target: Element, touch: Touch): void => {
  fireEvent.pointerUp(target, { pointerType: "touch", clientX: 0, ...touch });
};

/** The finger rests long enough for the hold to fire. */
const hold = (): void => {
  act(() => {
    vi.advanceTimersByTime(LONG_PRESS_MS + 1);
  });
};

/** The draft's span in minutes: the grid renders at 1px per minute here. */
const draftMinutes = (): number =>
  parseFloat(screen.getByTestId("calendar-create-draft").style.height);
/** Where the draft starts, in minutes from the top of the visible range. */
const draftTop = (): number =>
  parseFloat(screen.getByTestId("calendar-create-draft").style.top);

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
  vi.useRealTimers();
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

describe("TimeGrid gutter", () => {
  it("leaves air above the first label and below the last", () => {
    renderGrid();

    // Each label is centred on its rule, so the first hangs half a line above
    // the grid. Without the pad the scroll box clips it — nothing scrolls to
    // a negative offset.
    const pad = screen.getByTestId("calendar-grid-pad");
    expect(parseFloat(pad.style.paddingTop)).toBeGreaterThan(0);
    expect(parseFloat(pad.style.paddingBottom)).toBeGreaterThan(0);
  });
});

describe("TimeGrid held under a finger", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    coarse = true;
  });

  it("proposes a draft where the finger rested, and stretches it from there", () => {
    renderGrid();
    const column = screen.getByTestId(`calendar-day-column-${DAY_KEY}`);

    touchDown(column, { pointerId: 1, clientY: 40 });
    expect(
      screen.queryByTestId("calendar-create-preview")
    ).not.toBeInTheDocument();

    hold();
    expect(screen.getByTestId("calendar-create-preview")).toBeInTheDocument();

    touchMove(column, { pointerId: 1, clientY: 160 });
    touchUp(column, { pointerId: 1, clientY: 160 });
    // The browser still fires a click for the release; a hold is not a tap.
    fireEvent.click(column, { clientY: 160 });

    expect(screen.getByTestId("calendar-create-draft")).toBeInTheDocument();
    expect(draftMinutes()).toBe(120);
  });

  it("proposes a real block, not the snap minimum, when the finger never moves", () => {
    renderGrid();
    const column = screen.getByTestId(`calendar-day-column-${DAY_KEY}`);

    touchDown(column, { pointerId: 1, clientY: 40 });
    hold();
    touchUp(column, { pointerId: 1, clientY: 40 });

    expect(screen.getByTestId("calendar-create-draft")).toBeInTheDocument();
    expect(draftMinutes()).toBe(TOUCH_CREATE_MINUTES);
  });

  it("is a pan, never a hold, once the finger has travelled before the timer", () => {
    renderGrid();
    const column = screen.getByTestId(`calendar-day-column-${DAY_KEY}`);

    touchDown(column, { pointerId: 1, clientY: 40 });
    touchMove(column, { pointerId: 1, clientY: 70 });
    hold();
    touchUp(column, { pointerId: 1, clientY: 70 });

    expect(
      screen.queryByTestId("calendar-create-draft")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("calendar-create-preview")
    ).not.toBeInTheDocument();
  });

  it("moves a held block with the finger, and the release is not a tap", () => {
    renderGrid();
    const block = screen.getByTestId("calendar-entry-e1");

    touchDown(block, { pointerId: 1, clientY: 40 });
    hold();
    touchMove(block, { pointerId: 1, clientY: 100 });
    touchUp(block, { pointerId: 1, clientY: 100 });
    fireEvent.click(block);

    expect(actions.update).toHaveBeenCalledTimes(1);
    expect(actions.update).toHaveBeenCalledWith(
      "e1",
      expect.objectContaining({
        start: expect.any(String),
        end: expect.any(String),
      })
    );
    expect(
      screen.queryByTestId("calendar-edit-popover")
    ).not.toBeInTheDocument();
  });

  it("resizes a block held by its edge", () => {
    renderGrid();
    const handle = screen.getByTestId("calendar-entry-resize-end-e1");

    touchDown(handle, { pointerId: 1, clientY: 40 });
    hold();
    touchMove(handle, { pointerId: 1, clientY: 100 });
    touchUp(handle, { pointerId: 1, clientY: 100 });

    expect(actions.update).toHaveBeenCalledTimes(1);
    const [, patch] = vi.mocked(actions.update).mock.calls[0]!;
    expect(patch).toHaveProperty("end");
    expect(patch).not.toHaveProperty("start");
  });

  it("moves the draft itself when held, like a saved block", () => {
    renderGrid();
    const column = screen.getByTestId(`calendar-day-column-${DAY_KEY}`);

    // A tap puts the draft down …
    touchDown(column, { pointerId: 1, clientY: 40 });
    touchUp(column, { pointerId: 1, clientY: 40 });
    fireEvent.click(column, { clientY: 40 });
    const draft = screen.getByTestId("calendar-create-draft");
    const before = draftTop();

    // … and a hold on it carries it down the grid.
    touchDown(draft, { pointerId: 2, clientY: 60 });
    hold();
    touchMove(draft, { pointerId: 2, clientY: 120 });
    touchUp(draft, { pointerId: 2, clientY: 120 });

    expect(draftTop() - before).toBe(60);
    expect(actions.create).not.toHaveBeenCalled();
  });

  it("gives the hold up the moment a second finger lands", () => {
    renderGrid();
    const column = screen.getByTestId(`calendar-day-column-${DAY_KEY}`);

    touchDown(column, { pointerId: 1, clientX: 100, clientY: 40 });
    touchDown(column, { pointerId: 2, clientX: 140, clientY: 40 });
    hold();
    touchUp(column, { pointerId: 2, clientX: 140, clientY: 40 });
    touchUp(column, { pointerId: 1, clientX: 100, clientY: 40 });

    expect(
      screen.queryByTestId("calendar-create-draft")
    ).not.toBeInTheDocument();
  });
});

describe("TimeGrid swiped and pinched", () => {
  beforeEach(() => {
    coarse = true;
  });

  it("steps to the next range on a swipe left, the previous on a swipe right", () => {
    renderGrid();
    const column = screen.getByTestId(`calendar-day-column-${DAY_KEY}`);

    touchDown(column, { pointerId: 1, clientX: 300, clientY: 40 });
    touchMove(column, { pointerId: 1, clientX: 200, clientY: 48 });
    touchUp(column, { pointerId: 1, clientX: 200, clientY: 48 });
    expect(onSwipe).toHaveBeenLastCalledWith(1);

    touchDown(column, { pointerId: 2, clientX: 100, clientY: 40 });
    touchMove(column, { pointerId: 2, clientX: 220, clientY: 40 });
    touchUp(column, { pointerId: 2, clientX: 220, clientY: 40 });
    expect(onSwipe).toHaveBeenLastCalledWith(-1);

    // A swipe never taps, so no draft goes down under it either.
    fireEvent.click(column, { clientY: 40 });
    expect(
      screen.queryByTestId("calendar-create-draft")
    ).not.toBeInTheDocument();
  });

  it("does not read a short or a mostly vertical travel as a swipe", () => {
    renderGrid();
    const column = screen.getByTestId(`calendar-day-column-${DAY_KEY}`);

    touchDown(column, { pointerId: 1, clientX: 300, clientY: 40 });
    touchUp(column, { pointerId: 1, clientX: 270, clientY: 40 });
    touchDown(column, { pointerId: 2, clientX: 300, clientY: 40 });
    touchUp(column, { pointerId: 2, clientX: 200, clientY: 140 });

    expect(onSwipe).not.toHaveBeenCalled();
  });

  it("does not open the editor for a swipe that started on a block", () => {
    renderGrid();
    const block = screen.getByTestId("calendar-entry-e1");

    touchDown(block, { pointerId: 1, clientX: 300, clientY: 40 });
    touchMove(block, { pointerId: 1, clientX: 200, clientY: 40 });
    touchUp(block, { pointerId: 1, clientX: 200, clientY: 40 });
    fireEvent.click(block);

    expect(onSwipe).toHaveBeenCalledWith(1);
    expect(
      screen.queryByTestId("calendar-edit-popover")
    ).not.toBeInTheDocument();
  });

  it("zooms in as two fingers spread and out as they close", () => {
    renderGrid();
    const column = screen.getByTestId(`calendar-day-column-${DAY_KEY}`);

    touchDown(column, { pointerId: 1, clientX: 100, clientY: 100 });
    touchDown(column, { pointerId: 2, clientX: 140, clientY: 100 });
    // A little drift is not a step.
    touchMove(column, { pointerId: 2, clientX: 145, clientY: 100 });
    expect(onZoomBy).not.toHaveBeenCalled();

    touchMove(column, { pointerId: 2, clientX: 200, clientY: 100 });
    expect(onZoomBy).toHaveBeenLastCalledWith(1);

    touchMove(column, { pointerId: 2, clientX: 120, clientY: 100 });
    expect(onZoomBy).toHaveBeenLastCalledWith(-1);

    touchUp(column, { pointerId: 2, clientX: 120, clientY: 100 });
    touchUp(column, { pointerId: 1, clientX: 100, clientY: 100 });
    expect(onSwipe).not.toHaveBeenCalled();
  });

  it("never ends a pinch in a swipe, whichever finger lifts first", () => {
    renderGrid();
    const column = screen.getByTestId(`calendar-day-column-${DAY_KEY}`);

    // The second finger's press bubbles to the column like any other, and
    // it travels far sideways as the fingers spread.
    touchDown(column, { pointerId: 1, clientX: 100, clientY: 100 });
    touchDown(column, { pointerId: 2, clientX: 130, clientY: 100 });
    touchMove(column, { pointerId: 1, clientX: 20, clientY: 100 });
    touchMove(column, { pointerId: 2, clientX: 220, clientY: 100 });
    touchUp(column, { pointerId: 2, clientX: 220, clientY: 100 });
    touchUp(column, { pointerId: 1, clientX: 20, clientY: 100 });
    fireEvent.click(column, { clientY: 100 });

    expect(onZoomBy).toHaveBeenCalled();
    expect(onSwipe).not.toHaveBeenCalled();
    expect(
      screen.queryByTestId("calendar-create-draft")
    ).not.toBeInTheDocument();
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
