// @vitest-environment jsdom
import { IDBFactory } from "fake-indexeddb";
import { webcrypto } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { privateRecoveryFixture } from "@/test-private-recovery";
const state = vi.hoisted(() => ({ origin: "https://api.example.test", changed: null as (() => void) | null }));
vi.mock("./api-origin", () => ({ getApiOrigin: () => state.origin, subscribeApiOrigin: (fn: () => void) => { state.changed = fn; return () => {}; }, whenApiOriginReady: async () => {} }));
vi.mock("./desktop-activity", () => ({ desktopActivity: () => null }));
vi.mock("./server-level", () => ({ currentServerApiLevel: () => 32 }));
vi.mock("./native-session", () => ({ getNativeToken: () => null, getNativeTokenRevision: () => 0 }));
vi.mock("./shell", () => ({ clientId: () => "web", isCapacitor: () => false }));
vi.mock("./app-version", () => ({ APP_VERSION: "test" }));
const session = await import("./private-session");
const { privateAccountInventoryStorageHost, privateWorkspaceStorageHost, privateDirectoryStore } = await import("./private-replica");
const { privateAccountWorkspaceInventorySync } = await import("./private-inventory-sync");
const { forgetWorkspaceContentRoutes, workspaceContentRoute, currentWorkspaceContentRoute, readPrivateWorkspaceQuery, assertStandardContentRequest, isWorkspaceContentProcedure, assertStandardWorkspaceContent } = await import("./private-content-route");
const { privateRoutingRequired, requirePrivateRouting } = await import("./private-routing-requirement");
const { confirmStandardDeviceAccess } = await import("./private-device-access");
beforeEach(() => { forgetWorkspaceContentRoutes(); vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("indexedDB", new IDBFactory()); localStorage.clear(); state.origin = "https://api.example.test"; session.lockPrivateData(); session.privateAccountChanged("owner"); });
afterEach(() => { session.lockPrivateData(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function fixture() {
  const f = await privateRecoveryFixture(); session.installPrivateSession("owner", f.secrets);
  const account = await privateAccountInventoryStorageHost("owner");
  try { const sync = await privateAccountWorkspaceInventorySync("owner", account.storage, account.exclusive); await sync.enroll(f.enrollment); }
  finally { account.close(); }
  const host = await privateWorkspaceStorageHost("owner", "workspace");
  try {
    const directories = await privateDirectoryStore("owner", "workspace", host.storage, host.exclusive, { ownerId: "owner", signingPublicKey: f.identity.signingPublicKey }); await directories.accept(f.archive.directory.signed);
    const storage = await session.privateWorkspaceStorage("owner", "workspace", host.storage);
    await host.exclusive(() => storage.setItem(`replica:${f.archive.replica.activationRoot}`, JSON.stringify(f.archive.replica)));
  } finally { host.close(); }
  return f;
}
it("reads private catalog queries offline from trusted local policy and never passes them to a standard path", async () => {
  await fixture(); const fetcher = vi.fn(() => { throw new Error("No network allowed"); }); vi.stubGlobal("fetch", fetcher);
  const route = await currentWorkspaceContentRoute("workspace"); expect(route.mode).toBe("encrypted");
  const rows = await readPrivateWorkspaceQuery(route, "tags.list", { workspaceId: "workspace" }, "query") as unknown as { name: string; entryCount: number }[];
  expect(rows.map((row) => row.name)).toEqual(["Another unsent private tag", "Unsent private rename"]); expect(rows.every((row) => row.entryCount === 0)).toBe(true); expect(fetcher).not.toHaveBeenCalled();
  await expect(readPrivateWorkspaceQuery(route, "tags.create", { name: "Private draft" }, "mutation")).rejects.toThrow("not available");
  await expect(assertStandardWorkspaceContent("owner", "workspace")).rejects.toThrow("plaintext queued work"); expect(fetcher).not.toHaveBeenCalled();
});
it("durably requires unlock after lock, restart, missing inventory and a new unlock with the same keys", async () => {
  const f = await fixture(), route = await workspaceContentRoute("owner", "workspace"); expect(await privateRoutingRequired({ server: state.origin, userId: "owner" })).toBe(true);
  session.lockPrivateData(); expect(() => route.check()).toThrow(); await expect(workspaceContentRoute("owner", "workspace")).rejects.toThrow("Unlock private data");
  session.installPrivateSession("owner", f.secrets); expect(() => route.check()).toThrow(); expect((await workspaceContentRoute("owner", "workspace")).mode).toBe("encrypted");
  // Storage wiped behind the hosts' back: only a forgotten decision reads it again.
  vi.stubGlobal("indexedDB", new IDBFactory()); forgetWorkspaceContentRoutes(); await expect(workspaceContentRoute("owner", "workspace")).rejects.toThrow("inventory is missing");
});
it("reuses a keyed decision without reopening storage, and reads again after an inventory write", async () => {
  const f = await fixture();
  expect((await workspaceContentRoute("owner", "workspace")).mode).toBe("encrypted");
  const opened = vi.spyOn(indexedDB, "open");
  expect((await workspaceContentRoute("owner", "workspace")).mode).toBe("encrypted");
  expect(opened).not.toHaveBeenCalled();
  const account = await privateAccountInventoryStorageHost("owner");
  try { const sync = await privateAccountWorkspaceInventorySync("owner", account.storage, account.exclusive); await sync.update(f.enrollment.inventory.workspaces.map((row) => ({ ...row }))); } finally { account.close(); }
  opened.mockClear();
  expect((await workspaceContentRoute("owner", "workspace")).mode).toBe("encrypted");
  expect(opened).toHaveBeenCalled();
});
it("keeps explicitly confirmed standard accounts compatible but refuses corrupted public metadata and unavailable storage", async () => {
  await confirmStandardDeviceAccess({ server: state.origin, userId: "owner" }, () => true);
  expect((await workspaceContentRoute("owner", "workspace")).mode).toBe("standard");
  await requirePrivateRouting({ server: state.origin, userId: "owner" }, () => true);
  const marker = Object.keys(localStorage).find((key) => key.startsWith("trackyourtime.private-routing-required:"))!; localStorage.setItem(marker, "corrupt");
  await expect(workspaceContentRoute("owner", "workspace")).rejects.toThrow("policy could not be verified");
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Storage denied"); }); await expect(workspaceContentRoute("owner", "workspace")).rejects.toThrow("policy could not be verified");
});
it("refuses unknown workspaces, mismatched server/account and stale routing handles after a profile publication", async () => {
  const f = await fixture();
  await expect(workspaceContentRoute("owner", "unknown")).rejects.toThrow("policy could not be verified"); await expect(workspaceContentRoute("owner", null)).rejects.toThrow("Choose a workspace");
  await expect(workspaceContentRoute("owner", "workspace", "https://other.test")).rejects.toThrow();
  const route = await currentWorkspaceContentRoute("workspace"), account = await privateAccountInventoryStorageHost("owner");
  try { const sync = await privateAccountWorkspaceInventorySync("owner", account.storage, account.exclusive); await sync.update([...f.enrollment.inventory.workspaces, { workspaceId: "standard-workspace", mode: "standard" }]); } finally { account.close(); }
  expect(() => route.check()).toThrow("policy changed"); expect((await workspaceContentRoute("owner", "standard-workspace")).mode).toBe("standard");
  const current = await currentWorkspaceContentRoute("workspace"); session.privateAccountChanged("other"); expect(() => current.check()).toThrow();
});
it("rechecks complete HTTP batches and GET filters, including unsupported future procedures, before fetch", async () => {
  await fixture();
  const input = { "0": { workspaceId: "workspace", search: "Private description" }, "1": { userId: "owner" } };
  await expect(assertStandardContentRequest(`${state.origin}/api/trpc/reports.rows,privacy.identity?batch=1`, { method: "POST", body: JSON.stringify(input) })).rejects.toThrow("cannot use the standard HTTP");
  await expect(assertStandardContentRequest(`${state.origin}/api/trpc/tags.list?input=${encodeURIComponent(JSON.stringify(input["0"]))}`)).rejects.toThrow("cannot use the standard HTTP");
  expect(isWorkspaceContentProcedure("future.content")).toBe(true); expect(isWorkspaceContentProcedure("privacy.identity")).toBe(false); expect(isWorkspaceContentProcedure("workspaces.list")).toBe(false);
  for (const path of ["invitations.preview", "invitations.accept", "invitations.decline"]) expect(isWorkspaceContentProcedure(path)).toBe(false);
  expect(isWorkspaceContentProcedure("invitations.create")).toBe(true);
  const check = await assertStandardContentRequest(`${state.origin}/api/trpc/privacy.identity,health.version?batch=1`, { body: "{}" }); check();
});
it("cancels a pending account lookup instead of sending anonymous workspace requests", async () => {
  // A different server forgets the account until the new one resolves it.
  state.origin = "https://other.example.test"; state.changed?.(); const abort = new AbortController(), pending = currentWorkspaceContentRoute("workspace", abort.signal); abort.abort(new Error("Canceled lookup"));
  await expect(pending).rejects.toThrow("Canceled lookup"); session.privateAccountChanged(null); await expect(currentWorkspaceContentRoute("workspace")).rejects.toThrow("Sign in");
});

it("requires original request provenance for standard content and strips local metadata before dispatch", async () => {
  await confirmStandardDeviceAccess({ server: state.origin, userId: "owner" }, () => true);
  const { capturePrivateRequestScope, privateRequestScopeHeaders } = await import("./private-request-scope");
  const url = `${state.origin}/api/trpc/tags.list?batch=1`, body = JSON.stringify({ "0": { workspaceId: "workspace" } });
  await expect(assertStandardContentRequest(url, { body })).rejects.toThrow("original workspace request");
  const scope = capturePrivateRequestScope(), init = { body, headers: privateRequestScopeHeaders([{ context: { privateContentScope: scope } }]) } as RequestInit;
  const check = await assertStandardContentRequest(url, init); check(); expect(new Headers(init.headers).has("x-trackyourtime-local-scope")).toBe(false);
  session.privateAccountChanged("other"); expect(check).toThrow();
});
it("refuses an entire mixed standard batch if one member belongs to an earlier account", async () => {
  await confirmStandardDeviceAccess({ server: state.origin, userId: "owner" }, () => true);
  await confirmStandardDeviceAccess({ server: state.origin, userId: "other" }, () => true);
  const { capturePrivateRequestScope, privateRequestScopeHeaders } = await import("./private-request-scope");
  const old = capturePrivateRequestScope(); session.privateAccountChanged("other"); const current = capturePrivateRequestScope();
  const init = { body: JSON.stringify({ "0": { workspaceId: "workspace" }, "1": { workspaceId: "workspace" } }), headers: privateRequestScopeHeaders([{ context: { privateContentScope: current } }, { context: { privateContentScope: old } }]) } as RequestInit;
  await expect(assertStandardContentRequest(`${state.origin}/api/trpc/tags.create,tasks.create?batch=1`, init)).rejects.toThrow("account or server changed"); expect(new Headers(init.headers).has("x-trackyourtime-local-scope")).toBe(false);
});
