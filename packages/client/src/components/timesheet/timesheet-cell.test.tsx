// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  formatDuration,
  type TimesheetCell,
} from "@starter/shared";

import { TimesheetCellField } from "./timesheet-cell";

const HOUR = 3600;

const cellEntry = (
  overrides: Partial<TimesheetCell["entries"][number]> = {}
): TimesheetCell["entries"][number] => ({
  id: "e1",
  start: "2026-02-03T09:00:00.000Z",
  end: "2026-02-03T10:00:00.000Z",
  secondsInCell: HOUR,
  containedInDay: true,
  running: false,
  ...overrides,
});

const cell = (entries: TimesheetCell["entries"] = []): TimesheetCell => ({
  day: "2026-02-03",
  seconds: entries.reduce((total, entry) => total + entry.secondsInCell, 0),
  entries,
});

const renderCell = (
  target: TimesheetCell,
  onCommit = vi.fn(),
  onNavigate = vi.fn()
) => {
  render(
    <TimesheetCellField
      cell={target}
      label="Acme, Tue 3 Feb"
      durationFormat="hms"
      duration={(seconds) => formatDuration(seconds, "hms")}
      clock={(iso) => iso.slice(11, 16)}
      detailHref="/reports?view=entries"
      onCommit={onCommit}
      onNavigate={onNavigate}
      testId="cell"
    />
  );
  return { onCommit, onNavigate, field: screen.getByTestId("cell") };
};

afterEach(cleanup);

describe("TimesheetCellField", () => {
  it("renders an empty cell as blank, not as zero", () => {
    const { field } = renderCell(cell());
    expect(field).toHaveValue("");
    expect(field).toHaveAttribute("data-cell-state", "empty");
  });

  it("reads a bare number as hours and commits on Enter", () => {
    const { onCommit, onNavigate, field } = renderCell(cell());

    fireEvent.change(field, { target: { value: "1.5" } });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(onCommit).toHaveBeenCalledWith(90 * 60);
    // Enter commits AND moves on, so a column can be filled without the mouse.
    expect(onNavigate).toHaveBeenCalledWith("Enter");
  });

  it("commits on blur so a value is never lost by clicking away", () => {
    const { onCommit, field } = renderCell(cell());

    fireEvent.change(field, { target: { value: "2:30" } });
    fireEvent.blur(field);

    expect(onCommit).toHaveBeenCalledWith(2.5 * HOUR);
  });

  it("reverts the cell on Escape without committing", () => {
    const { onCommit, field } = renderCell(cell([cellEntry()]));

    expect(field).toHaveValue("1:00:00");
    fireEvent.change(field, { target: { value: "5" } });
    fireEvent.keyDown(field, { key: "Escape" });

    expect(field).toHaveValue("1:00:00");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("refuses an unparseable value and restores what was there", () => {
    const { onCommit, onNavigate, field } = renderCell(cell([cellEntry()]));

    fireEvent.change(field, { target: { value: "lunch" } });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(onCommit).not.toHaveBeenCalled();
    // A rejected value must not navigate away from the cell it belongs to.
    expect(onNavigate).not.toHaveBeenCalled();
    expect(field).toHaveValue("1:00:00");
    expect(field).toHaveAttribute("aria-invalid", "true");
  });

  it("refuses more hours than a day holds", () => {
    const { onCommit, field } = renderCell(cell());

    fireEvent.change(field, { target: { value: "30" } });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(onCommit).not.toHaveBeenCalled();
  });

  it("does not fire a mutation when the value is unchanged", () => {
    const { onCommit, field } = renderCell(cell([cellEntry()]));

    fireEvent.change(field, { target: { value: "1" } });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(onCommit).not.toHaveBeenCalled();
  });

  it("commits once when a key moves focus out of the cell", () => {
    const { onCommit, field } = renderCell(cell());

    fireEvent.change(field, { target: { value: "1" } });
    fireEvent.keyDown(field, { key: "Enter" });
    // Moving focus blurs the cell. Committing again would send the same value
    // against a cell the cache has not caught up with — a duplicate entry.
    fireEvent.blur(field);

    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("still commits a value typed after the cell was moved away from", () => {
    const { onCommit, field } = renderCell(cell());

    fireEvent.change(field, { target: { value: "1" } });
    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.change(field, { target: { value: "2" } });
    fireEvent.blur(field);

    expect(onCommit).toHaveBeenNthCalledWith(1, HOUR);
    expect(onCommit).toHaveBeenNthCalledWith(2, 2 * HOUR);
  });

  it("moves rows on the vertical arrows", () => {
    const { onNavigate, field } = renderCell(cell());

    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(onNavigate).toHaveBeenCalledWith("ArrowDown");
  });

  it("leaves the caret alone mid-word and only then moves cells", () => {
    const { onNavigate, field } = renderCell(cell());

    fireEvent.change(field, { target: { value: "1:30" } });
    (field as HTMLInputElement).setSelectionRange(2, 2);
    fireEvent.keyDown(field, { key: "ArrowLeft" });
    expect(onNavigate).not.toHaveBeenCalled();

    (field as HTMLInputElement).setSelectionRange(0, 0);
    fireEvent.keyDown(field, { key: "ArrowLeft" });
    expect(onNavigate).toHaveBeenCalledWith("ArrowLeft");
  });

  it("shows a cell with several entries as read-only", () => {
    const { field } = renderCell(
      cell([cellEntry({ id: "a" }), cellEntry({ id: "b" })])
    );

    expect(field.tagName).toBe("BUTTON");
    expect(field).toHaveAttribute("data-cell-state", "multiple");
    expect(field).toHaveTextContent("2:00:00");
  });

  it("never lets the running timer's cell be typed into", () => {
    const { field } = renderCell(
      cell([cellEntry({ end: null, running: true })])
    );

    expect(field.tagName).toBe("BUTTON");
    expect(field).toHaveAttribute("data-cell-state", "running");
  });

  it("shows a midnight-crossing entry's cell as read-only", () => {
    const { field } = renderCell(cell([cellEntry({ containedInDay: false })]));

    expect(field).toHaveAttribute("data-cell-state", "split");
  });

  it("still traverses out of a read-only cell", () => {
    const { onNavigate, field } = renderCell(
      cell([cellEntry({ end: null, running: true })])
    );

    fireEvent.keyDown(field, { key: "ArrowRight" });
    expect(onNavigate).toHaveBeenCalledWith("ArrowRight");
  });
});
