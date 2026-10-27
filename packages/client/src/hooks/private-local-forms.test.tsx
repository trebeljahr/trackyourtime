// @vitest-environment jsdom
import * as React from "react";
import { IDBFactory } from "fake-indexeddb";
import { webcrypto } from "node:crypto";
import { act, renderHook, waitFor, cleanup } from "@testing-library/react";
import { QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { signPrivateAccountInventory } from "@starter/core";
import { API_LEVEL } from "@starter/shared";
import { privateRecoveryFixture, privateManualEntryFixture, seedPrivateWorkspaceClient } from "@/test-private-recovery";
const state = vi.hoisted(() => ({ origin: "https://api.example.test", active: { activeId: "workspace", workspaces: null }, listeners: new Set<() => void>(), success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/api-origin", () => ({ getApiOrigin: () => state.origin, getAbsoluteApiOrigin: () => state.origin, getDefaultAbsoluteApiOrigin: () => state.origin, subscribeApiOrigin: () => () => {}, whenApiOriginReady: async () => {}, rebaseApiUrl: (url: string) => url }));
vi.mock("@/lib/active-workspace", () => ({ getActiveWorkspaceId: () => state.active.activeId, getActiveWorkspaceSnapshot: () => state.active, getServerActiveWorkspaceSnapshot: () => state.active, subscribeActiveWorkspace: (fn: () => void) => { state.listeners.add(fn); return () => state.listeners.delete(fn); }, isActiveWorkspaceReady: () => true, whenActiveWorkspaceReady: async () => {}, getKnownWorkspaceIds: () => new Set(["workspace"]), getKnownWorkspacesOwner: () => "owner", noteNotFound: () => {} }));
vi.mock("@/lib/desktop-activity", () => ({ desktopActivity: () => null }));
vi.mock("@/lib/server-level", () => ({ currentServerApiLevel: () => API_LEVEL, noteClientTooOld: () => {} }));
vi.mock("@/lib/native-session", () => ({ getNativeToken: () => null, getNativeTokenRevision: () => 0 }));
vi.mock("@/lib/shell", () => ({ clientId: () => "web", entrySource: () => "web", isCapacitor: () => false, isTokenShell: () => false }));
vi.mock("@/lib/app-version", () => ({ APP_VERSION: "test" }));
vi.mock("@/hooks/use-sync", () => ({ ORIGIN_ID: "test-form", timerStore: { getState: () => ({ running: null }), setState: () => {} } }));
vi.mock("@/components/ui/sonner", () => ({ toast: { success: state.success, error: state.error } }));
vi.mock("@/lib/app-query-persistence", () => ({ getQueryPersistence: () => ({ forget: async () => {}, protectPrivateAccount: async () => {} }) }));
vi.mock("@/lib/catalog-cache", () => ({ bindCatalogCaches: () => {} }));
const session = await import("@/lib/private-session");
const { trpc, getTRPCClient } = await import("@/lib/trpc");
const { createAppQueryClient } = await import("@/lib/query-client");
const { readPrivateDeviceAccessState } = await import("@/lib/private-device-access-state");
const { observedWorkspaceMode, rememberVerifiedWorkspaceModes } = await import("@/lib/private-workspace-mode-cache");
const { useQuickStarts } = await import("./use-favorites");
const { useClientMutations, useProjectMutations, useTaskMutations } = await import("@/components/catalog/use-catalog-mutations");
const { useTagMutations } = await import("@/components/tags/use-tags");
const { notePrivateView, privateViewEpoch, subscribePrivateViewEpoch } = await import("@/lib/private-view-lifecycle");
const { confirmStandardDeviceAccess } = await import("@/lib/private-device-access");
beforeEach(() => { vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("indexedDB", new IDBFactory()); vi.stubEnv("NEXT_PUBLIC_API_URL", state.origin); state.active = { activeId: "workspace", workspaces: null }; state.success.mockClear(); state.error.mockClear(); localStorage.clear(); session.lockPrivateData(); session.privateAccountChanged("owner"); onlineManager.setOnline(true); });
afterEach(() => { cleanup(); onlineManager.setOnline(true); session.lockPrivateData(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function wrapper() {
  // These are already-open form cases. Boundary integration tests separately
  // cover the first private-view epoch remount before hooks are reused.
  if (session.privateSession("owner")) notePrivateView({ server: state.origin, userId: "owner" });
  const queryClient = createAppQueryClient(), rpc = getTRPCClient({ streamQueries: false });
  return { queryClient, render: ({ children }: { children: React.ReactNode }) => <trpc.Provider client={rpc} queryClient={queryClient}><QueryClientProvider client={queryClient}>{children}</QueryClientProvider></trpc.Provider> };
}
it("saves a private favorite through the actual offline form hook without standard HTTP or a radio pause", async () => {
  await seedPrivateWorkspaceClient(await privateRecoveryFixture()); expect(await readPrivateDeviceAccessState("owner")).toBe("ready"); expect(observedWorkspaceMode("workspace")).toBe("encrypted");
  const fetcher = vi.fn(() => { throw new Error("Private local form must not use standard HTTP"); }); vi.stubGlobal("fetch", fetcher);
  const app = wrapper(), view = renderHook(() => useQuickStarts(), { wrapper: app.render }); await waitFor(() => expect(view.result.current.isLoading).toBe(false));
  onlineManager.setOnline(false); act(() => view.result.current.pin({ description: "Offline private pin", projectId: null, taskId: null, billable: false }));
  await waitFor(() => expect(state.success).toHaveBeenCalledOnce()); expect(view.result.current.favorites).toMatchObject([{ description: "Offline private pin" }]);
  expect(app.queryClient.getMutationCache().getAll().some((mutation) => mutation.state.isPaused)).toBe(false); expect(fetcher).not.toHaveBeenCalled(); view.unmount(); app.queryClient.clear();
});
it("preserves standard form pause-and-resume while the radio is offline", async () => {
  await confirmStandardDeviceAccess({ server: state.origin, userId: "owner" }, () => true); const app = wrapper(); onlineManager.setOnline(false);
  const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify([{ result: { data: { id: "standard-tag", workspaceId: "workspace", createdBy: "owner", name: "Standard tag", color: "#112233", archived: false, hidden: false, createdAt: "2026-10-27T00:00:00.000Z", updatedAt: "2026-10-27T00:00:00.000Z" } } }]), { headers: { "content-type": "application/json" } })); vi.stubGlobal("fetch", fetcher);
  const view = renderHook(() => useTagMutations(), { wrapper: app.render }); let pending!: Promise<unknown>; act(() => { pending = view.result.current.createTag({ name: "Standard tag" }); });
  await waitFor(() => expect(app.queryClient.getMutationCache().getAll()[0]?.state.isPaused).toBe(true)); expect(fetcher).not.toHaveBeenCalled();
  await act(async () => { onlineManager.setOnline(true); await pending; }); expect(fetcher).toHaveBeenCalledOnce(); view.unmount(); app.queryClient.clear();
});
it.each(["favorite", "tag", "client", "project", "task"] as const)("stops an old optimistic %s callback before it can repopulate the new account's cache", async (kind) => {
  await seedPrivateWorkspaceClient(await privateRecoveryFixture()); await readPrivateDeviceAccessState("owner"); await confirmStandardDeviceAccess({ server: state.origin, userId: "other" }, () => true);
  const app = wrapper(), view = renderHook(() => ({ favorites: useQuickStarts(), tags: useTagMutations(), clients: useClientMutations(), projects: useProjectMutations(), tasks: useTaskMutations() }), { wrapper: app.render }); await waitFor(() => expect(view.result.current.favorites.isLoading).toBe(false));
  let switched = false; const staleWrites: unknown[] = [], write = app.queryClient.setQueryData.bind(app.queryClient);
  vi.spyOn(app.queryClient, "setQueryData").mockImplementation(((...args: Parameters<typeof write>) => { const result = write(...args); if (switched && String(JSON.stringify(result)).includes("Earlier private form")) staleWrites.push(result); return result; }) as typeof write);
  let enter!: () => void, resume!: () => void; const entered = new Promise<void>((resolve) => { enter = resolve; }), cancel = app.queryClient.cancelQueries.bind(app.queryClient);
  vi.spyOn(app.queryClient, "cancelQueries").mockImplementationOnce(async (...args) => { enter(); await new Promise<void>((resolve) => { resume = resolve; }); return cancel(...args); });
  const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify([{ result: { data: [] } }]), { headers: { "content-type": "application/json" } })); vi.stubGlobal("fetch", fetcher);
  act(() => {
    if (kind === "favorite") view.result.current.favorites.pin({ description: "Earlier private form pin", projectId: null, taskId: null, billable: false });
    if (kind === "tag") void view.result.current.tags.createTag({ name: "Earlier private form tag" });
    if (kind === "client") void view.result.current.clients.createClient({ name: "Earlier private form client" });
    if (kind === "project") void view.result.current.projects.createProject({ name: "Earlier private form project" });
    if (kind === "task") void view.result.current.tasks.createTask({ name: "Earlier private form task" });
  }); await entered; const mutation = app.queryClient.getMutationCache().getAll()[0]!;
  await act(async () => { switched = true; session.privateAccountChanged("other"); resume(); }); await waitFor(() => expect(mutation.state.status).toBe("error"));
  for (const query of app.queryClient.getQueryCache().getAll()) expect(String(JSON.stringify(query.state.data))).not.toContain("Earlier private form pin");
  for (const [url, init] of fetcher.mock.calls) expect(String(url) + String(init?.body)).not.toContain("Earlier private form pin");
  expect(staleWrites).toEqual([]); expect(state.error).not.toHaveBeenCalled(); view.unmount(); app.queryClient.clear();
});
it("will not turn a claimed/unknown mode into local scheduling and forgets the verified hint on lock", async () => {
  expect(observedWorkspaceMode("workspace")).toBeNull(); expect(() => rememberVerifiedWorkspaceModes({} as never, { server: state.origin, userId: "owner" }, () => true)).toThrow();
  await seedPrivateWorkspaceClient(await privateRecoveryFixture()); await readPrivateDeviceAccessState("owner"); expect(observedWorkspaceMode("workspace")).toBe("encrypted"); expect(observedWorkspaceMode("foreign")).toBeNull(); session.lockPrivateData(); expect(observedWorkspaceMode("workspace")).toBeNull();
});

it("never rolls private favorites back into a new account after a late local mutation error", async () => {
  const f = await privateRecoveryFixture(), stamp = "2026-10-27T00:00:00.000Z";
  f.archive.replica.pending[1]!.records.push({ kind: "favorites", id: "old-pin", authorId: "owner", value: { _id: "old-pin", workspaceId: "workspace", userId: "owner", description: "Old private previous pin", projectId: null, taskId: null, billable: false, order: 0, createdAt: stamp, updatedAt: stamp } });
  await seedPrivateWorkspaceClient(f); await readPrivateDeviceAccessState("owner"); await confirmStandardDeviceAccess({ server: state.origin, userId: "other" }, () => true);
  const app = wrapper(), view = renderHook(() => useQuickStarts(), { wrapper: app.render }); await waitFor(() => expect(view.result.current.favorites).toHaveLength(1));
  let enter!: () => void, reject!: (error: Error) => void; const entered = new Promise<void>((resolve) => { enter = resolve; });
  const dispatcher = await import("@/lib/private-workspace-mutation");
  vi.spyOn(dispatcher, "mutatePrivateWorkspace").mockImplementationOnce(async () => { enter(); return new Promise((_resolve, fail) => { reject = fail; }); });
  let switched = false; const staleWrites: unknown[] = [], write = app.queryClient.setQueryData.bind(app.queryClient);
  vi.spyOn(app.queryClient, "setQueryData").mockImplementation(((...args: Parameters<typeof write>) => { const result = write(...args); if (switched && String(JSON.stringify(result)).includes("Old private previous pin")) staleWrites.push(result); return result; }) as typeof write);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{ result: { data: [] } }]), { headers: { "content-type": "application/json" } })));
  act(() => view.result.current.pin({ description: "New pending pin", projectId: null, taskId: null, billable: false })); await entered; const mutation = app.queryClient.getMutationCache().getAll()[0]!;
  await act(async () => { switched = true; session.privateAccountChanged("other"); reject(new Error("Synthetic local save failure")); }); await waitFor(() => expect(mutation.state.status).toBe("error"));
  expect(staleWrites).toEqual([]); expect(state.error).not.toHaveBeenCalled(); view.unmount(); app.queryClient.clear();
});

it("opens cold private queries from the encrypted replica while offline", async () => {
  await seedPrivateWorkspaceClient(await privateRecoveryFixture()); await readPrivateDeviceAccessState("owner");
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Offline read attempted HTTP"); }));
  const app = wrapper(); onlineManager.setOnline(false);
  const view = renderHook(() => trpc.tags.list.useQuery({ includeArchived: true }), { wrapper: app.render });
  await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
  expect(view.result.current.data).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Unsent private rename" })]));
  expect(fetch).not.toHaveBeenCalled(); expect(app.queryClient.getQueryDefaults([["tags", "list"]]).staleTime).toBe(60_000);
  view.unmount(); app.queryClient.clear();
});
it("remounts private filters before a standard workspace can send them", async () => {
  const f = await privateRecoveryFixture();
  f.enrollment = await signPrivateAccountInventory({ server: state.origin, userId: "owner", workspaces: [...f.enrollment.inventory.workspaces, { workspaceId: "standard", mode: "standard" }], previous: null, signingPrivateKey: f.secrets.signingPrivateKey, current: f.current });
  await seedPrivateWorkspaceClient(f); await readPrivateDeviceAccessState("owner");
  const app = wrapper();
  const fetcher = vi.fn(async () => new Response(JSON.stringify([{ result: { data: [] } }]), { headers: { "content-type": "application/json" } })); vi.stubGlobal("fetch", fetcher);
  const Boundary = ({ children }: { children: React.ReactNode }) => {
    const epoch = React.useSyncExternalStore(subscribePrivateViewEpoch, privateViewEpoch, () => "0");
    return <app.render><React.Fragment key={epoch}>{children}</React.Fragment></app.render>;
  };
  const view = renderHook(() => { const [filter, setFilter] = React.useState(""); const query = trpc.entries.descriptions.useQuery({ search: filter }); return { filter, setFilter, query }; }, { wrapper: Boundary });
  await waitFor(() => expect(view.result.current.query.isSuccess).toBe(true));
  act(() => view.result.current.setFilter("Private account secret search"));
  await waitFor(() => expect(view.result.current.query.isSuccess).toBe(true));
  act(() => { state.active = { activeId: "standard", workspaces: null }; for (const listener of state.listeners) listener(); });
  await waitFor(() => expect(view.result.current.filter).toBe(""));
  await waitFor(() => expect(fetcher).toHaveBeenCalled());
  for (const [url] of fetcher.mock.calls as unknown as [RequestInfo | URL][]) expect(decodeURIComponent(String(url))).not.toContain("Private account secret search");
  expect(app.queryClient.getQueryDefaults([["entries", "descriptions"]]).networkMode).toBe("online");
  view.unmount(); app.queryClient.clear();
});

it("keeps the actual manual-entry form save offline and reports encrypted local ownership honestly", async () => {
  await seedPrivateWorkspaceClient(await privateManualEntryFixture()); await readPrivateDeviceAccessState("owner");
  const fetcher = vi.fn(() => { throw new Error("Private manual form must not use HTTP"); }); vi.stubGlobal("fetch", fetcher);
  const { useEntryMutations } = await import("@/components/tracker/use-entry-mutations"), app = wrapper(); onlineManager.setOnline(false);
  const view = renderHook(() => useEntryMutations(), { wrapper: app.render });
  let saved!: Awaited<ReturnType<typeof view.result.current.createManualEntry>>;
  await act(async () => { saved = await view.result.current.createManualEntry({ description: "Private form hour", projectId: null, billable: true, start: "2026-10-27T10:00:00.000Z", end: "2026-10-27T11:00:00.000Z" }); });
  expect(saved).toMatchObject({ ok: true, saved: "private", entry: { description: "Private form hour", hourlyRate: 60, durationSec: 3600 } });
  expect(fetcher).not.toHaveBeenCalled(); expect(state.error).not.toHaveBeenCalled(); view.unmount(); app.queryClient.clear();
});

it("does not return decrypted manual time after locking during the terminal mutation callback", async () => {
  await seedPrivateWorkspaceClient(await privateManualEntryFixture()); await readPrivateDeviceAccessState("owner");
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Private form must stay local"); }));
  const { useEntryMutations } = await import("@/components/tracker/use-entry-mutations"), app = wrapper();
  const unsubscribe = app.queryClient.getMutationCache().subscribe((event) => { if (event.type === "updated" && event.action.type === "success") session.lockPrivateData(); });
  const view = renderHook(() => useEntryMutations(), { wrapper: app.render }); let saved!: Awaited<ReturnType<typeof view.result.current.createManualEntry>>;
  await act(async () => { saved = await view.result.current.createManualEntry({ description: "Do not return while locked", projectId: null, billable: false, start: "2026-10-27T10:00:00.000Z", end: "2026-10-27T11:00:00.000Z" }); });
  expect(saved.ok).toBe(false); expect(JSON.stringify(saved)).not.toContain("Do not return while locked");
  unsubscribe(); view.unmount(); app.queryClient.clear();
});

it("keeps an old optimistic draft out of cache when device policy changes without an account change", async () => {
  await seedPrivateWorkspaceClient(await privateRecoveryFixture()); await readPrivateDeviceAccessState("owner");
  const app = wrapper(), view = renderHook(() => useQuickStarts(), { wrapper: app.render }); await waitFor(() => expect(view.result.current.isLoading).toBe(false));
  let enter!: () => void, resume!: () => void; const entered = new Promise<void>((resolve) => { enter = resolve; });
  vi.spyOn(app.queryClient, "cancelQueries").mockImplementationOnce(async () => { enter(); await new Promise<void>((resolve) => { resume = resolve; }); });
  const writes: unknown[] = [], write = app.queryClient.setQueryData.bind(app.queryClient);
  vi.spyOn(app.queryClient, "setQueryData").mockImplementation(((...args: Parameters<typeof write>) => { const result = write(...args); if (String(JSON.stringify(result)).includes("Old policy draft")) writes.push(result); return result; }) as typeof write);
  act(() => view.result.current.pin({ description: "Old policy draft", projectId: null, taskId: null, billable: false })); await entered;
  const mutation = app.queryClient.getMutationCache().getAll()[0]!, { requirePrivateRouting } = await import("@/lib/private-routing-requirement");
  await act(async () => { await requirePrivateRouting({ server: state.origin, userId: "owner" }, () => true, true); resume(); });
  await waitFor(() => expect(mutation.state.status).toBe("error")); expect(writes).toEqual([]); expect(state.error).not.toHaveBeenCalled(); view.unmount(); app.queryClient.clear();
});
