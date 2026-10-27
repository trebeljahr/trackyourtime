// @vitest-environment jsdom
import { IDBFactory } from "fake-indexeddb";
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { privateRecoveryFixture, seedPrivateWorkspaceClient } from "@/test-private-recovery";
const state = vi.hoisted(() => ({ origin: "https://api.example.test", native: false, dropWrites: false, values: new Map<string, string>() }));
vi.mock("./api-origin", () => ({ getApiOrigin: () => state.origin, subscribeApiOrigin: () => () => {}, whenApiOriginReady: async () => {} }));
vi.mock("./desktop-activity", () => ({ desktopActivity: () => null }));
vi.mock("./server-level", () => ({ currentServerApiLevel: () => 34 }));
vi.mock("./native-session", () => ({ getNativeToken: () => null }));
vi.mock("./shell", () => ({ clientId: () => "web", isCapacitor: () => state.native }));
vi.mock("./app-version", () => ({ APP_VERSION: "test" }));
vi.mock("@/mobile/preferences-storage", () => ({ preferencesStorage: () => ({ getItem: async (key: string) => state.values.get(key) ?? null, setItem: async (key: string, value: string) => { if (!state.dropWrites) state.values.set(key, value); }, removeItem: async (key: string) => { state.values.delete(key); } }) }));
const session = await import("./private-session");
const { standardDeviceAccess, requireStandardDeviceAccess, confirmStandardDeviceAccess, privateDeviceAccessRevision } = await import("./private-device-access");
const { requirePrivateRouting } = await import("./private-routing-requirement");
const { readPrivateDeviceAccessState } = await import("./private-device-access-state");
const { workspaceContentRoute } = await import("./private-content-route");
const { readWorkspaceList } = await import("./private-workspace-list");
const scope = { server: "https://api.example.test", userId: "owner" };
beforeEach(() => { vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("indexedDB", new IDBFactory()); localStorage.clear(); state.native = false; state.dropWrites = false; state.values.clear(); state.origin = scope.server; session.lockPrivateData(); session.privateAccountChanged("owner"); });
afterEach(() => { session.lockPrivateData(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("keeps unknown devices closed despite cached names or a server's mode claims, until an explicit local choice", async () => {
  localStorage.setItem("trackyourtime.known-workspaces", JSON.stringify({ ...scope, workspaces: [{ id: "workspace", mode: "standard", name: "Server claim" }], names: {} }));
  expect(await readPrivateDeviceAccessState("owner")).toBe("unknown");
  await expect(workspaceContentRoute("owner", "workspace")).rejects.toThrow("confirm standard storage");
  const transport = vi.fn(async () => [{ id: "workspace", mode: "standard" }] as never); await expect(readWorkspaceList(transport)).rejects.toThrow("confirm standard storage"); expect(transport).not.toHaveBeenCalled();
  await confirmStandardDeviceAccess(scope, () => true); expect(await standardDeviceAccess(scope)).toBe(true); expect(await readPrivateDeviceAccessState("owner")).toBe("standard");
  expect((await workspaceContentRoute("owner", "workspace")).mode).toBe("standard"); expect(await standardDeviceAccess({ ...scope, userId: "other" })).toBe(false); expect(await standardDeviceAccess({ ...scope, server: "https://foreign.test" })).toBe(false);
});
it("never downgrades private routing when an earlier standard choice exists", async () => {
  await confirmStandardDeviceAccess(scope, () => true); await requirePrivateRouting(scope, () => true);
  await expect(requireStandardDeviceAccess(scope)).rejects.toThrow("Unlock private data"); await expect(confirmStandardDeviceAccess(scope, () => true)).rejects.toThrow("instead of choosing standard");
  expect(await readPrivateDeviceAccessState("owner")).toBe("locked");
});
it("requires a verified local inventory even after keys unlock; restored inventory opens the gate", async () => {
  const f = await privateRecoveryFixture(); await session.unlockPrivateRecovery("owner", { ...f.identity, passkeys: [] }, f.recoveryKey);
  expect(await readPrivateDeviceAccessState("owner")).toBe("inventory"); await expect(workspaceContentRoute("owner", "workspace")).rejects.toThrow("inventory is missing");
  await seedPrivateWorkspaceClient(f); expect(await readPrivateDeviceAccessState("owner")).toBe("ready");
});
it("rejects ignored native writes, malformed choices and unavailable storage without opening standard transport", async () => {
  state.native = true; state.dropWrites = true; await expect(confirmStandardDeviceAccess(scope, () => true)).rejects.toThrow("confirm this device"); expect(await standardDeviceAccess(scope)).toBe(false);
  state.dropWrites = false; await confirmStandardDeviceAccess(scope, () => true); expect(await standardDeviceAccess(scope)).toBe(true);
  const key = [...state.values.keys()][0]!; state.values.set(key, "corrupt"); await expect(standardDeviceAccess(scope)).rejects.toThrow("could not be verified"); await expect(confirmStandardDeviceAccess(scope, () => true)).rejects.toThrow("could not be verified");
  state.native = false; vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Storage denied"); }); await expect(readPrivateDeviceAccessState("owner")).rejects.toThrow("Storage denied");
});
it("refuses a stale choice before writing it and invalidates in-flight standard routes on cross-tab storage changes", async () => {
  await expect(confirmStandardDeviceAccess(scope, () => false)).rejects.toThrow("account changed"); expect(await standardDeviceAccess(scope)).toBe(false);
  await confirmStandardDeviceAccess(scope, () => true); const route = await workspaceContentRoute("owner", "workspace"), before = privateDeviceAccessRevision();
  window.dispatchEvent(new StorageEvent("storage", { key: null })); expect(privateDeviceAccessRevision()).toBeGreaterThan(before); expect(() => route.check()).toThrow("policy changed");
});
