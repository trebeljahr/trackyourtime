// @vitest-environment jsdom
import { IDBFactory } from "fake-indexeddb";
import { webcrypto } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { permissionsFor, type WorkspaceSummary } from "@starter/core";
import { privateRecoveryFixture, seedPrivateWorkspaceClient } from "@/test-private-recovery";
const state = vi.hoisted(() => ({ origin: "https://api.example.test", changed: null as (() => void) | null, owner: "owner", activeId: "workspace", workspaces: [] as WorkspaceSummary[] }));
vi.mock("./api-origin", () => ({ getApiOrigin: () => state.origin, subscribeApiOrigin: (fn: () => void) => { state.changed = fn; return () => {}; }, whenApiOriginReady: async () => {} }));
vi.mock("./active-workspace", () => ({ getKnownWorkspacesOwner: () => state.owner, getActiveWorkspaceSnapshot: () => ({ activeId: state.activeId, workspaces: state.workspaces }) }));
vi.mock("./desktop-activity", () => ({ desktopActivity: () => null }));
vi.mock("./server-level", () => ({ currentServerApiLevel: () => 34 }));
vi.mock("./native-session", () => ({ getNativeToken: () => null }));
vi.mock("./shell", () => ({ clientId: () => "web", isCapacitor: () => false }));
vi.mock("./app-version", () => ({ APP_VERSION: "test" }));
const session = await import("./private-session");
const { privateAccountInventoryStorageHost } = await import("./private-replica");
const { privateAccountWorkspaceInventorySync } = await import("./private-inventory-sync");
const { readWorkspaceList } = await import("./private-workspace-list");
const { confirmStandardDeviceAccess } = await import("./private-device-access");
const row = (id: string): WorkspaceSummary => ({ id, name: "Injected server name", kind: "personal", role: "admin", memberCount: 999, isDefault: false, permissions: permissionsFor("owner", { canViewOthersTime: true, canViewOthersMoney: true }) });
beforeEach(() => { vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("indexedDB", new IDBFactory()); localStorage.clear(); state.origin = "https://api.example.test"; state.owner = "owner"; state.activeId = "workspace"; state.workspaces = [row("workspace"), row("standard")]; session.lockPrivateData(); session.privateAccountChanged("owner"); });
afterEach(() => { session.lockPrivateData(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function fixture(mixed = false) {
  const f = await privateRecoveryFixture();
  f.archive.replica.pending[1]!.records.push({ kind: "workspaceIdentity", id: "organization", authorId: null, value: { workspaceId: "workspace", organization: { _id: "workspace", name: "Original private studio", kind: "team" } } });
  await seedPrivateWorkspaceClient(f);
  if (mixed) await update([...f.enrollment.inventory.workspaces, { workspaceId: "standard", mode: "standard" }]);
  return f;
}
async function update(rows: Parameters<Awaited<ReturnType<typeof privateAccountWorkspaceInventorySync>>["update"]>[0]) {
  const host = await privateAccountInventoryStorageHost("owner");
  try { const sync = await privateAccountWorkspaceInventorySync("owner", host.storage, host.exclusive); await sync.update(rows); } finally { host.close(); }
}
it("loads all-private navigation entirely offline, from verified identity and membership, with no public cache dependency", async () => {
  await fixture(); state.owner = "other"; state.workspaces = [];
  const transport = vi.fn(), result = await readWorkspaceList(transport);
  expect(result).toMatchObject([{ id: "workspace", name: "Original private studio", kind: "team", role: "owner", memberCount: 1, isDefault: true, permissions: { inviteAdmins: true } }]); expect(transport).not.toHaveBeenCalled();
});
it("keeps private rows despite server omission and discards every injected private display or permission field", async () => {
  await fixture(true); const transport = vi.fn(async () => [row("standard"), row("workspace")]);
  expect(await readWorkspaceList(transport)).toMatchObject([{ id: "standard", name: "Injected server name", isDefault: false }, { id: "workspace", name: "Original private studio", kind: "team", role: "owner", memberCount: 1, isDefault: true }]);
  transport.mockResolvedValue([row("standard")]); expect(await readWorkspaceList(transport)).toHaveLength(2);
  transport.mockResolvedValue([row("new-unknown")]); await expect(readWorkspaceList(transport)).rejects.toThrow("could not be verified");
});
it("uses cached standard navigation only for a transport failure, preserving auth and application refusals", async () => {
  await fixture(true); const transport = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
  expect(await readWorkspaceList(transport)).toMatchObject([{ id: "standard" }, { name: "Original private studio" }]);
  const denied = Object.assign(new TypeError("Denied"), { data: { code: "UNAUTHORIZED" } }); transport.mockRejectedValue(denied);
  await expect(readWorkspaceList(transport)).rejects.toBe(denied);
  state.owner = "other"; transport.mockRejectedValue(new TypeError("Offline")); await expect(readWorkspaceList(transport)).rejects.toThrow("Offline");
});
it("shows only generic navigation with no authority while locked, never requesting server names", async () => {
  await fixture(); session.lockPrivateData(); const transport = vi.fn();
  const result = await readWorkspaceList(transport); expect(result.map((r) => r.name)).toEqual(["Workspace", "Workspace"]);
  expect(result.every((r) => r.role === "member" && r.memberCount === 0 && Object.values(r.permissions).every((flag) => flag === false))).toBe(true); expect(transport).not.toHaveBeenCalled();
});
it("preserves explicitly confirmed standard transport and refuses missing required inventory", async () => {
  await confirmStandardDeviceAccess({ server: state.origin, userId: "owner" }, () => true);
  const transport = vi.fn(async () => [row("standard")]); expect(await readWorkspaceList(transport)).toEqual([row("standard")]);
  const f = await fixture(); vi.stubGlobal("indexedDB", new IDBFactory()); session.lockPrivateData(); session.installPrivateSession("owner", f.secrets);
  transport.mockClear(); await expect(readWorkspaceList(transport)).rejects.toThrow("could not be verified"); expect(transport).not.toHaveBeenCalled();
});
it.each(["lock", "account", "server", "inventory"])("refuses a late mixed list after a %s change", async (change) => {
  const f = await fixture(true); let resume!: (rows: WorkspaceSummary[]) => void, enter!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const pending = readWorkspaceList(() => { enter(); return new Promise((resolve) => { resume = resolve; }); }); await entered;
  if (change === "lock") { session.lockPrivateData(); session.installPrivateSession("owner", f.secrets); }
  if (change === "account") session.privateAccountChanged("other");
  if (change === "server") { state.origin = "https://foreign.test"; state.changed?.(); }
  if (change === "inventory") await update([...f.enrollment.inventory.workspaces, { workspaceId: "standard", mode: "standard" }, { workspaceId: "new", mode: "standard" }]);
  resume([row("standard")]); await expect(pending).rejects.toMatchObject({ privateContentRefusal: true });
});
it("cancels an unresolved account lookup and never dispatches anonymous navigation", async () => {
  state.changed?.(); const abort = new AbortController(), transport = vi.fn(), pending = readWorkspaceList(transport, abort.signal); abort.abort(new Error("Canceled"));
  await expect(pending).rejects.toThrow("Canceled"); session.privateAccountChanged(null); await expect(readWorkspaceList(transport)).rejects.toThrow("Sign in"); expect(transport).not.toHaveBeenCalled();
});
