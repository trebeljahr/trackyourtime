// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DetailedEntry } from "@starter/shared";

// Same reason as time-grid.test.tsx: display preferences come through tRPC.
vi.mock("@/lib/format", () => ({
  useFormatSettings: () => ({
    timeFormat: "24h" as const,
    durationFormat: "hm" as const,
    weekStartsOn: 1 as const,
    locale: "en",
    duration: (seconds: number) => `${Math.round(seconds / 60)}m`,
    durationShort: (seconds: number) => `${Math.round(seconds / 60)}m`,
    clock: (iso: string) => {
      const date = new Date(iso);
      return `${String(date.getHours()).padStart(2, "0")}:${String(
        date.getMinutes()
      ).padStart(2, "0")}`;
    },
    entryDuration: (entry: DetailedEntry) => entry.durationSec,
  }),
  formatDayLabel: () => "Tue 3 Feb",
}));

// The catalog pickers are tRPC-backed; this file is about the draft's times.
vi.mock("@/components/entry-fields/entry-fields-editor", () => ({
  EntryFieldsEditor: ({
    value,
    onChange,
  }: {
    value: { description: string };
    onChange: (next: { description: string }) => void;
  }) => (
    <input
      data-testid="calendar-create-description"
      value={value.description}
      onChange={(event) => {
        onChange({ ...value, description: event.target.value });
      }}
    />
  ),
}));

import { DEFAULT_VISIBLE_RANGE } from "./calendar-math";
import { TimeGrid } from "./time-grid";
import type { CalendarActions } from "./use-calendar-entries";

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

const actions = {
  update: vi.fn(),
  remove: vi.fn(),
  create: vi.fn(),
} as unknown as CalendarActions;

/** One px per minute from 06:00: `clientY` 40 is 06:40. */
const renderGrid = () =>
  render(
    <TimeGrid
      days={[DAY]}
      entries={[]}
      isLoading={false}
      actions={actions}
      preferredRange={DEFAULT_VISIBLE_RANGE}
      pxPerMinute={1}
    />
  );

const column = (): HTMLElement =>
  screen.getByTestId(`calendar-day-column-${DAY_KEY}`);

const press = (target: HTMLElement, clientY: number): void => {
  fireEvent.pointerDown(target, {
    pointerId: 1,
    pointerType: "mouse",
    button: 0,
    clientY,
  });
};
const release = (clientY: number): void => {
  fireEvent.pointerUp(column(), { pointerId: 1, pointerType: "mouse", clientY });
};
const move = (clientY: number): void => {
  fireEvent.pointerMove(column(), { pointerId: 1, pointerType: "mouse", clientY });
};

const clickGrid = (clientY: number): void => {
  press(column(), clientY);
  release(clientY);
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("TimeGrid create", () => {
  it("puts an hour-long draft down from a click, on the slot clicked", () => {
    renderGrid();

    clickGrid(40); // 06:40 → the 06:30 slot

    const draft = screen.getByTestId("calendar-create-draft");
    expect(draft).toHaveTextContent("06:30 – 07:30");
    expect(draft.style.top).toBe("30px");
    expect(draft.style.height).toBe("60px");
    expect(screen.getByTestId("calendar-create-popover")).toBeInTheDocument();
    expect(screen.getByTestId("calendar-create-start")).toHaveValue("06:30");
    expect(screen.getByTestId("calendar-create-end")).toHaveValue("07:30");
    expect(actions.create).not.toHaveBeenCalled();
  });

  it("puts a draft down over exactly what a drag covered", () => {
    renderGrid();

    press(column(), 40);
    move(160);
    release(160);

    expect(screen.getByTestId("calendar-create-draft")).toHaveTextContent(
      "06:40 – 08:40"
    );
    expect(screen.getByTestId("calendar-create-start")).toHaveValue("06:40");
    expect(screen.getByTestId("calendar-create-end")).toHaveValue("08:40");
  });

  it("resizes the draft by its bottom edge and mirrors it in the fields", () => {
    renderGrid();
    clickGrid(40);

    press(screen.getByTestId("calendar-create-draft-resize-end"), 90);
    move(120);
    release(120);

    expect(screen.getByTestId("calendar-create-draft")).toHaveTextContent(
      "06:30 – 08:00"
    );
    expect(screen.getByTestId("calendar-create-end")).toHaveValue("08:00");
    expect(screen.getByTestId("calendar-create-popover")).toBeInTheDocument();
  });

  it("resizes the draft by its top edge", () => {
    renderGrid();
    clickGrid(40);

    press(screen.getByTestId("calendar-create-draft-resize-start"), 30);
    move(60);
    release(60);

    expect(screen.getByTestId("calendar-create-draft")).toHaveTextContent(
      "07:00 – 07:30"
    );
    expect(screen.getByTestId("calendar-create-start")).toHaveValue("07:00");
  });

  it("moves the draft by its body, keeping its length", () => {
    renderGrid();
    clickGrid(40);

    press(screen.getByTestId("calendar-create-draft"), 60);
    move(180);
    release(180);

    expect(screen.getByTestId("calendar-create-draft")).toHaveTextContent(
      "08:30 – 09:30"
    );
  });

  it("moves an edge when a time is typed", () => {
    renderGrid();
    clickGrid(40);

    const end = screen.getByTestId("calendar-create-end");
    fireEvent.change(end, { target: { value: "9:15" } });
    fireEvent.keyDown(end, { key: "Enter" });

    expect(screen.getByTestId("calendar-create-draft")).toHaveTextContent(
      "06:30 – 09:15"
    );
  });

  it("creates the entry only from the Create button, with the draft's span", () => {
    renderGrid();
    clickGrid(40);

    fireEvent.change(screen.getByTestId("calendar-create-description"), {
      target: { value: "Standup" },
    });
    fireEvent.click(screen.getByTestId("calendar-create-submit"));

    expect(actions.create).toHaveBeenCalledTimes(1);
    expect(actions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        description: "Standup",
        start: at(6, 30),
        end: at(7, 30),
      })
    );
    expect(screen.queryByTestId("calendar-create-draft")).not.toBeInTheDocument();
  });

  it("discards the draft on Cancel", () => {
    renderGrid();
    clickGrid(40);

    fireEvent.click(screen.getByTestId("calendar-create-cancel"));

    expect(screen.queryByTestId("calendar-create-draft")).not.toBeInTheDocument();
    expect(actions.create).not.toHaveBeenCalled();
  });

  it("closes the draft on a click elsewhere without starting another", () => {
    renderGrid();
    clickGrid(40);

    clickGrid(400);

    expect(screen.queryByTestId("calendar-create-draft")).not.toBeInTheDocument();
    expect(actions.create).not.toHaveBeenCalled();

    // The next click starts a fresh one.
    clickGrid(400);
    expect(screen.getByTestId("calendar-create-draft")).toHaveTextContent(
      "12:30 – 13:30"
    );
  });
});
