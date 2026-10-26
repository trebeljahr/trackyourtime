// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { API_LEVEL, normalizeDisplayPreferences } from "@starter/shared";
const state = vi.hoisted(() => ({ level: 33 as number | null, fetch: vi.fn() }));
vi.mock("./api-origin", () => ({ getApiOrigin: () => "https://api.example.test", subscribeApiOrigin: () => () => {} }));
vi.mock("./desktop-activity", () => ({ desktopActivity: () => null }));
vi.mock("./shell", () => ({ isCapacitor: () => false }));
vi.mock("./server-level", () => ({ currentServerApiLevel: () => state.level }));
vi.mock("./private-scoped-rpc", () => ({ privateScopedRpc: (_userId: string, capability: string) => { expect(capability).toBe("profile.displayPreferences"); return { supported: () => {}, rpc: { profile: { displayPreferences: { query: state.fetch } } } }; } }));
const session = await import("./private-session");
const { privateDisplayPreferences } = await import("./private-display-preferences");
const { privateDatabaseName } = await import("./private-indexed-storage");
const preferences = () => normalizeDisplayPreferences("owner", { theme: "dark", timeFormat: "12h", maxDuration: { maxHours: 0 } });
async function rawStore() {
 const name = await privateDatabaseName({ server: "https://api.example.test", userId: "owner" });
 return new Promise<string>((resolve, reject) => { const open = indexedDB.open(name); open.onerror = () => reject(open.error); open.onsuccess = () => { const db = open.result, tx = db.transaction("ciphertext"), request = tx.objectStore("ciphertext").getAll(); request.onsuccess = () => { const raw = JSON.stringify(request.result); db.close(); resolve(raw); }; request.onerror = () => { db.close(); reject(request.error); }; }; });
}
beforeEach(async () => { vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("indexedDB", new IDBFactory()); session.lockPrivateData(); session.privateAccountChanged("owner"); const draft = await session.newPrivateIdentity("owner"); session.installPrivateSession("owner", draft.secrets); state.level = API_LEVEL; state.fetch.mockReset().mockImplementation(async () => preferences()); });
afterEach(() => { session.lockPrivateData(); vi.unstubAllGlobals(); });
it("stores only encrypted account rendering preferences and reopens them offline without a standard workspace read", async () => {
 expect(await privateDisplayPreferences("owner")).toEqual(preferences()); const raw = await rawStore(); expect(raw).not.toContain('"theme":"dark"'); expect(raw).not.toContain('"timeFormat"');
 state.fetch.mockRejectedValue(new TypeError("Failed to fetch")); expect(await privateDisplayPreferences("owner")).toEqual(preferences());
 state.level = null; state.fetch.mockClear(); expect(await privateDisplayPreferences("owner")).toEqual(preferences()); expect(state.fetch).not.toHaveBeenCalled(); session.lockPrivateData(); await expect(privateDisplayPreferences("owner")).rejects.toThrow("changed"); expect(await rawStore()).toBe(raw);
});
it("refuses unsupported cold servers, wrong accounts and workspace money in a metadata response", async () => {
 state.level = 32; await expect(privateDisplayPreferences("owner")).rejects.toThrow("separate account preferences"); expect(state.fetch).not.toHaveBeenCalled(); state.level = API_LEVEL;
 state.fetch.mockResolvedValue(normalizeDisplayPreferences("other")); await expect(privateDisplayPreferences("owner")).rejects.toThrow("another account");
 state.fetch.mockResolvedValue({ ...preferences(), currency: "USD", defaultHourlyRate: 999 }); await expect(privateDisplayPreferences("owner")).rejects.toThrow();
});
it("keeps the valid cached copy on authorization or malformed-response errors without treating them as offline", async () => {
 await privateDisplayPreferences("owner"); const raw = await rawStore();
 state.fetch.mockRejectedValue(Object.assign(new Error("No access"), { data: { code: "UNAUTHORIZED" }, cause: new TypeError("Offline") })); await expect(privateDisplayPreferences("owner")).rejects.toThrow("No access");
 state.fetch.mockResolvedValue({ ...preferences(), theme: "invalid" }); await expect(privateDisplayPreferences("owner")).rejects.toThrow(); expect(await rawStore()).toBe(raw);
});
it("does not return or save a late preferences response after locking", async () => {
 await privateDisplayPreferences("owner"); const raw = await rawStore(); state.fetch.mockImplementation(async () => { session.lockPrivateData(); return { ...preferences(), theme: "light" }; });
 await expect(privateDisplayPreferences("owner")).rejects.toThrow("changed"); expect(await rawStore()).toBe(raw);
});
