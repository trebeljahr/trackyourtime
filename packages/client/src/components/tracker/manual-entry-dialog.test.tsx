// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ManualEntryArgs } from "./use-entry-mutations";

vi.mock("@/i18n/use-t", () => ({ useT: () => (key: string) => key }));
vi.mock("@/i18n/use-format", () => ({
  useFormat: () => ({
    time: (iso: string) => iso,
    duration: (seconds: number) => String(seconds),
  }),
}));
vi.mock("@/lib/format", () => ({
  useFormatSettings: () => ({ timeFormat: "24h", durationFormat: "hms" }),
}));
vi.mock("@starter/core", () => ({
  deviceTimeZone: () => "Europe/Berlin",
  defaultManualRange: () => ({
    start: "2026-03-28T22:30:00.000Z",
    end: "2026-03-28T23:30:00.000Z",
  }),
  entryFieldsFrom: () => ({
    description: "",
    projectId: null,
    taskId: null,
    billable: false,
    tagIds: [],
  }),
}));
vi.mock("@/components/entry-fields/entry-fields-editor", () => ({
  EntryFieldsEditor: () => null,
}));

import { ManualEntryDialog } from "./manual-entry-dialog";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const seed = {
  description: "",
  projectId: null,
  taskId: null,
  billable: false,
  tagIds: [],
};

const renderDialog = (range: { start: string; end: string }) => {
  const onAdd = vi.fn<(args: ManualEntryArgs) => void>();
  render(
    <ManualEntryDialog
      open
      onOpenChange={vi.fn()}
      seed={seed}
      mutations={{} as never}
      range={range}
      onAdd={onAdd}
    />
  );
  return onAdd;
};

const commitTime = (testId: string, value: string): void => {
  const input = screen.getByTestId(testId);
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: "Enter" });
};

const secondsBetween = (args: ManualEntryArgs): number =>
  (Date.parse(args.end) - Date.parse(args.start)) / 1000;

describe("ManualEntryDialog date and time editing", () => {
  it("rolls an earlier end time to the next local day when end is edited first", () => {
    const onAdd = renderDialog({
      start: "2026-10-01T21:30:00.000Z", // 23:30 Berlin
      end: "2026-10-01T21:30:00.000Z",
    });

    commitTime("manual-entry-end", "00:30");
    fireEvent.click(screen.getByTestId("manual-entry-add"));

    expect(onAdd).toHaveBeenCalledOnce();
    expect(secondsBetween(onAdd.mock.calls[0]![0])).toBe(3600);
    expect(onAdd.mock.calls[0]![0].end).toBe("2026-10-01T22:30:00.000Z");
  });

  it("rolls the end when moving the start later, then accepts the end time", () => {
    const onAdd = renderDialog({
      start: "2026-10-01T20:30:00.000Z", // 22:30 Berlin
      end: "2026-10-01T20:30:00.000Z",
    });

    commitTime("manual-entry-start", "23:30");
    commitTime("manual-entry-end", "00:30");
    fireEvent.click(screen.getByTestId("manual-entry-add"));

    expect(onAdd).toHaveBeenCalledOnce();
    expect(secondsBetween(onAdd.mock.calls[0]![0])).toBe(3600);
    expect(onAdd.mock.calls[0]![0].start).toBe("2026-10-01T21:30:00.000Z");
    expect(onAdd.mock.calls[0]![0].end).toBe("2026-10-01T22:30:00.000Z");
  });

  it("preserves elapsed duration when the start date moves across a DST change", () => {
    const onAdd = renderDialog({
      start: "2026-03-28T22:30:00.000Z", // 23:30 Berlin
      end: "2026-03-28T23:30:00.000Z", // 00:30 Berlin next day
    });

    fireEvent.change(screen.getByTestId("manual-entry-date"), {
      target: { value: "2026-03-29" },
    });
    fireEvent.click(screen.getByTestId("manual-entry-add"));

    expect(onAdd).toHaveBeenCalledOnce();
    const saved = onAdd.mock.calls[0]![0];
    expect(secondsBetween(saved)).toBe(3600);
    expect(saved.start).toBe("2026-03-29T21:30:00.000Z");
    expect(saved.end).toBe("2026-03-29T22:30:00.000Z");
  });

  it("allows an explicit multi-day end date", () => {
    const onAdd = renderDialog({
      start: "2026-10-01T21:30:00.000Z",
      end: "2026-10-01T22:30:00.000Z",
    });

    fireEvent.change(screen.getByTestId("manual-entry-end-date"), {
      target: { value: "2026-10-03" },
    });
    fireEvent.click(screen.getByTestId("manual-entry-add"));

    expect(onAdd.mock.calls[0]![0].end).toBe("2026-10-02T22:30:00.000Z");
  });

  it("rejects an inverted same-day end and clears the error after duration correction", () => {
    const onAdd = renderDialog({
      start: "2026-10-01T21:30:00.000Z", // 23:30 Berlin
      end: "2026-10-01T22:30:00.000Z", // 00:30 Berlin next day
    });

    fireEvent.change(screen.getByTestId("manual-entry-end-date"), {
      target: { value: "2026-10-01" },
    });
    expect(screen.getByTestId("manual-entry-add")).toBeDisabled();
    expect(screen.getByText("manualDialog.invalidEndDate")).toBeTruthy();

    const duration = screen.getByTestId("manual-entry-duration");
    fireEvent.change(duration, { target: { value: "2h" } });
    fireEvent.keyDown(duration, { key: "Enter" });
    expect(screen.getByTestId("manual-entry-add")).not.toBeDisabled();
    expect(screen.getByText("manualDialog.endDateHint")).toBeTruthy();

    fireEvent.click(screen.getByTestId("manual-entry-add"));
    expect(onAdd).toHaveBeenCalledOnce();
    expect(secondsBetween(onAdd.mock.calls[0]![0])).toBe(7200);
  });

  it("clears an invalid end-date selection after a valid date correction", () => {
    const onAdd = renderDialog({
      start: "2026-10-01T21:30:00.000Z",
      end: "2026-10-01T22:30:00.000Z",
    });

    fireEvent.change(screen.getByTestId("manual-entry-end-date"), {
      target: { value: "" },
    });
    expect(screen.getByTestId("manual-entry-add")).toBeDisabled();
    fireEvent.change(screen.getByTestId("manual-entry-end-date"), {
      target: { value: "2026-10-03" },
    });

    expect(screen.getByTestId("manual-entry-add")).not.toBeDisabled();
    fireEvent.click(screen.getByTestId("manual-entry-add"));
    expect(onAdd).toHaveBeenCalledOnce();
  });

  it("refuses to add while either date field is invalid", () => {
    const onAdd = renderDialog({
      start: "2026-10-01T21:30:00.000Z",
      end: "2026-10-01T22:30:00.000Z",
    });

    fireEvent.change(screen.getByTestId("manual-entry-end-date"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByTestId("manual-entry-add"));

    expect(onAdd).not.toHaveBeenCalled();
  });

  it("keeps seconds unchanged when neither time field is edited", () => {
    const onAdd = renderDialog({
      start: "2026-10-01T21:30:17.000Z",
      end: "2026-10-01T22:30:42.000Z",
    });

    fireEvent.click(screen.getByTestId("manual-entry-add"));

    expect(onAdd.mock.calls[0]![0].start).toBe("2026-10-01T21:30:17.000Z");
    expect(onAdd.mock.calls[0]![0].end).toBe("2026-10-01T22:30:42.000Z");
  });
});
