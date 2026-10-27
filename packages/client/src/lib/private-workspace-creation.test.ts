// @vitest-environment jsdom
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { webcrypto } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { getUntypedClient } from "@trpc/client";
import { API_LEVEL, type SignedPrivateInventoryVersion } from "@starter/shared";
import { privateInventoryVersionRoot } from "@starter/core";
import { privateRecoveryFixture, seedPrivateWorkspaceClient } from "@/test-private-recovery";
const state = vi.hoisted(() => ({ origin: "https://api.example.test", level: null as number | null, ready: async () => {} }));
vi.mock("./api-origin", () => ({ getApiOrigin: () => state.origin, getAbsoluteApiOrigin: () => state.origin, subscribeApiOrigin: () => () => {}, whenApiOriginReady: () => state.ready(), rebaseApiUrl: (url: string) => url }));
vi.mock("./active-workspace", () => ({ getActiveWorkspaceId: () => "workspace", isActiveWorkspaceReady: () => true, whenActiveWorkspaceReady: async () => {} }));
vi.mock("./desktop-activity", () => ({ desktopActivity: () => null }));
vi.mock("./server-level", () => ({ currentServerApiLevel: () => state.level, noteClientTooOld: () => {} }));
vi.mock("./native-session", () => ({ getNativeToken: () => null, getNativeTokenRevision: () => 0 }));
vi.mock("./shell", () => ({ clientId: () => "web", isCapacitor: () => false, isTokenShell: () => false }));
vi.mock("./app-version", () => ({ APP_VERSION: "test" }));
const session = await import("./private-session");
const { preparePrivateAccountSetup, finishPrivateAccountSetup } = await import("./private-account-setup");
const { openPrivateAccountInventorySync } = await import("./private-inventory-sync");
const { preparePrivateWorkspaceCreation } = await import("./private-workspace-creation");
const { privateWorkspaceCreationFailure } = await import("./private-workspace-creation-error");
const { getTRPCClient } = await import("./trpc");
const { confirmStandardDeviceAccess } = await import("./private-device-access");
beforeEach(() => { vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("indexedDB", new IDBFactory()); vi.stubEnv("NEXT_PUBLIC_API_URL", state.origin); localStorage.clear(); state.level = API_LEVEL; state.ready = async () => {}; session.lockPrivateData(); session.privateAccountChanged("owner"); });
afterEach(() => { session.lockPrivateData(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const api = () => getUntypedClient(getTRPCClient({ streamQueries: false }));
async function fixture() {
  const versions: SignedPrivateInventoryVersion[] = [], creates: Record<string, unknown>[] = [];
  let responseId: string | null = null, afterInventoryWrite = () => {};
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(new Headers(init?.headers).has("x-trackyourtime-local-scope")).toBe(false);
    const path = new URL(String(url)).pathname.split("/").at(-1); let data: unknown;
    if (path === "workspaces.list") data = [{ id: "workspace" }];
    else if (path === "privacy.enroll") data = { revision: 1 };
    else if (path === "privacy.inventoryWrite") { const { signed } = JSON.parse(String(init?.body)); versions.push(signed); data = { revision: versions.length, root: await privateInventoryVersionRoot(signed) }; afterInventoryWrite(); }
    else if (path === "privacy.inventoryVersions") { const { after, through } = JSON.parse(String(init?.body)); data = { through, root: await privateInventoryVersionRoot(versions[through - 1]), next: null, versions: versions.slice(after, through) }; }
    else if (path === "workspaces.create") {
      const input = JSON.parse(String(init?.body))["0"]; creates.push(input);
      return new Response(JSON.stringify([{ result: { data: { workspaceId: responseId ?? input.clientWorkspaceId ?? "legacy-id", ignored: "untrusted" } } }]), { headers: { "content-type": "application/json" } });
    } else throw new Error(`Unexpected request ${path}`);
    return new Response(JSON.stringify({ result: { data } }), { headers: { "content-type": "application/json" } });
  }); vi.stubGlobal("fetch", fetcher);
  const draft = await preparePrivateAccountSetup("owner"); await finishPrivateAccountSetup(draft); fetcher.mockClear();
  return { fetcher, versions, creates, wrongResponse: () => { responseId = "workspace"; }, afterWrite: (work: () => void) => { afterInventoryWrite = work; } };
}
it("reserves a new signed local identity before dispatch and only publishes that same response identity", async () => {
  const f = await fixture(), supplied = crypto.randomUUID();
  const result = await api().mutation("workspaces.create", { name: "New studio", currency: "EUR", weekStartsOn: 1, clientWorkspaceId: supplied });
  expect(f.creates).toHaveLength(1); const id = f.creates[0]!.clientWorkspaceId;
  expect(id).toMatch(/^[0-9a-f-]{36}$/); expect(id).not.toBe(supplied); expect(f.creates[0]).toMatchObject({ name: "New studio", workspaceId: id }); expect(result).toEqual({ workspaceId: id });
  const sync = await openPrivateAccountInventorySync("owner");
  try { const profile = await sync.read(); expect(profile.inventory.signed.inventory.workspaces).toContainEqual({ workspaceId: id, mode: "standard" }); expect(profile.pending).toBe(1); } finally { sync.close(); }
  expect(f.versions).toHaveLength(1); expect(JSON.stringify(f.versions)).not.toContain("New studio");
});
it("refuses a server-selected replacement id and keeps the signed creation reservation", async () => {
  const f = await fixture(); f.wrongResponse(); let failure;
  try { await api().mutation("workspaces.create", { name: "New studio", currency: "EUR", weekStartsOn: 1 }); } catch (error) { failure = error; }
  expect(privateWorkspaceCreationFailure(failure)).toBe("response"); expect(f.creates).toHaveLength(1);
  const sync = await openPrivateAccountInventorySync("owner"); try { expect((await sync.read()).inventory.signed.inventory.workspaces).toHaveLength(2); } finally { sync.close(); }
});
it.each([null, 34])("refuses unsupported API %s without flushing or reserving anything", async (level) => {
  const f = await fixture(); state.level = level;
  await expect(preparePrivateWorkspaceCreation({ name: "New studio", currency: "EUR", weekStartsOn: 1 })).rejects.toMatchObject({ reason: "server" }); expect(f.fetcher).not.toHaveBeenCalled();
  const sync = await openPrivateAccountInventorySync("owner"); try { expect((await sync.read()).inventory.signed.inventory.workspaces).toHaveLength(1); } finally { sync.close(); }
});
it("keeps creation local when a durable inventory write cannot be confirmed", async () => {
  const f = await fixture(), sync = await openPrivateAccountInventorySync("owner"); await sync.flushOne(); sync.close(); f.fetcher.mockClear();
  vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(() => { throw new Error("Disk full with private detail"); });
  await expect(preparePrivateWorkspaceCreation({ name: "New studio", currency: "EUR", weekStartsOn: 1 })).rejects.toMatchObject({ reason: "local" }); expect(f.fetcher).not.toHaveBeenCalled();
});
it("never sends a plaintext workspace name from an account containing private workspaces", async () => {
  await seedPrivateWorkspaceClient(await privateRecoveryFixture()); const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  let failure; try { await api().mutation("workspaces.create", { name: "Secret studio" }); } catch (error) { failure = error; }
  expect(privateWorkspaceCreationFailure(failure)).toBe("private"); expect(fetcher).not.toHaveBeenCalled();
});
it("refuses a creation draft when the account changes during its initial readiness wait", async () => {
  const f = await fixture(); let resume!: () => void, enter!: () => void;
  const waiting = new Promise<void>((resolve) => { enter = resolve; }); state.ready = async () => { enter(); await new Promise<void>((resolve) => { resume = resolve; }); };
  const pending = api().mutation("workspaces.create", { name: "Original draft" }); await waiting; session.privateAccountChanged("other"); resume();
  await expect(pending).rejects.toThrow(); expect(f.fetcher).not.toHaveBeenCalled();
});
it("retains legacy creation on an explicitly confirmed standard device without account keys", async () => {
  await confirmStandardDeviceAccess({ server: state.origin, userId: "owner" }, () => true);
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => { expect(new Headers(init?.headers).has("x-trackyourtime-local-scope")).toBe(false); expect(JSON.parse(String(init?.body))["0"].clientWorkspaceId).toBeUndefined(); return new Response(JSON.stringify([{ result: { data: { workspaceId: "legacy-id" } } }]), { headers: { "content-type": "application/json" } }); }); vi.stubGlobal("fetch", fetcher);
  expect(await api().mutation("workspaces.create", { name: "Legacy studio" })).toEqual({ workspaceId: "legacy-id" }); expect(fetcher).toHaveBeenCalledTimes(1);
});

it("freezes a creation draft before readiness rather than reading later caller mutations", async () => {
  const f = await fixture(); let resume!: () => void, enter!: () => void, calls = 0;
  const waiting = new Promise<void>((resolve) => { enter = resolve; }); state.ready = async () => { if (++calls === 1) { enter(); await new Promise<void>((resolve) => { resume = resolve; }); } };
  const input = { name: "Original studio", currency: "EUR", weekStartsOn: 1 };
  const pending = api().mutation("workspaces.create", input); await waiting; input.name = "Later draft"; resume(); await pending;
  expect(f.creates[0]!.name).toBe("Original studio");
});
it("refuses a server support downgrade during encrypted inventory delivery before any creation name leaves", async () => {
  const f = await fixture(); f.afterWrite(() => { state.level = 34; });
  await expect(api().mutation("workspaces.create", { name: "Never sent studio", currency: "EUR", weekStartsOn: 1 })).rejects.toThrow(); expect(f.creates).toEqual([]);
});
