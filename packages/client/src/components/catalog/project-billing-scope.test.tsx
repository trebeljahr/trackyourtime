// @vitest-environment jsdom
import * as React from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProjectOption } from "./types";
import { registerPrivateMutationActionCapture } from "@/lib/private-mutation-guard";
const state = vi.hoisted(() => ({ scope: 0, fetch: vi.fn(), error: vi.fn(), success: vi.fn(), update: vi.fn(), create: vi.fn() }));
vi.mock("@/lib/trpc", () => ({ trpc: { useUtils: () => ({ projects: { billingImpact: { fetch: state.fetch } } }) } }));
vi.mock("@/components/ui/sonner", () => ({ toast: { error: state.error, success: state.success } }));
vi.mock("@/lib/format", () => ({ useFormatSettings: () => ({ currency: "EUR", money: (value: number) => `EUR ${value}`, settings: { defaultHourlyRate: 80 } }) }));
vi.mock("./use-catalog-mutations", () => ({ useProjectMutations: () => ({ updateProject: state.update, createProject: state.create, isSaving: false }), useClientMutations: () => ({ createClient: vi.fn(), updateClient: vi.fn() }) }));
const { useApplyToEntriesPrompt } = await import("./apply-to-entries-prompt");
const { ProjectBillingCell } = await import("./project-billing-cell");
const { ProjectFormDialog } = await import("./project-form-dialog");
const project: ProjectOption = { id: "project", workspaceId: "workspace", name: "Private project", color: "#112233", createdBy: "owner", createdAt: "2026-10-28T00:00:00.000Z", updatedAt: "2026-10-28T00:00:00.000Z", archived: false, clientId: null, billableDefault: true, hourlyRate: 10, estimatedHours: null, budgetAmount: null, budgetCurrency: null, idleBehavior: null, clientName: null, clientColor: null };
let restore: () => void;
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  state.scope = 0; state.fetch.mockReset(); state.error.mockClear(); state.success.mockClear(); state.update.mockReset(); state.create.mockReset();
  restore = registerPrivateMutationActionCapture(() => { const at = state.scope; return { current: () => state.scope === at, check: () => { if (state.scope !== at) throw new Error("Scope changed"); } }; });
});
afterEach(() => { cleanup(); restore(); vi.unstubAllGlobals(); });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const next = { billableDefault: true, hourlyRate: 20 };
it.each(["reply", "error"])("ignores a late billing-impact %s after account/device scope changes", async (kind) => {
  const count = deferred<{ entries: number; invoiced: number }>(); state.fetch.mockReturnValue(count.promise);
  const hook = renderHook(() => useApplyToEntriesPrompt()); let result!: Promise<unknown>; act(() => { result = hook.result.current.ask(project, next); }); state.scope++;
  await act(async () => { if (kind === "reply") count.resolve({ entries: 4, invoiced: 1 }); else count.reject(new Error("Old private billing error")); expect(await result).toBeNull(); });
  expect(state.error).not.toHaveBeenCalled(); expect(hook.result.current.dialog.props.open).toBe(false);
});
it("settles an open confirmation when its form unmounts", async () => {
  state.fetch.mockResolvedValue({ entries: 4, invoiced: 1 }); const hook = renderHook(() => useApplyToEntriesPrompt()); let result!: Promise<unknown>;
  act(() => { result = hook.result.current.ask(project, next); }); await waitFor(() => expect(hook.result.current.dialog.props.open).toBe(true)); hook.unmount(); expect(await result).toBeNull();
});
it("does not open a confirmation after its form unmounts during the count request", async () => {
  const count = deferred<{ entries: number; invoiced: number }>(); state.fetch.mockReturnValue(count.promise); const hook = renderHook(() => useApplyToEntriesPrompt());
  const result = hook.result.current.ask(project, next); hook.unmount(); count.resolve({ entries: 4, invoiced: 0 }); expect(await result).toBeNull();
});
it("lets the newest billing question win when count replies arrive out of order", async () => {
  const first = deferred<{ entries: number; invoiced: number }>(), latest = deferred<{ entries: number; invoiced: number }>(); state.fetch.mockReturnValueOnce(first.promise).mockReturnValueOnce(latest.promise);
  const hook = renderHook(() => useApplyToEntriesPrompt()); let old!: Promise<unknown>, current!: Promise<unknown>;
  act(() => { old = hook.result.current.ask(project, next); current = hook.result.current.ask({ ...project, name: "Latest project" }, next); });
  await act(async () => { latest.resolve({ entries: 2, invoiced: 0 }); }); expect(hook.result.current.dialog.props.open).toBe(true);
  await act(async () => { first.resolve({ entries: 3, invoiced: 0 }); expect(await old).toBeNull(); }); hook.unmount(); expect(await current).toBeNull();
});
it("does not send the actual project's old form draft after a resolved confirmation crosses a scope change", async () => {
  render(<ProjectFormDialog open onOpenChange={() => {}} project={project} clients={[]} />);
  fireEvent.change(screen.getByTestId("project-name-input"), { target: { value: "Earlier private form name" } });
  const button = screen.getByTestId("project-submit");
  await act(async () => { fireEvent.submit(button.closest("form")!); state.scope++; await Promise.resolve(); });
  expect(state.update).not.toHaveBeenCalled(); expect(state.success).not.toHaveBeenCalled();
});
it("preserves an ordinary project save in the same scope", async () => {
  state.update.mockResolvedValue({ ...project, entriesRewritten: null }); const close = vi.fn(); render(<ProjectFormDialog open onOpenChange={close} project={project} clients={[]} />);
  fireEvent.change(screen.getByTestId("project-name-input"), { target: { value: "Confirmed rename" } }); fireEvent.submit(screen.getByTestId("project-submit").closest("form")!);
  await waitFor(() => expect(state.update).toHaveBeenCalledOnce()); expect(state.update.mock.calls[0]![0]).toMatchObject({ name: "Confirmed rename", applyToEntries: false }); await waitFor(() => expect(close).toHaveBeenCalledWith(false));
});

it("keeps an inline billing-cell confirmation bound before its update mutation exists", async () => {
  const choice = deferred<"entries" | "new-only" | null>(), ask = vi.fn(() => choice.promise);
  render(<ProjectBillingCell project={project} prompt={{ ask, dialog: <></> }} updateProject={state.update} />);
  fireEvent.click(screen.getByTestId("project-billing-project"));
  const rate = await screen.findByTestId("project-billing-rate"); fireEvent.change(rate, { target: { value: "20" } }); fireEvent.submit(rate.closest("form")!); expect(ask).toHaveBeenCalledOnce();
  await act(async () => { state.scope++; choice.resolve("new-only"); }); expect(state.update).not.toHaveBeenCalled(); expect(state.success).not.toHaveBeenCalled();
});
it("does not close or announce the old project form after a late save result crosses scope", async () => {
  const save = deferred<unknown>(); state.update.mockReturnValue(save.promise); const close = vi.fn(); render(<ProjectFormDialog open onOpenChange={close} project={project} clients={[]} />);
  fireEvent.submit(screen.getByTestId("project-submit").closest("form")!); await waitFor(() => expect(state.update).toHaveBeenCalledOnce());
  await act(async () => { state.scope++; save.resolve({ ...project, entriesRewritten: null }); }); expect(close).not.toHaveBeenCalled(); expect(state.success).not.toHaveBeenCalled();
});

it("accepts a current confirmation and cancels one whose scope changed while it was open", async () => {
  state.fetch.mockResolvedValue({ entries: 2, invoiced: 0 }); const hook = renderHook(() => useApplyToEntriesPrompt()); let result!: Promise<unknown>;
  act(() => { result = hook.result.current.ask(project, next); }); await waitFor(() => expect(hook.result.current.dialog.props.open).toBe(true));
  const dialog = render(hook.result.current.dialog); fireEvent.click(screen.getByTestId("apply-to-entries-new-only")); expect(await result).toBe("new-only"); dialog.unmount();
  act(() => { result = hook.result.current.ask(project, next); }); await waitFor(() => expect(hook.result.current.dialog.props.open).toBe(true));
  render(hook.result.current.dialog); state.scope++; fireEvent.click(screen.getByTestId("apply-to-entries-accept")); expect(await result).toBeNull();
});
it("ignores a stale modal click rather than answering a newer question with it", async () => {
  state.fetch.mockResolvedValue({ entries: 2, invoiced: 0 }); const hook = renderHook(() => useApplyToEntriesPrompt()); let first!: Promise<unknown>, latest!: Promise<unknown>;
  act(() => { first = hook.result.current.ask(project, next); }); await waitFor(() => expect(hook.result.current.dialog.props.open).toBe(true));
  const old = render(hook.result.current.dialog);
  act(() => { latest = hook.result.current.ask({ ...project, name: "Newer project" }, next); }); await waitFor(() => expect(hook.result.current.dialog.props.open).toBe(true)); expect(await first).toBeNull();
  let settled = false; void latest.then(() => { settled = true; }); fireEvent.click(screen.getByTestId("apply-to-entries-accept")); await act(async () => { await Promise.resolve(); }); expect(settled).toBe(false);
  old.unmount(); hook.unmount(); expect(await latest).toBeNull();
});
