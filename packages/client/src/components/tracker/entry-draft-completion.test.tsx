// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { DetailedEntry } from "@starter/shared";
import type { EntryFields } from "@starter/core";
import type { EntryMutationResult } from "@/lib/entry-mutation-result";
import type { EntryMutations } from "./use-entry-mutations";

let workspace: string | null = "ws-a";
let owner: string | null = "u-a";
const listeners = new Set<() => void>();
vi.mock("@/lib/active-workspace", () => ({
  getActiveWorkspaceId: () => workspace,
  getKnownWorkspacesOwner: () => owner,
  subscribeActiveWorkspace: (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
}));
vi.mock("@/lib/api-origin", () => ({ getAbsoluteApiOrigin: () => "https://example.test" }));
vi.mock("@/lib/offline", () => ({
  getOfflineQueueOwner: () => owner,
  getOfflineQueueStampOwner: () => owner,
  isNetworkError: () => false,
}));
vi.mock("@/lib/format", () => ({
  useFormatSettings: () => ({ timeFormat: "24h", durationFormat: "h:mm" }),
}));
vi.mock("@/components/entry-fields/entry-fields-editor", () => ({
  EntryFieldsEditor: ({ value, onChange, onSubmit, disabled, testIdPrefix }: {
    value: EntryFields; onChange: (value: EntryFields) => void; onSubmit?: () => void;
    disabled?: boolean; testIdPrefix: string;
  }) => <input value={value.description} disabled={disabled} data-testid={`${testIdPrefix}-description`}
    onChange={(event) => onChange({ ...value, description: event.target.value })}
    onKeyDown={(event) => { if (event.key === "Enter") onSubmit?.(); }} />,
}));
vi.mock("@/components/tracker/time-field", () => ({
  TimeField: ({ value, testId }: { value: string; testId: string }) => <input readOnly value={value} data-testid={testId} />,
}));
vi.mock("@/components/duration-input", () => ({
  DurationInput: ({ value, testId }: { value: number; testId: string }) => <input readOnly value={value} data-testid={testId} />,
}));

import { ManualEntryDialog } from "./manual-entry-dialog";
import { EntryEditDialog } from "./entry-edit-dialog";
import { useEntryEditor } from "./use-entry-editor";

const deferred = <T,>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve: (value) => resolve(value) };
};
const seed = { description: "Seed", projectId: null, taskId: null, billable: false, tagIds: [] };
const entry: DetailedEntry = {
  ...seed, id: "entry-a", workspaceId: "ws-a", authorId: "u-a", start: "2026-10-01T09:00:00.000Z", end: "2026-10-01T10:00:00.000Z",
  timeZone: "UTC", source: "web", durationSec: 3600, hourlyRate: null, currency: "EUR", createdAt: "2026-10-01T09:00:00.000Z",
  updatedAt: "2026-10-01T09:00:00.000Z", runaway: null, invoiceId: null, importId: null,
  projectName: null, projectColor: null, clientName: null, taskName: null, amount: null,
};

beforeEach(() => { workspace = "ws-a"; owner = "u-a"; });
afterEach(() => { cleanup(); listeners.clear(); });

for (const mode of ["manual", "edit"] as const) {
  describe(`${mode} draft persistence`, () => {
    const mount = (write: () => Promise<EntryMutationResult>, done = vi.fn()) => {
      const mutations = { createManualEntry: write, updateEntry: write } as unknown as EntryMutations;
      render(mode === "manual"
        ? <ManualEntryDialog open seed={seed} mutations={mutations} onOpenChange={done} />
        : <EntryEditDialog entry={entry} mutations={mutations} onClose={done} />);
      const prefix = mode === "manual" ? "manual-entry" : "entry-edit";
      return { done, prefix, submit: screen.getByTestId(`${prefix}-${mode === "manual" ? "add" : "save"}`) };
    };

    it("keeps the draft and blocks duplicate saves/cancel/Escape/outside click while pending", async () => {
      const save = deferred<EntryMutationResult>();
      const write = vi.fn(() => save.promise);
      const { done, prefix, submit } = mount(write);
      fireEvent.change(screen.getByTestId(`${prefix}-description`), { target: { value: "My draft" } });
      act(() => { fireEvent.click(submit); fireEvent.click(submit); });
      expect(write).toHaveBeenCalledTimes(1);
      expect(submit).toBeDisabled();
      expect(screen.getByTestId(`${prefix}-cancel`)).toBeDisabled();
      fireEvent.click(screen.getByTestId(`${prefix}-cancel`));
      fireEvent.keyDown(screen.getByTestId(`${prefix}-dialog`), { key: "Escape" });
      fireEvent.pointerDown(screen.getByTestId("dialog-overlay"));
      expect(done).not.toHaveBeenCalled();
      expect(screen.getByTestId(`${prefix}-description`)).toHaveValue("My draft");
      await act(async () => save.resolve({ ok: true, saved: "server" }));
      expect(done).toHaveBeenCalledTimes(1);
    });

    it("keeps fields and displays a refusal, then allows retry and cancel", async () => {
      const write = vi.fn(async (): Promise<EntryMutationResult> => ({ ok: false, message: "Entry is invoiced" }));
      const { done, prefix, submit } = mount(write);
      fireEvent.change(screen.getByTestId(`${prefix}-description`), { target: { value: "My draft" } });
      fireEvent.click(submit);
      await screen.findByRole("alert");
      expect(screen.getByRole("alert")).toHaveTextContent("Entry is invoiced");
      expect(screen.getByTestId(`${prefix}-description`)).toHaveValue("My draft");
      expect(done).not.toHaveBeenCalled();
      expect(submit).toBeEnabled();
      fireEvent.click(screen.getByTestId(`${prefix}-cancel`));
      expect(done).toHaveBeenCalledTimes(1);
    });

    for (const unknown of ["account", "workspace"] as const) {
      it(`keeps an unresolved ${unknown} draft with loading guidance`, async () => {
        if (unknown === "account") owner = null;
        else workspace = null;
        const message = "Your account or workspace is still loading. Wait for it to load, then reopen this editor and try again.";
        const write = vi.fn(async (): Promise<EntryMutationResult> => ({ ok: false, message }));
        const { done, prefix, submit } = mount(write);
        fireEvent.change(screen.getByTestId(`${prefix}-description`), { target: { value: "Cold draft" } });
        fireEvent.click(submit);
        expect(await screen.findByRole("alert")).toHaveTextContent(message);
        expect(done).not.toHaveBeenCalled();
        expect(screen.getByTestId(`${prefix}-description`)).toHaveValue("Cold draft");
        act(() => {
          workspace = "ws-b";
          owner = "u-b";
          listeners.forEach((notify) => notify());
        });
        fireEvent.click(submit);
        expect(write).toHaveBeenCalledTimes(1);
        expect(done).not.toHaveBeenCalled();
        expect(screen.getByTestId(`${prefix}-cancel`)).toBeEnabled();
      });
    }

    it("closes after durable offline completion", async () => {
      const save = deferred<EntryMutationResult>();
      const { done, submit } = mount(() => save.promise);
      fireEvent.click(submit);
      expect(done).not.toHaveBeenCalled();
      await act(async () => save.resolve({ ok: true, saved: "offline" }));
      expect(done).toHaveBeenCalledTimes(1);
    });

    for (const change of ["workspace", "account"] as const) {
      it(`ignores success after ${change} changes, keeps cancel available once settled`, async () => {
        const save = deferred<EntryMutationResult>();
        const write = vi.fn(() => save.promise);
        const { done, prefix, submit } = mount(write);
        fireEvent.click(submit);
        act(() => {
          if (change === "workspace") workspace = "ws-b";
          else owner = "u-b";
          listeners.forEach((notify) => notify());
        });
        await act(async () => save.resolve({ ok: true, saved: "server" }));
        expect(done).not.toHaveBeenCalled();
        expect(screen.getByRole("alert")).toHaveTextContent("account or workspace changed");
        fireEvent.click(submit);
        expect(write).toHaveBeenCalledTimes(1);
        fireEvent.click(screen.getByTestId(`${prefix}-cancel`));
        expect(done).toHaveBeenCalledTimes(1);
      });
    }
  });
}

describe("shared editor lifecycle", () => {
  it("never lets the previous entry's completion close a newly opened editor", async () => {
    const save = deferred<EntryMutationResult>();
    const done = vi.fn();
    const onSave = vi.fn(() => save.promise);
    const { result, rerender } = renderHook(({ edited }) => useEntryEditor(edited, { onSave, onDone: done }), { initialProps: { edited: entry } });
    act(() => result.current.save());
    rerender({ edited: { ...entry, id: "entry-b", description: "Other draft" } });
    expect(result.current.fields.description).toBe("Other draft");
    await act(async () => save.resolve({ ok: true, saved: "server" }));
    expect(done).not.toHaveBeenCalled();
    expect(result.current.fields.description).toBe("Other draft");
    expect(result.current.pending).toBe(false);
  });

  it("guards repeated synchronous submits before a render", async () => {
    const save = deferred<EntryMutationResult>();
    const onSave = vi.fn(() => save.promise);
    const done = vi.fn();
    const { result } = renderHook(() => useEntryEditor(entry, { onSave, onDone: done }));
    act(() => { result.current.save(); result.current.save(); result.current.save(); result.current.dismiss(); });
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(done).not.toHaveBeenCalled();
    await act(async () => save.resolve({ ok: false, message: "Still syncing" }));
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(done).not.toHaveBeenCalled();
  });
});
