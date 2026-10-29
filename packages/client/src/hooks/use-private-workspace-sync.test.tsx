// @vitest-environment jsdom
import * as React from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ userId: "owner", workspaceId: "workspace", server: "https://api.example.test", version: 1, root: true, mode: "encrypted", listeners: new Set<() => void>(), edits: null as null | ((scope: { server: string; userId: string; workspaceId: string }) => void), sync: vi.fn(), timer: vi.fn(), route: vi.fn() }));
vi.mock("@/lib/private-account-timer-sync", () => ({ syncPrivateAccountTimerIfPresent: (...args: unknown[]) => state.timer(...args) }));
vi.mock("./use-auth", () => ({ useAuth: () => ({ user: { id: state.userId } }) }));
vi.mock("@/components/members/use-active-workspace", () => ({ useActiveWorkspace: () => ({ workspace: { id: state.workspaceId } }) }));
vi.mock("@/lib/private-session", () => ({ privateAccountId: () => state.userId, privateDataOrigin: () => state.server, privateSession: () => state.root ? {} : null, privateSessionVersion: () => state.version, subscribePrivateSession: (listener: () => void) => { state.listeners.add(listener); return () => state.listeners.delete(listener); } }));
vi.mock("@/lib/private-content-route", () => ({ currentWorkspaceContentRoute: () => state.route(), isWorkspaceContentProcedure: (path: string) => path === "tags.list" }));
vi.mock("@/lib/private-workspace-sync", () => ({ syncPrivateWorkspace: (...args: unknown[]) => state.sync(...args), subscribePrivateWorkspaceEdits: (listener: typeof state.edits) => { state.edits = listener; return () => { state.edits = null; }; } }));
const { usePrivateWorkspaceSync } = await import("./use-private-workspace-sync");
beforeEach(() => { state.userId = "owner"; state.workspaceId = "workspace"; state.server = "https://api.example.test"; state.root = true; state.version++; state.mode = "encrypted"; state.timer.mockReset().mockResolvedValue(null); state.sync.mockReset().mockImplementation(async (_scope, publish) => { publish({ phase: "saved", pending: 0 }); return { changed: false }; }); state.route.mockReset().mockImplementation(async () => ({ mode: state.mode, check: () => {} })); });
afterEach(() => { vi.restoreAllMocks(); });
function render() { const client = new QueryClient(); return { client, ...renderHook(() => usePrivateWorkspaceSync(), { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> }) }; }
const notify = () => state.edits?.({ server: state.server, userId: state.userId, workspaceId: state.workspaceId });
it("serializes edit notifications and queues one fresh pass while another is running", async () => {
  const pending: { publish: (value: unknown) => void; resolve: (value: unknown) => void }[] = [];
  state.sync.mockImplementation((_scope, publish) => new Promise((resolve) => { pending.push({ publish, resolve }); }));
  const view = render(); await waitFor(() => expect(pending).toHaveLength(1));
  act(() => { notify(); notify(); notify(); }); expect(pending).toHaveLength(1);
  await act(async () => { pending[0]!.publish({ phase: "pending", pending: 2 }); pending[0]!.resolve({ changed: false }); });
  await waitFor(() => expect(pending).toHaveLength(2)); expect(view.result.current).toEqual({ phase: "pending", pending: 2 });
  await act(async () => { pending[1]!.publish({ phase: "saved", pending: 0 }); pending[1]!.resolve({ changed: false }); }); expect(view.result.current).toEqual({ phase: "saved", pending: 0 }); view.unmount();
});
it("drops late results and refreshes after an account change without publishing the previous pending count", async () => {
  const pending: { publish: (value: unknown) => void; current: () => boolean; resolve: (value: unknown) => void }[] = [];
  state.sync.mockImplementation((_scope, publish, current) => new Promise((resolve) => { pending.push({ publish, current, resolve }); }));
  const view = render(), invalidate = vi.spyOn(view.client, "invalidateQueries"); await waitFor(() => expect(pending).toHaveLength(1));
  await act(async () => { state.userId = "other"; state.version++; for (const listener of state.listeners) listener(); }); await waitFor(() => expect(pending).toHaveLength(2));
  expect(pending[0]!.current()).toBe(false); expect(view.result.current).toEqual({ phase: "checking", pending: null });
  await act(async () => { pending[0]!.publish({ phase: "pending", pending: 17 }); pending[0]!.resolve({ changed: true }); }); expect(invalidate).not.toHaveBeenCalled(); expect(view.result.current).toEqual({ phase: "checking", pending: null });
  await act(async () => { pending[1]!.publish({ phase: "saved", pending: 0 }); pending[1]!.resolve({ changed: false }); }); view.unmount();
});
it("leaves standard workspace status to its existing transport and retries private sync on reconnect", async () => {
  state.mode = "standard"; const view = render(); await waitFor(() => expect(view.result.current).toBeNull()); expect(state.sync).not.toHaveBeenCalled();
  state.mode = "encrypted"; act(() => { window.dispatchEvent(new Event("online")); }); await waitFor(() => expect(state.sync).toHaveBeenCalledOnce());
  state.edits?.({ server: state.server, userId: "foreign", workspaceId: state.workspaceId }); expect(state.sync).toHaveBeenCalledOnce(); view.unmount();
});
it("does no private polling without unlocked keys and ignores edits while hidden", async () => {
  state.root = false; const standard = render(); expect(standard.result.current).toBeNull(); expect(state.route).not.toHaveBeenCalled(); standard.unmount();
  state.root = true; vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden"); const hidden = render(); expect(state.sync).not.toHaveBeenCalled(); act(() => notify()); expect(state.sync).not.toHaveBeenCalled(); hidden.unmount();
});

it("syncs an enrolled account timer while viewing a standard workspace and refreshes cross-workspace clocks", async () => {
  state.mode = "standard"; state.timer.mockResolvedValue({ changed: true, caughtUp: true, pending: 0, committed: 0 });
  const view = render(); await waitFor(() => expect(view.result.current).toBeNull()); expect(state.timer).toHaveBeenCalledOnce(); expect(state.sync).not.toHaveBeenCalled();
  act(() => { state.edits?.({ server: state.server, userId: state.userId, workspaceId: "another-private-workspace" }); });
  await waitFor(() => expect(state.timer).toHaveBeenCalledTimes(2)); view.unmount();
});
it("keeps a partial account sync pending instead of showing the selected workspace as saved", async () => {
  state.timer.mockResolvedValue({ changed: false, caughtUp: false, pending: 2, committed: 1 });
  const view = render(); await waitFor(() => expect(view.result.current).toEqual({ phase: "pending", pending: 3 })); expect(state.sync).not.toHaveBeenCalled(); view.unmount();
});
