// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DetailedEntry } from "@starter/shared";

const userId = vi.hoisted(() => ({ value: "me" as string | undefined }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { id: userId.value } }) }));

vi.mock("@/lib/format", () => ({
  useFormatSettings: () => ({
    currency: "EUR",
    duration: (seconds: number) => `${seconds}s`,
    durationFormat: "hms",
    timeFormat: "24h",
    money: () => "",
  }),
}));
vi.mock("@/i18n/use-format", () => ({
  useFormat: () => ({ date: () => "Sep 14, 2026" }),
}));
vi.mock("@/components/duration-input", () => ({ DurationInput: () => <span /> }));
vi.mock("@/components/entry-fields/project-task-picker", () => ({ ProjectTaskPicker: () => null }));
vi.mock("@/components/tags/tag-picker", () => ({ TagPicker: () => null }));
vi.mock("@/components/tracker/billable-glyph", () => ({ BillableGlyph: () => null }));
vi.mock("@/components/tracker/live-duration", () => ({ LiveDuration: () => <span /> }));
vi.mock("@/components/tracker/time-field", () => ({ TimeField: () => <span /> }));

const removeEntry = vi.fn();
const mutations = {
  startTimer: vi.fn(),
  startQuickStart: vi.fn(),
  stopTimer: vi.fn(),
  continueEntry: vi.fn(),
  createManualEntry: vi.fn(),
  updateEntry: vi.fn(),
  duplicateEntry: vi.fn(),
  removeEntry,
  removeEntryPendingId: null as string | null,
  splitAtIdle: vi.fn(),
  resolveRunaway: vi.fn(),
  isBusy: false,
};

const entry = (overrides: Partial<DetailedEntry> = {}): DetailedEntry =>
  ({
    id: "entry-1",
    workspaceId: "workspace-1",
    authorId: "me",
    description: "Prepare report",
    projectId: null,
    taskId: null,
    billable: false,
    start: "2026-09-14T09:00:00.000Z",
    end: "2026-09-14T09:30:00.000Z",
    durationSec: 1800,
    hourlyRate: null,
    currency: "EUR",
    source: "web",
    timeZone: null,
    runaway: null,
    tagIds: [],
    invoiceId: null,
    importId: null,
    createdAt: "2026-09-14T09:30:00.000Z",
    updatedAt: "2026-09-14T09:30:00.000Z",
    projectName: null,
    projectColor: null,
    clientName: null,
    taskName: null,
    amount: null,
    ...overrides,
  }) as DetailedEntry;

const quickStarts = { favorites: [], pin: vi.fn(), unpin: vi.fn() } as never;
const { EntryRow } = await import("./entry-row");

function openDelete(entryValue = entry()): void {
  render(
    <EntryRow
      entry={entryValue}
      mutations={mutations}
      quickStarts={quickStarts}
      onEdit={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByTestId("entry-menu"));
  fireEvent.click(screen.getByTestId("entry-menu-delete"));
}

afterEach(() => {
  cleanup();
  removeEntry.mockClear();
  mutations.removeEntryPendingId = null;
  userId.value = "me";
});

describe("EntryRow deletion confirmation", () => {
  it("shows entry identity and cancels by mouse without deleting", async () => {
    openDelete();

    expect(await screen.findByTestId("confirm-entry-delete")).toBeVisible();
    expect(screen.getByText("Prepare report")).toBeVisible();
    expect(screen.getByText("Sep 14, 2026 · 1800s")).toBeVisible();
    fireEvent.click(screen.getByTestId("confirm-cancel"));

    await waitFor(() => expect(screen.queryByTestId("confirm-entry-delete")).not.toBeInTheDocument());
    expect(removeEntry).not.toHaveBeenCalled();
  });

  it("cancels with Escape and calls deletion once after explicit confirmation", async () => {
    openDelete();
    await screen.findByTestId("confirm-entry-delete");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("confirm-entry-delete")).not.toBeInTheDocument());
    expect(removeEntry).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("entry-menu"));
    fireEvent.click(screen.getByTestId("entry-menu-delete"));
    const accept = await screen.findByTestId("confirm-accept");
    fireEvent.click(accept);
    fireEvent.click(accept);
    expect(removeEntry).toHaveBeenCalledTimes(1);
    expect(removeEntry).toHaveBeenCalledWith(expect.objectContaining({ id: "entry-1" }));
  });

  it("disables repeated deletion while a delete is pending", async () => {
    mutations.removeEntryPendingId = "entry-1";
    render(
      <EntryRow entry={entry()} mutations={mutations} quickStarts={quickStarts} onEdit={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId("entry-menu"));

    expect(screen.getByTestId("entry-menu-delete")).toBeDisabled();
    expect(removeEntry).not.toHaveBeenCalled();
  });

  it.each([
    { label: "an invoiced entry", overrides: { invoiceId: "invoice-1" } },
    { label: "a colleague's entry", overrides: { authorId: "someone-else" } },
  ])("does not offer deletion for $label", async ({ overrides }) => {
    openDelete(entry(overrides));

    expect(screen.getByTestId("entry-menu-delete")).toBeDisabled();
    expect(screen.queryByTestId("confirm-entry-delete")).not.toBeInTheDocument();
  });
});
