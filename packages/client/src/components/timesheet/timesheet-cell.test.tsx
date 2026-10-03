// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  formatDuration,
  type TimesheetCell,
  type DetailedEntry,
} from "@starter/shared";

import { TimesheetCellField, type TimesheetCellFieldProps } from "./timesheet-cell";

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
  onNavigate = vi.fn(),
  extra: Partial<TimesheetCellFieldProps> = {},
) => {
  render(
    <TimesheetCellField
      cell={target}
      label="Acme, Tue 3 Feb"
      durationFormat="hms"
      duration={(seconds) => formatDuration(seconds, "hms")}
      clock={(iso) => iso.slice(11, 16)}
      detailHref="/app/reports?view=entries"
      onCommit={onCommit}
      onNavigate={onNavigate}
      testId="cell"
      {...extra}
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

  it("keeps a cell focusable during a save without allowing another write", () => {
    const { field, onCommit, onNavigate } = renderCell(cell(), vi.fn(), vi.fn(), {
      disabled: true,
    });
    field.focus();
    expect(field).toHaveFocus();
    expect(field).toHaveAttribute("readonly");
    expect(field).toHaveAttribute("aria-disabled", "true");
    fireEvent.change(field, { target: { value: "2" } });
    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.blur(field);
    expect(onNavigate).toHaveBeenCalledWith("ArrowDown");
    expect(onCommit).not.toHaveBeenCalled();
    expect(field).toHaveValue("");
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

  it("keeps a multi-block aggregate read-only", () => {
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
  it("opens the multi-block popover by keyboard without navigating down", async () => {
    const { field, onNavigate } = renderCell(cell([cellEntry({ id: "a" }), cellEntry({ id: "b" })]));
    field.focus();
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onNavigate).not.toHaveBeenCalled();
    // jsdom does not synthesize the native button click after Enter.
    fireEvent.click(field);
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Acme, Tue 3 Feb");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(field).toHaveFocus();
  });

  it("lists the actual descriptions and edits only the chosen entry", () => {
    const onEdit = vi.fn();
    const onAdd = vi.fn();
    const details = new Map(["a", "b"].map((id) => [id, { id, description: `Work ${id}` } as DetailedEntry]));
    const { field, onCommit } = renderCell(cell([cellEntry({ id: "a" }), cellEntry({ id: "b" })]), vi.fn(), vi.fn(), {
      blocks: { entry: (id) => details.get(id), protection: () => null, onEdit, onAdd },
    });
    fireEvent.click(field);
    expect(screen.getByText("Work a")).toBeInTheDocument();
    expect(screen.getByText("Work b")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("cell-edit-b"));
    expect(onEdit).toHaveBeenCalledExactlyOnceWith("b", "cell");
    expect(onAdd).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("protects an invoiced block while allowing edits to its sibling and adding time", () => {
    const onEdit = vi.fn();
    const onAdd = vi.fn();
    const { field } = renderCell(cell([cellEntry({ id: "a" }), cellEntry({ id: "b" })]), vi.fn(), vi.fn(), {
      blocks: { entry: () => undefined, protection: (id) => id === "a" ? "Invoiced" : null, onEdit, onAdd },
    });
    fireEvent.click(field);
    expect(screen.getByTestId("cell-edit-a")).toBeDisabled();
    expect(screen.getByTestId("cell-edit-a")).toHaveAccessibleDescription("Invoiced");
    expect(screen.getByTestId("cell-edit-b")).toBeEnabled();
    fireEvent.click(screen.getByTestId("cell-add-block"));
    expect(onAdd).toHaveBeenCalledExactlyOnceWith("cell");
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("shows the full midnight span and explains the clipped day contribution", () => {
    const { field } = renderCell(cell([cellEntry({ containedInDay: false, start: "2026-02-02T23:00:00.000Z" })]), vi.fn(), vi.fn(), {
      blocks: { entry: () => undefined, protection: () => null, onEdit: vi.fn(), onAdd: vi.fn() },
    });
    fireEvent.click(field);
    expect(screen.getByText(/contribution to this day/)).toBeInTheDocument();
    expect(screen.getByTestId("cell-edit-e1")).toBeEnabled();
  });

  it("offers an empty-state add action without writing an aggregate", () => {
    const onAdd = vi.fn();
    const { onCommit } = renderCell(cell(), vi.fn(), vi.fn(), {
      blocks: { entry: () => undefined, protection: () => null, onEdit: vi.fn(), onAdd },
    });
    fireEvent.click(screen.getByTestId("cell-blocks"));
    expect(screen.getByText("No blocks on this day. Add a block to log time.")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("cell-add-block"));
    expect(onAdd).toHaveBeenCalledOnce();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("allows inspecting a locked cell while disabling all writes", () => {
    const { field } = renderCell(cell([cellEntry()]), vi.fn(), vi.fn(), {
      readOnlyReason: "Approved period", disabled: true,
      blocks: { entry: () => undefined, protection: () => null, onEdit: vi.fn(), onAdd: vi.fn() },
    });
    fireEvent.click(field);
    expect(screen.getByText("Approved period")).toBeInTheDocument();
    expect(screen.getByTestId("cell-edit-e1")).toBeDisabled();
    expect(screen.getByTestId("cell-add-block")).toBeDisabled();
  });

  it("announces pending writes and disables the popover actions", () => {
    const { field } = renderCell(cell([cellEntry({ id: "a" }), cellEntry({ id: "b" })]), vi.fn(), vi.fn(), {
      blocks: { entry: () => undefined, protection: () => null, onEdit: vi.fn(), onAdd: vi.fn(), disabled: true },
    });
    fireEvent.click(field);
    expect(screen.getByRole("status")).toHaveTextContent("Saving");
    expect(screen.getByTestId("cell-edit-a")).toBeDisabled();
    expect(screen.getByTestId("cell-add-block")).toBeDisabled();
  });

});
