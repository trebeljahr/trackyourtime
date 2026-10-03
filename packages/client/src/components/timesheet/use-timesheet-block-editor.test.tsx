// @vitest-environment jsdom
import type * as React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, renderHook, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOptimisticEntry } from "@starter/core";
import { buildTimesheetGrid, planCellEdit, type DetailedEntry } from "@starter/shared";
import type { EntryMutationResult } from "@/lib/entry-mutation-result";
import type { EntryMutations, ManualEntryArgs, UpdateEntryArgs } from "@/components/tracker/use-entry-mutations";

const state = vi.hoisted(() => ({
  workspaceId: "workspace", owner: "me", server: "https://example.test",
  settings: null as { workspaceId: string; userId: string; defaultHourlyRate: number; memberHourlyRate: number; currency: string } | null,
  week: { entries: [] as DetailedEntry[] }, tracker: [] as DetailedEntry[],
}));
vi.mock("@/lib/active-workspace", () => ({
  getActiveWorkspaceId: () => state.workspaceId,
  getKnownWorkspacesOwner: () => state.owner,
  subscribeActiveWorkspace: () => () => {},
}));
vi.mock("@/lib/api-origin", () => ({ getAbsoluteApiOrigin: () => state.server }));
vi.mock("@/lib/offline", () => ({
  isTempId: (id: string) => id.startsWith("temp-"),
  getOfflineQueueOwner: () => state.owner,
  getOfflineQueueStampOwner: () => state.owner,
}));
vi.mock("@starter/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@starter/core")>(), deviceTimeZone: () => "Europe/Berlin",
}));
vi.mock("@/lib/format", () => ({ useFormatSettings: () => ({ timeFormat: "24h", durationFormat: "hms" }) }));
vi.mock("@/components/entry-fields/entry-fields-editor", () => ({
  EntryFieldsEditor: ({ value, onChange, testIdPrefix }: {
    value: { description: string }; onChange: (value: { description: string }) => void; testIdPrefix: string;
  }) => <input aria-label="Description" data-testid={`${testIdPrefix}-description`} value={value.description}
    onChange={(event) => onChange({ ...value, description: event.target.value })} />,
}));
vi.mock("@/lib/shell", () => ({ entrySource: () => "web" }));
vi.mock("@/components/tracker/use-entry-mutations", () => ({ TRACKER_LIST_INPUT: {} }));
vi.mock("@/lib/trpc", () => ({ trpc: { useUtils: () => ({
  entries: { list: {
    getInfiniteData: () => { throw new Error("Tracker cache must not be consulted"); },
    setData: (_input: unknown, update: (data: typeof state.week) => typeof state.week) => { state.week = update(state.week); },
  } },
  projects: { list: { getData: () => [] } },
  tasks: { list: { getData: () => [] } },
  settings: { get: { getData: () => state.settings } },
}) } }));

import { useTimesheetBlockEditor } from "./use-timesheet-block-editor";
import { EntryEditDialog } from "@/components/tracker/entry-edit-dialog";
import { ManualEntryDialog } from "@/components/tracker/manual-entry-dialog";

const makeEntry = (id: string, start: string, end: string): DetailedEntry => ({
  ...buildOptimisticEntry({ projects: [], tasks: [], settings: null, source: "web" }, {
    id, description: id, projectId: null, taskId: null, billable: false, start, end,
  }), authorId: "me", workspaceId: "workspace", timeZone: "Europe/Berlin",
});
const first = makeEntry("first", "2026-03-28T08:00:00.000Z", "2026-03-28T09:00:00.000Z");
const sibling = makeEntry("sibling", "2026-03-28T11:00:00.000Z", "2026-03-28T12:00:00.000Z");
const days = ["2026-03-28", "2026-03-29", "2026-03-30"];
const grid = () => buildTimesheetGrid({ entries: state.week.entries, days, timeZone: "Europe/Berlin", nowMs: Date.parse("2026-04-01" ) });
const target = () => ({ row: grid().rows[0]!, day: days[0]!, testId: "cell" });
const input = { from: "2026-03-28", to: "2026-03-31", limit: 500 };
const saved: EntryMutationResult = { ok: true, saved: "offline" };
const harness = (options: { entries?: DetailedEntry[]; disabled?: boolean; locked?: string } = {}) => {
  const create = vi.fn<(args: ManualEntryArgs) => Promise<EntryMutationResult>>(async (args) => {
    return { ...saved, entry: { ...makeEntry("temp-new", args.start, args.end), ...args } };
  });
  const update = vi.fn<(args: UpdateEntryArgs) => Promise<EntryMutationResult>>(async (args) => {
    const original = state.week.entries.find((entry) => entry.id === args.id)!;
    const start = args.start ?? original.start;
    const end = args.end === undefined ? original.end : args.end;
    return { ...saved, entry: { ...original, ...args, start, end,
      durationSec: end === null ? 0 : (Date.parse(end) - Date.parse(start)) / 1000 } };
  });
  const mutations = { createManualEntry: create, updateEntry: update, isBusy: false } as unknown as EntryMutations;
  const props = { entries: options.entries ?? state.week.entries, userId: "me", listInput: input,
    timeZone: "Europe/Berlin", mutations, disabled: options.disabled ?? false,
    cellDisabledReason: () => options.locked };
  const hook = renderHook((args) => useTimesheetBlockEditor(args), { initialProps: props });
  return { ...hook, props, create, update };
};

beforeEach(() => {
  state.workspaceId = "workspace";
  state.owner = "me";
  state.server = "https://example.test";
  state.week = { entries: [first, sibling] };
  state.tracker = [];
  state.settings = null;
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("timesheet individual block writes", () => {
  it("edits one older offline block and preserves its sibling and aggregate sum", async () => {
    const { result, update } = harness();
    const cell = grid().rows[0]!.cells[0]!;
    expect(planCellEdit({ cell, timeZone: "Europe/Berlin", targetSeconds: 3 * 3600 })).toEqual({ kind: "refuse", reason: "multiple" });
    act(() => result.current.edit(first, target()));
    await act(async () => {
      expect(await result.current.mutations.updateEntry({ id: "first", end: "2026-03-28T10:00:00.000Z" })).toMatchObject(saved);
    });
    expect(update).toHaveBeenCalledExactlyOnceWith({ id: "first", end: "2026-03-28T10:00:00.000Z" });
    expect(state.week.entries[1]).toBe(sibling);
    expect(state.week.entries[0]!.durationSec).toBe(7200);
    expect(grid().rows[0]!.cells[0]!.seconds).toBe(10800);
  });

  it("projects a durable offline update when the older entry is absent from the tracker result", async () => {
    const { result, update } = harness();
    update.mockResolvedValue(saved);
    act(() => result.current.edit(first, target()));
    await act(async () => { await result.current.mutations.updateEntry({ id: first.id, end: "2026-03-28T10:00:00.000Z" }); });
    expect(state.week.entries[0]!.durationSec).toBe(7200);
    expect(state.week.entries[1]).toBe(sibling);
  });

  it("resnapshots an older offline block with the author's member rate", async () => {
    state.settings = { workspaceId: "workspace", userId: "me", defaultHourlyRate: 0, memberHourlyRate: 95, currency: "CHF" };
    const { result, update } = harness(); update.mockResolvedValue(saved);
    act(() => result.current.edit(first, target()));
    await act(async () => { await result.current.mutations.updateEntry({ id: first.id, billable: true }); });
    expect(state.week.entries[0]).toMatchObject({ hourlyRate: 95, currency: "CHF", amount: 95 });
    expect(state.week.entries[1]).toBe(sibling);
  });
  it("keeps an open draft but refuses its save after approval locks the cell", async () => {
    const { result, rerender, props, update } = harness();
    act(() => result.current.edit(first, target()));
    rerender({ ...props, cellDisabledReason: () => "Approved period" });
    await act(async () => {
      expect(await result.current.mutations.updateEntry({ id: first.id, description: "Draft" })).toEqual({ ok: false, message: "Approved period" });
    });
    expect(update).not.toHaveBeenCalled(); expect(result.current.entry?.id).toBe(first.id);
  });

  it.each(["offline", "server"] as const)("adds the exact returned %s block without a tracker cache or changing siblings", async (destination) => {
    const { result, create } = harness();
    act(() => result.current.add(target()));
    const range = result.current.manual!.range;
    const returned = makeEntry(destination === "offline" ? "temp-exact-created-id" : "server-exact-created-id", range.start, range.end);
    create.mockResolvedValue({ ok: true, saved: destination, entry: returned });
    await act(async () => {
      await result.current.mutations.createManualEntry({ ...result.current.manual!.seed, ...range });
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(state.week.entries).toHaveLength(3);
    expect(state.week.entries[0]).toBe(first);
    expect(state.week.entries[1]).toBe(sibling);
    expect(state.week.entries[2]).toMatchObject({ id: returned.id, authorId: returned.authorId,
      workspaceId: returned.workspaceId, start: returned.start, end: returned.end });
    expect(grid().rows[0]!.cells[0]!.seconds).toBe(10800);
  });

  it("does not mirror an unsuccessful offline create", async () => {
    const { result, create } = harness();
    create.mockResolvedValue({ ok: false, message: "Storage full" });
    act(() => result.current.add(target()));
    await act(async () => { await result.current.mutations.createManualEntry({ ...result.current.manual!.seed, ...result.current.manual!.range }); });
    expect(state.week.entries).toEqual([first, sibling]);
    expect(result.current.manual).not.toBeNull();
  });

  it("keeps the draft when a success has no explicit saved identity", async () => {
    const { result, create } = harness();
    create.mockResolvedValue(saved);
    act(() => result.current.add(target()));
    await act(async () => { expect((await result.current.mutations.createManualEntry({ ...result.current.manual!.seed, ...result.current.manual!.range })).ok).toBe(false); });
    expect(state.week.entries).toEqual([first, sibling]);
    expect(result.current.manual).not.toBeNull();
  });

  it("seeds 09:00 on the selected local day across a DST transition", () => {
    const { result } = harness();
    act(() => result.current.add({ ...target(), day: "2026-03-29" }));
    expect(result.current.manual!.range).toEqual({ start: "2026-03-29T07:00:00.000Z", end: "2026-03-29T08:00:00.000Z" });
  });

  it("edits the entire midnight block and recalculates both days without touching siblings", async () => {
    const overnight = makeEntry("overnight", "2026-03-28T22:30:00.000Z", "2026-03-29T00:30:00.000Z");
    state.week.entries = [overnight, sibling];
    const { result } = harness();
    act(() => result.current.edit(overnight, target()));
    expect(result.current.entry).toBe(overnight);
    await act(async () => { await result.current.mutations.updateEntry({ id: overnight.id, end: "2026-03-29T01:30:00.000Z" }); });
    expect(state.week.entries[1]).toBe(sibling);
    expect(grid().rows[0]!.cells.slice(0, 2).map((cell) => cell.seconds)).toEqual([5400, 9000]);
  });

  it("leaves totals and the draft intact after a rejected save", async () => {
    const { result, update } = harness();
    update.mockResolvedValue({ ok: false, message: "Rejected" });
    act(() => result.current.edit(first, target()));
    await act(async () => {
      expect(await result.current.mutations.updateEntry({ id: first.id, description: "Draft" })).toEqual({ ok: false, message: "Rejected" });
    });
    expect(result.current.entry).toBe(first);
    expect(state.week.entries).toEqual([first, sibling]);
  });

  it("refuses an attempt to save a sibling ID", async () => {
    const { result, update } = harness();
    act(() => result.current.edit(first, target()));
    await act(async () => { expect((await result.current.mutations.updateEntry({ id: sibling.id, description: "Wrong" })).ok).toBe(false); });
    expect(update).not.toHaveBeenCalled();
  });

  it.each(["workspace", "owner", "server"] as const)("does not retarget a draft after changing %s", async (scope) => {
    const { result, update, create } = harness();
    act(() => result.current.edit(first, target()));
    if (scope === "workspace") state.workspaceId = "elsewhere";
    else if (scope === "owner") state.owner = "someone-else";
    else state.server = "https://other.test";
    await act(async () => { expect((await result.current.mutations.updateEntry({ id: first.id, description: "Draft" })).ok).toBe(false); });
    expect(update).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("leaves the new workspace cache alone when an old save settles", async () => {
    const { result, update } = harness();
    let finish!: (result: EntryMutationResult) => void;
    update.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    act(() => result.current.edit(first, target()));
    let pending!: Promise<EntryMutationResult>;
    act(() => { pending = result.current.mutations.updateEntry({ id: first.id, description: "Old draft" }); });
    state.workspaceId = "elsewhere";
    state.week = { entries: [] };
    await act(async () => { finish(saved); await pending; });
    expect(state.week.entries).toEqual([]);
  });

  it("rechecks invoice protection before writing an already open draft", async () => {
    const { result, rerender, props, update } = harness();
    act(() => result.current.edit(first, target()));
    rerender({ ...props, entries: [{ ...first, invoiceId: "invoice" }, sibling] });
    await act(async () => { expect((await result.current.mutations.updateEntry({ id: first.id, description: "Draft" })).ok).toBe(false); });
    expect(update).not.toHaveBeenCalled();
  });

  it("keeps locked and incomplete cells inspectable but refuses their editor actions", () => {
    const { result } = harness({ locked: "Approved period" });
    act(() => { result.current.edit(first, target()); result.current.add(target()); });
    expect(result.current.entry).toBeNull();
    expect(result.current.manual).toBeNull();
  });
  it("keeps the edited draft open through pending and rejected saves, then permits retry", async () => {
    const { result, update } = harness();
    act(() => result.current.edit(first, target()));
    let finish!: (value: EntryMutationResult) => void;
    update.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    // Render the actual shared dialog around the timesheet adapter.
    function Editor(): React.JSX.Element {
      const editor = useTimesheetBlockEditor({ entries: state.week.entries, userId: "me", listInput: input,
        timeZone: "Europe/Berlin", mutations: { ...result.current.mutations, updateEntry: update }, disabled: false });
      return <><button onClick={() => editor.edit(first, target())}>Open block</button>
        <EntryEditDialog entry={editor.entry} mutations={editor.mutations} onClose={editor.close} /></>;
    }
    render(<Editor />);
    fireEvent.click(screen.getByText("Open block"));
    fireEvent.change(screen.getByTestId("entry-edit-description"), { target: { value: "Keep my draft" } });
    fireEvent.click(screen.getByTestId("entry-edit-save"));
    fireEvent.click(screen.getByTestId("entry-edit-save"));
    expect(update).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("entry-edit-save")).toBeDisabled();
    expect(screen.getByTestId("entry-edit-description")).toBeDisabled();
    fireEvent.keyDown(screen.getByTestId("entry-edit-dialog"), { key: "Escape" });
    expect(screen.getByTestId("entry-edit-dialog")).toBeInTheDocument();
    await act(async () => { finish({ ok: false, message: "Rejected" }); });
    expect(screen.getByRole("alert")).toHaveTextContent("Rejected");
    expect(screen.getByTestId("entry-edit-description")).toHaveValue("Keep my draft");
    update.mockResolvedValue({ ...saved, entry: { ...first, description: "Keep my draft" } });
    fireEvent.click(screen.getByTestId("entry-edit-save"));
    await waitFor(() => expect(screen.queryByTestId("entry-edit-dialog")).not.toBeInTheDocument());
    expect(state.week.entries[1]).toBe(sibling);
  });

  it("closes the shared manual dialog only after a durable offline create is visible in the week", async () => {
    const { result, create } = harness();
    let finish!: (value: EntryMutationResult) => void;
    create.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    function Editor(): React.JSX.Element {
      const editor = useTimesheetBlockEditor({ entries: state.week.entries, userId: "me", listInput: input,
        timeZone: "Europe/Berlin", mutations: { ...result.current.mutations, createManualEntry: create }, disabled: false });
      return <><button onClick={() => editor.add(target())}>Add block</button>
        <ManualEntryDialog open={editor.manual !== null}
          onOpenChange={(open) => { if (!open) editor.close(); }}
          seed={editor.manual?.seed ?? { description: "", projectId: null, taskId: null, billable: false, tagIds: [] }}
          range={editor.manual?.range} mutations={editor.mutations} /></>;
    }
    render(<Editor />);
    fireEvent.click(screen.getByText("Add block"));
    fireEvent.click(screen.getByTestId("manual-entry-add"));
    expect(screen.getByTestId("manual-entry-dialog")).toBeInTheDocument();
    expect(state.week.entries).toHaveLength(2);
    const args = create.mock.calls[0]![0];
    await act(async () => { finish({ ...saved, entry: { ...makeEntry("temp-new", args.start, args.end), ...args } }); });
    await waitFor(() => expect(screen.queryByTestId("manual-entry-dialog")).not.toBeInTheDocument());
    expect(state.week.entries).toHaveLength(3);
    expect(state.week.entries[0]).toBe(first);
    expect(state.week.entries[1]).toBe(sibling);
  });

});
