// @vitest-environment jsdom
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { webcrypto } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { API_LEVEL } from "@starter/shared";
const state = vi.hoisted(() => ({ origin: "https://api.example.test", level: null as number | null, rows: [{ id: "workspace", name: "Original workspace name" }] as unknown }));
vi.mock("./api-origin", () => ({ getApiOrigin: () => state.origin, subscribeApiOrigin: () => () => {}, whenApiOriginReady: async () => {} }));
vi.mock("./desktop-activity", () => ({ desktopActivity: () => null }));
vi.mock("./server-level", () => ({ currentServerApiLevel: () => state.level }));
vi.mock("./native-session", () => ({ getNativeToken: () => null }));
vi.mock("./shell", () => ({ clientId: () => "web", isCapacitor: () => false }));
vi.mock("./app-version", () => ({ APP_VERSION: "test" }));
const session = await import("./private-session");
const { preparePrivateAccountSetup, finishPrivateAccountSetup } = await import("./private-account-setup");
const { privateAccountInventoryStorageHost } = await import("./private-replica");
const { privateAccountWorkspaceInventorySync } = await import("./private-inventory-sync");
const { stagePrivateAccountInventory } = await import("./private-inventory-staging");
const { workspaceContentRoute } = await import("./private-content-route");
const { privateRoutingRequired, requirePrivateRouting } = await import("./private-routing-requirement");
beforeEach(() => { vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("indexedDB", new IDBFactory()); localStorage.clear(); state.origin = "https://api.example.test"; state.level = API_LEVEL; state.rows = [{ id: "workspace", name: "Original workspace name" }]; session.lockPrivateData(); session.privateAccountChanged("owner"); });
afterEach(() => { session.lockPrivateData(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function fixture() {
  const enrollments: unknown[] = [];
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(new URL(String(url)).origin).toBe(state.origin); expect(init?.cache).toBe("no-store"); expect(init?.redirect).toBe("error");
    let data;
    if (String(url).includes("/workspaces.list")) data = state.rows;
    else { expect(String(url)).toMatch(/privacy.enroll$/); expect(init?.method).toBe("POST"); enrollments.push(JSON.parse(String(init?.body))); data = { revision: 1 }; }
    return new Response(JSON.stringify({ result: { data } }), { headers: { "content-type": "application/json" } });
  }); vi.stubGlobal("fetch", fetcher); return { fetcher, enrollments };
}
it("prepares keys without activating them, then saves a signed standard inventory before publishing the root", async () => {
  const f = fixture(), draft = await preparePrivateAccountSetup("owner"); expect(session.privateSession("owner")).toBeNull(); expect(f.enrollments).toEqual([]);
  expect(await privateRoutingRequired({ server: state.origin, userId: "owner" })).toBe(false);
  await finishPrivateAccountSetup(draft); expect(session.privateSession("owner")).toEqual(draft.secrets);
  const host = await privateAccountInventoryStorageHost("owner");
  try { const sync = await privateAccountWorkspaceInventorySync("owner", host.storage, host.exclusive), profile = await sync.read(); expect(profile.inventory.signed.inventory.workspaces).toEqual([{ workspaceId: "workspace", mode: "standard" }]); expect(profile.pending).toBe(1); } finally { host.close(); }
  expect(f.enrollments).toHaveLength(1); expect(JSON.stringify(f.enrollments)).not.toMatch(/master|privateKey|Original workspace name/);
  expect((await workspaceContentRoute("owner", "workspace")).mode).toBe("standard");
  session.lockPrivateData(); await session.unlockPrivateRecovery("owner", draft.identity, draft.recoveryKey); expect((await workspaceContentRoute("owner", "workspace")).mode).toBe("standard");
  await expect(finishPrivateAccountSetup(draft)).rejects.toThrow("original prepared");
});
it("retries the original identity after a lost enrollment reply without creating replacement keys", async () => {
  const f = fixture(), draft = await preparePrivateAccountSetup("owner"), base = f.fetcher.getMockImplementation()!;
  f.fetcher.mockImplementationOnce(async (...args) => { await base(...args); throw new TypeError("Reply lost"); });
  await expect(finishPrivateAccountSetup(draft)).rejects.toThrow("Reply lost"); expect(session.privateSession("owner")).toBeNull();
  await finishPrivateAccountSetup(draft); expect(f.enrollments).toHaveLength(2); expect(f.enrollments[1]).toEqual(f.enrollments[0]);
});
it("keeps keys inactive on failed durable writes and retries the same prepared setup", async () => {
  fixture(); const draft = await preparePrivateAccountSetup("owner");
  const write = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementationOnce(() => { throw new Error("Disk full"); });
  await expect(finishPrivateAccountSetup(draft)).rejects.toThrow(); expect(session.privateSession("owner")).toBeNull(); write.mockRestore();
  await finishPrivateAccountSetup(draft); expect(session.privateSession("owner")).toEqual(draft.secrets);
});
it("preserves the exact saved pending inventory after failed routing-marker readback, and resumes without replacement", async () => {
  fixture(); const draft = await preparePrivateAccountSetup("owner"), original = Storage.prototype.setItem;
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) { if (!key.startsWith("trackyourtime.private-routing-required:")) original.call(this, key, value); });
  await expect(finishPrivateAccountSetup(draft)).rejects.toThrow("confirm private routing"); expect(session.privateSession("owner")).toBeNull(); write.mockRestore();
  const staged = await stagePrivateAccountInventory({ server: state.origin, userId: "owner" }, draft.secrets, draft.assertCurrent);
  const before = await staged.exportRecovery(); staged.close(); await finishPrivateAccountSetup(draft);
  const host = await privateAccountInventoryStorageHost("owner");
  try { const sync = await privateAccountWorkspaceInventorySync("owner", host.storage, host.exclusive); expect(await sync.exportRecovery()).toEqual(before); } finally { host.close(); }
});
it("refuses ambiguous/oversized metadata, unknown server support and replacement setup for protected accounts", async () => {
  const f = fixture(); state.rows = [{ id: "same" }, { id: "same" }]; await expect(preparePrivateAccountSetup("owner")).rejects.toThrow("ambiguous");
  state.rows = Array.from({ length: 1001 }, (_, i) => ({ id: String(i) })); await expect(preparePrivateAccountSetup("owner")).rejects.toThrow("could not be verified");
  state.level = null; f.fetcher.mockClear(); await expect(preparePrivateAccountSetup("owner")).rejects.toThrow("supports this encrypted"); expect(f.fetcher).not.toHaveBeenCalled();
  state.level = API_LEVEL; await requirePrivateRouting({ server: state.origin, userId: "owner" }, () => true); await expect(preparePrivateAccountSetup("owner")).rejects.toThrow("instead of creating replacement"); expect(f.enrollments).toEqual([]);
});
it.each(["account", "server", "unlock"])("rejects a prepared setup after a %s change, before enrolling anything", async (change) => {
  const f = fixture(), draft = await preparePrivateAccountSetup("owner");
  if (change === "account") session.privateAccountChanged("other");
  if (change === "server") state.origin = "https://foreign.test";
  if (change === "unlock") session.installPrivateSession("owner", draft.secrets);
  await expect(finishPrivateAccountSetup(draft)).rejects.toThrow(); expect(f.enrollments).toEqual([]);
});
