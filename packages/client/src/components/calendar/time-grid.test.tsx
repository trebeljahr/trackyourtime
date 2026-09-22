// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DetailedEntry } from "@starter/shared";

// The grid only needs the workspace's display preferences, and pulling those
// through tRPC would drag the whole provider tree into a geometry test.
vi.mock("@/lib/format", () => ({
  useFormatSettings: () => ({
    timeFormat: "24h" as const,
    durationFormat: "hm" as const,
    weekStartsOn: 1 as const,
    duration: (seconds: number) => `${Math.round(seconds / 60)}m`,
    durationShort: (seconds: number) => `${Math.round(seconds / 60)}m`,
    clock: () => "09:00",
  }),
}));

import { DEFAULT_VISIBLE_RANGE } from "./calendar-math";
import { TimeGrid } from "./time-grid";
import type { CalendarActions } from "./use-calendar-entries";

const DAY = new Date(2026, 1, 3);

const at = (hour: number, minute: number): string =>
  new Date(2026, 1, 3, hour, minute, 0, 0).toISOString();

const entry = (
  id: string,
  start: string,
  end: string | null,
  overrides: Partial<DetailedEntry> = {}
): DetailedEntry =>
  ({
    id,
    workspaceId: "w1",
    authorId: "u1",
    description: `Entry ${id}`,
    projectId: null,
    taskId: null,
    billable: false,
    start,
    end,
    durationSec: 0,
    hourlyRate: null,
    currency: "EUR",
    source: "web",
    timeZone: null,
    runaway: null,
    tagIds: [],
    invoiceId: null,
    createdAt: start,
    updatedAt: start,
    projectName: null,
    projectColor: null,
    clientName: null,
    taskName: null,
    amount: 0,
    ...overrides,
  }) as DetailedEntry;

const actions = {
  update: vi.fn(),
  remove: vi.fn(),
  create: vi.fn(),
} as unknown as CalendarActions;

/** Six four-minute entries inside one twenty-minute window, plus a long one. */
const burst = [
  entry("a", at(9, 0), at(9, 4)),
  entry("b", at(9, 5), at(9, 9)),
  entry("c", at(9, 10), at(9, 14)),
  entry("d", at(9, 15), at(9, 19)),
  entry("e", at(9, 20), at(9, 24)),
  entry("f", at(9, 25), at(9, 29)),
  entry("long", at(14, 0), at(15, 30)),
];

const renderGrid = (pxPerMinute: number) =>
  render(
    <TimeGrid
      days={[DAY]}
      entries={burst}
      isLoading={false}
      actions={actions}
      preferredRange={DEFAULT_VISIBLE_RANGE}
      pxPerMinute={pxPerMinute}
    />
  );

afterEach(() => {
  cleanup();
});

describe("TimeGrid density clusters", () => {
  it("folds a burst of unreadable blocks into one chip", () => {
    renderGrid(1);

    const chip = screen.getByTestId("calendar-density-cluster");
    expect(chip).toHaveAttribute("data-cluster-size", "6");
    // The long entry is still drawn as itself.
    expect(screen.getByTestId("calendar-entry-long")).toBeInTheDocument();
    expect(screen.queryByTestId("calendar-entry-a")).not.toBeInTheDocument();
  });

  it("lists the hidden entries when the chip is opened", () => {
    renderGrid(1);

    fireEvent.click(screen.getByTestId("calendar-density-cluster"));

    expect(screen.getByTestId("calendar-cluster-popover")).toBeInTheDocument();
    expect(screen.getByText("6 short entries")).toBeInTheDocument();
    expect(screen.getByTestId("calendar-cluster-item-c")).toBeInTheDocument();
  });

  it("dissolves the chip once zoom makes the blocks readable", () => {
    renderGrid(4);

    expect(
      screen.queryByTestId("calendar-density-cluster")
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("calendar-entry-a")).toBeInTheDocument();
    expect(screen.getByTestId("calendar-entry-f")).toBeInTheDocument();
  });
});

describe("TimeGrid zoom", () => {
  it("scales block height and grid height with the zoom level", () => {
    const { unmount } = renderGrid(1);
    const atOne = screen.getByTestId("calendar-entry-long").style.height;
    unmount();

    renderGrid(2);
    const atTwo = screen.getByTestId("calendar-entry-long").style.height;

    expect(atOne).toBe("90px");
    expect(atTwo).toBe("180px");
  });

  it("thins the hour labels out when zoomed far out", () => {
    const { unmount } = renderGrid(1);
    const dense = screen.getAllByText(/^\d\d:00$/).length;
    unmount();

    renderGrid(0.35);
    const sparse = screen.getAllByText(/^\d\d:00$/).length;

    expect(sparse).toBeLessThan(dense);
  });

  it("subdivides the gutter into minutes of the hour when zoomed in", () => {
    const atOne = renderGrid(1);
    expect(screen.queryByText(":30")).not.toBeInTheDocument();
    atOne.unmount();

    // 90px per hour — half hours are marked, quarters are not yet.
    const atOneAndAHalf = renderGrid(1.5);
    expect(screen.getAllByText(":30").length).toBeGreaterThan(0);
    expect(screen.queryByText(":15")).not.toBeInTheDocument();
    atOneAndAHalf.unmount();

    // 360px per hour — every five minutes, the hour label still whole.
    renderGrid(6);
    expect(screen.getAllByText(":05").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/^\d\d:00$/).length).toBeGreaterThan(0);
  });
});
