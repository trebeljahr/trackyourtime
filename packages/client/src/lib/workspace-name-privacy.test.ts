// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { ACTIVE_WORKSPACE_STORAGE_KEY, permissionsFor, type WorkspaceSummary } from "@starter/core";
const state = vi.hoisted(() => ({ native: false, rows: new Map<string, string>(), reject: false, discard: false }));
vi.mock("./shell", () => ({ isCapacitor: () => state.native, isElectron: () => false, isTokenShell: () => state.native }));
vi.mock("./api-origin", () => ({ getApiOrigin: () => "https://api.example.test", getAbsoluteApiOrigin: () => "https://api.example.test", whenApiOriginReady: async () => {}, subscribeApiOrigin: () => () => {} }));
vi.mock("@capacitor/preferences", () => ({ Preferences: {
  get: async ({ key }: { key: string }) => ({ value: state.rows.get(key) ?? null }),
  set: async ({ key, value }: { key: string; value: string }) => { if (state.reject) throw new Error("Storage unavailable"); if (!state.discard) state.rows.set(key, value); },
  remove: async ({ key }: { key: string }) => { if (state.reject) throw new Error("Storage unavailable"); state.rows.delete(key); },
} }));
const active = await import("./active-workspace");
const session = await import("./private-session");
const { requirePrivateRouting, privateRoutingRequired } = await import("./private-routing-requirement");
const { KNOWN_WORKSPACES_STORAGE_KEY, eraseStoredWorkspaceNames } = await import("./workspace-name-privacy");
const scope = { server: "https://api.example.test", userId: "owner" };
const row = (id: string, name: string, isDefault = false): WorkspaceSummary => ({ id, name, role: "owner", kind: "team", memberCount: 1, isDefault, permissions: permissionsFor("owner", { canViewOthersTime: true, canViewOthersMoney: true }) });
const stored = () => JSON.stringify({ ...scope, workspaces: [row("workspace", "Private studio", true)], names: { gone: "Private former client" } });
beforeEach(() => { vi.stubGlobal("crypto", webcrypto); state.native = false; state.reject = false; state.discard = false; state.rows.clear(); localStorage.clear(); session.lockPrivateData(); session.privateAccountChanged("owner"); active.__resetActiveWorkspaceForTests(); });
afterEach(() => { session.lockPrivateData(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("cleans current/historical names before private routing enrollment and preserves navigation ids", async () => {
  await active.applyWorkspaceList([row("workspace", "Private studio", true), row("gone", "Private former client")], "owner");
  await active.applyWorkspaceList([row("workspace", "Private studio", true)], "owner");
  expect(active.workspaceNameFor("gone")).toBe("Private former client");
  await requirePrivateRouting(scope, () => true);
  const raw = localStorage.getItem(KNOWN_WORKSPACES_STORAGE_KEY)!;
  expect(raw).not.toContain("Private studio"); expect(raw).not.toContain("Private former client");
  expect(active.workspaceNameFor("workspace")).toBe("Workspace"); expect(active.workspaceNameFor("gone")).toBe("Workspace");
  expect(active.getActiveWorkspaceId()).toBe("workspace"); expect(localStorage.getItem(ACTIVE_WORKSPACE_STORAGE_KEY)).toBe("workspace"); expect(await privateRoutingRequired(scope)).toBe(true);
});
it("keeps unlocked names in memory only, conceals them on lock and hydrates safely after restart", async () => {
  const root = await session.newPrivateIdentity("owner"); session.installPrivateSession("owner", root.secrets);
  await requirePrivateRouting(scope, () => true); await active.applyWorkspaceList([row("workspace", "Only while unlocked", true)], "owner");
  expect(active.workspaceNameFor("workspace")).toBe("Only while unlocked"); expect(localStorage.getItem(KNOWN_WORKSPACES_STORAGE_KEY)).not.toContain("Only while unlocked");
  session.lockPrivateData(); expect(active.workspaceNameFor("workspace")).toBe("Workspace");
  // Simulate a crash after an older marker write but before its old cache was cleaned.
  localStorage.setItem(KNOWN_WORKSPACES_STORAGE_KEY, stored()); active.__resetActiveWorkspaceForTests();
  expect(active.workspaceNameFor("workspace")).toBe("Workspace"); await active.whenActiveWorkspaceReady();
  expect(localStorage.getItem(KNOWN_WORKSPACES_STORAGE_KEY)).not.toContain("Private studio"); expect(active.getActiveWorkspaceId()).toBe("workspace");
});
it("keeps standard/foreign account behavior and serializes cleanup with a concurrent list write", async () => {
  await active.applyWorkspaceList([row("workspace", "Standard name", true)], "owner");
  await requirePrivateRouting({ ...scope, userId: "other" }, () => true);
  expect(active.workspaceNameFor("workspace")).toBe("Standard name"); expect(localStorage.getItem(KNOWN_WORKSPACES_STORAGE_KEY)).toContain("Standard name");
  await Promise.all([requirePrivateRouting(scope, () => true), active.applyWorkspaceList([row("workspace", "Concurrent private name", true)], "owner")]);
  expect(localStorage.getItem(KNOWN_WORKSPACES_STORAGE_KEY)).not.toContain("Concurrent private name");
});
it("whitelists public cache fields and removes malformed disposable data without touching pending entries", async () => {
  const raw = JSON.parse(stored()); raw.secret = "Unrecognized private text"; raw.workspaces[0].slug = "private-slug"; raw.workspaces[0].permissions.privateNote = "Private nested note";
  localStorage.setItem(KNOWN_WORKSPACES_STORAGE_KEY, JSON.stringify(raw)); localStorage.setItem("trackyourtime.offline-queue", "keep pending work byte-for-byte");
  await requirePrivateRouting(scope, () => true);
  expect(localStorage.getItem(KNOWN_WORKSPACES_STORAGE_KEY)).not.toMatch(/Unrecognized|private-slug|Private nested note/);
  localStorage.setItem(KNOWN_WORKSPACES_STORAGE_KEY, "malformed private cache"); await eraseStoredWorkspaceNames(scope, () => true);
  expect(localStorage.getItem(KNOWN_WORKSPACES_STORAGE_KEY)).toBeNull(); expect(localStorage.getItem("trackyourtime.offline-queue")).toBe("keep pending work byte-for-byte");
});
it("cleans both native Preferences and legacy WebKit storage before a later migration can resurrect names", async () => {
  state.native = true; state.rows.set(KNOWN_WORKSPACES_STORAGE_KEY, stored()); state.rows.set(ACTIVE_WORKSPACE_STORAGE_KEY, "workspace"); localStorage.setItem(KNOWN_WORKSPACES_STORAGE_KEY, stored());
  await requirePrivateRouting(scope, () => true);
  expect(state.rows.get(KNOWN_WORKSPACES_STORAGE_KEY)).not.toContain("Private studio"); expect(localStorage.getItem(KNOWN_WORKSPACES_STORAGE_KEY)).not.toContain("Private studio");
  await active.whenActiveWorkspaceReady(); expect(active.workspaceNameFor("workspace")).toBe("Workspace"); expect(active.getActiveWorkspaceId()).toBe("workspace");
  expect(state.rows.get(KNOWN_WORKSPACES_STORAGE_KEY)).not.toContain("Private former client");
});
it("refuses incomplete cleanup/readback and stale scope rather than claiming privacy protection", async () => {
  localStorage.setItem(KNOWN_WORKSPACES_STORAGE_KEY, stored()); const original = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) { if (key !== KNOWN_WORKSPACES_STORAGE_KEY) original.call(this, key, value); });
  await expect(requirePrivateRouting(scope, () => true)).rejects.toThrow("confirm"); expect(await privateRoutingRequired(scope)).toBe(true);
  await expect(eraseStoredWorkspaceNames(scope, () => false)).rejects.toThrow("scope changed"); expect(localStorage.getItem(KNOWN_WORKSPACES_STORAGE_KEY)).toBe(stored());
});

it("requires native write confirmation even when the bridge silently drops a cleanup", async () => {
 state.native = true; await requirePrivateRouting(scope, () => true); state.rows.set(KNOWN_WORKSPACES_STORAGE_KEY, stored()); state.discard = true;
 await expect(requirePrivateRouting(scope, () => true)).rejects.toThrow("confirm"); expect(state.rows.get(KNOWN_WORKSPACES_STORAGE_KEY)).toBe(stored());
 state.discard = false; state.reject = true; await expect(requirePrivateRouting(scope, () => true)).rejects.toThrow("Storage unavailable"); expect(state.rows.get(KNOWN_WORKSPACES_STORAGE_KEY)).toBe(stored());
});
