// @vitest-environment jsdom
import { ACTIVE_WORKSPACE_STORAGE_KEY, type WorkspaceSummary } from "@starter/core";
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ values: new Map<string, string>(), wait: null as null | (() => Promise<void>) }));
vi.mock("@/mobile/preferences-storage", () => ({ shouldUseNativeStorage: () => true, preferencesStorage: () => ({
  getItem: async (key: string) => state.values.get(key) ?? null,
  setItem: async (key: string, value: string) => { if (key === ACTIVE_WORKSPACE_STORAGE_KEY && value === "workspace-b") await state.wait?.(); state.values.set(key, value); },
  removeItem: async (key: string) => { state.values.delete(key); },
}) }));
const active = await import("./active-workspace");
const row = (id: string, isDefault = false): WorkspaceSummary => ({ id, name: id, role: "member", memberCount: 1, isDefault, permissions: { inviteMembers: false, inviteAdmins: false, changeRoles: false, editTimeVisibility: false, editMoneyVisibility: false, removeMembers: false, transferOwnership: false, invoices: false, viewOthersTime: false, viewOthersMoney: false } });
beforeEach(() => { active.__resetActiveWorkspaceForTests(); localStorage.clear(); state.values.clear(); state.wait = null; });
function delay() { let enter!: () => void, resume!: () => void; const entered = new Promise<void>((resolve) => { enter = resolve; }); state.wait = async () => { enter(); await new Promise<void>((resolve) => { resume = resolve; }); }; return { entered, resume: () => resume() }; }
it("serializes slow native selection writes so an earlier choice cannot overwrite a newer one", async () => {
  await active.applyWorkspaceList([row("workspace-a", true), row("workspace-b"), row("workspace-c")], "owner");
  const first = new QueryClient(), next = new QueryClient(), setActive = vi.fn(async () => {}), paused = delay();
  const old = active.switchWorkspace("workspace-b", { queryClient: first, setActive }); await paused.entered;
  const latest = active.switchWorkspace("workspace-c", { queryClient: next, setActive });
  await vi.waitFor(() => expect(active.getActiveWorkspaceId()).toBe("workspace-c")); paused.resume(); await Promise.all([old, latest]);
  expect(state.values.get(ACTIVE_WORKSPACE_STORAGE_KEY)).toBe("workspace-c"); expect(setActive.mock.calls).toEqual([["workspace-c"]]); first.clear(); next.clear();
});
it("lets sign-out cleanup win over an earlier native selection write", async () => {
  await active.applyWorkspaceList([row("workspace-a", true), row("workspace-b")], "owner");
  const queryClient = new QueryClient(), setActive = vi.fn(async () => {}), paused = delay();
  const switching = active.switchWorkspace("workspace-b", { queryClient, setActive }); await paused.entered;
  const clearing = active.clearActiveWorkspace(); await vi.waitFor(() => expect(active.getActiveWorkspaceId()).toBeNull()); paused.resume(); await Promise.all([switching, clearing]);
  expect(state.values.has(ACTIVE_WORKSPACE_STORAGE_KEY)).toBe(false); expect(setActive).not.toHaveBeenCalled(); queryClient.clear();
});
