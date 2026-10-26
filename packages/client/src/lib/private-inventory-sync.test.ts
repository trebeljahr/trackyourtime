// @vitest-environment jsdom
import { IDBFactory } from "fake-indexeddb";
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { authenticatePrivateInventoryVersion, canonicalJson, memoryStorage } from "@starter/core";
import { API_LEVEL, type SignedPrivateInventoryVersion } from "@starter/shared";
const state = vi.hoisted(() => ({ origin: "https://api.example.test", changed: null as (() => void) | null, level: null as number | null, token: null as string | null, ready: async () => {} }));
vi.mock("./api-origin", () => ({ getApiOrigin: () => state.origin, subscribeApiOrigin: (fn: () => void) => { state.changed = fn; return () => {}; }, whenApiOriginReady: () => state.ready() }));
vi.mock("./desktop-activity", () => ({ desktopActivity: () => null }));
vi.mock("./server-level", () => ({ currentServerApiLevel: () => state.level }));
vi.mock("./native-session", () => ({ getNativeToken: () => state.token }));
vi.mock("./shell", () => ({ clientId: () => "desktop", isCapacitor: () => false }));
vi.mock("./app-version", () => ({ APP_VERSION: "test" }));
const session = await import("./private-session");
const { signPrivateAccountWorkspaceInventory } = await import("./private-replica");
const { privateAccountWorkspaceInventorySync, privateAccountInventoryTransport, openPrivateAccountInventorySync } = await import("./private-inventory-sync");
beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("indexedDB", new IDBFactory());
  state.origin = "https://api.example.test"; state.level = 31; state.token = null; state.ready = async () => {};
  session.lockPrivateData(); session.privateAccountChanged(null);
});
afterEach(() => { session.lockPrivateData(); vi.unstubAllGlobals(); });
async function fixture() {
  const root = await session.newPrivateIdentity("owner"); session.installPrivateSession("owner", root.secrets);
  const backing = memoryStorage(), exclusive = <T,>(work: () => Promise<T>) => work();
  const open = () => privateAccountWorkspaceInventorySync("owner", backing, exclusive);
  const sync = await open(), signed = await signPrivateAccountWorkspaceInventory("owner", [{ workspaceId: "confidential-workspace", mode: "standard" }], null);
  await sync.enroll(signed);
  const versions: SignedPrivateInventoryVersion[] = [];
  let checkpoint = { revision: 0, root: null as string | null };
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.method).toBe("POST"); expect(init?.cache).toBe("no-store"); expect(init?.redirect).toBe("error");
    expect(new URL(String(url)).origin).toBe(state.origin);
    const input = JSON.parse(String(init?.body));
    let result;
    if (String(url).endsWith("privacy.inventoryWrite")) {
      const signed: SignedPrivateInventoryVersion = input.signed, found = versions.find((v) => v.header.operationId === signed.header.operationId);
      if (!found) {
        checkpoint = (await authenticatePrivateInventoryVersion({ signed, scope: { server: state.origin, userId: "owner" }, previous: checkpoint, signingPublicKey: root.identity.signingPublicKey, current: () => true })).checkpoint;
        versions.push(structuredClone(signed));
      } else expect(canonicalJson(found)).toBe(canonicalJson(signed));
      result = checkpoint;
    } else {
      expect(String(url)).toMatch(/privacy.inventoryVersions$/);
      result = { through: checkpoint.revision, root: checkpoint.root, next: null, versions: versions.slice(input.after) };
    }
    return new Response(JSON.stringify({ result: { data: result } }), { headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetcher);
  return { root, sync, open, fetcher, versions };
}
it("holds pending work on unknown/old servers and retries exact encrypted requests after a lost response", async () => {
  const f = await fixture(), transport = privateAccountInventoryTransport("owner"), pending = await f.sync.exportPending();
  for (const level of [null, 30]) {
    state.level = level; await expect(f.sync.flushOne(transport)).rejects.toThrow("Confirm this server supports");
    expect(f.fetcher).not.toHaveBeenCalled(); expect(await f.sync.exportPending()).toEqual(pending);
  }
  state.level = 31;
  f.fetcher.mockImplementationOnce(async (url, init) => { const result = await f.fetcher.getMockImplementation()!(url, init); throw new Error(`Lost reply ${result.status}`); });
  await expect(f.sync.flushOne(transport)).rejects.toThrow("Lost reply");
  expect(f.versions).toHaveLength(1); expect(await f.sync.exportPending()).toEqual(pending);
  const reopened = await f.open(); await reopened.flushOne(privateAccountInventoryTransport("owner"));
  expect((await reopened.status()).pending).toBe(0); expect(f.versions).toHaveLength(1);
  const writes = f.fetcher.mock.calls.filter(([url]) => String(url).endsWith("privacy.inventoryWrite"));
  expect(writes[0]![1]!.body).toBe(writes[1]![1]!.body);
  for (const [, init] of f.fetcher.mock.calls) {
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBeNull(); expect(init?.credentials).toBe("include");
    expect(headers.get("x-trackyourtime-api-level")).toBe(String(API_LEVEL));
    expect(headers.get("x-trackyourtime-client")).toBe("desktop");
    expect(String(init?.body)).not.toMatch(/confidential-workspace|signingPrivateKey|"master"/);
    expect(String(init?.body)).not.toContain(f.root.secrets.master);
  }
});
it("uses bearer authentication without cookies for native requests", async () => {
  const f = await fixture(); state.token = "synthetic-native-session";
  await f.sync.flushOne(privateAccountInventoryTransport("owner"));
  for (const [, init] of f.fetcher.mock.calls) {
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-native-session");
    expect(init?.credentials).toBe("omit");
  }
});
it("checks unlock and server scope again after native readiness and before sending bytes", async () => {
  const f = await fixture();
  for (const change of ["unlock", "server"]) {
    const sync = await f.open(), transport = privateAccountInventoryTransport("owner");
    let resume!: () => void, reached!: () => void;
    const waiting = new Promise<void>((resolve) => { reached = resolve; });
    state.ready = async () => { reached(); await new Promise<void>((resolve) => { resume = resolve; }); };
    const flush = sync.flushOne(transport); await waiting;
    if (change === "unlock") { session.lockPrivateData(); session.installPrivateSession("owner", f.root.secrets); }
    else { state.origin = "https://other.example.test"; state.changed?.(); }
    resume(); await expect(flush).rejects.toThrow(/changed/);
    expect(f.fetcher).not.toHaveBeenCalled();
  }
});
it("does not clear pending work when a reply arrives after locking", async () => {
  const f = await fixture(), base = f.fetcher.getMockImplementation()!;
  f.fetcher.mockImplementationOnce(async (url, init) => { const response = await base(url, init); session.lockPrivateData(); return response; });
  await expect(f.sync.flushOne(privateAccountInventoryTransport("owner"))).rejects.toThrow(/changed/);
  session.installPrivateSession("owner", f.root.secrets);
  await expect(f.sync.read()).rejects.toThrow(/changed/);
  const reopened = await f.open(); expect((await reopened.status()).pending).toBe(1);
  await reopened.flushOne(privateAccountInventoryTransport("owner")); expect((await reopened.status()).pending).toBe(0);
});
it("reopens the strict IndexedDB host with pending work after lock and closes stale handles", async () => {
  const f = await fixture();
  const first = await openPrivateAccountInventorySync("owner");
  try {
    const signed = await signPrivateAccountWorkspaceInventory("owner", [{ workspaceId: "durable-workspace", mode: "standard" }], null);
    await first.enroll(signed); session.lockPrivateData(); session.installPrivateSession("owner", f.root.secrets);
    await expect(first.status()).rejects.toThrow();
    const reopened = await openPrivateAccountInventorySync("owner");
    try { expect((await reopened.status()).pending).toBe(1); await reopened.flushOne(); expect((await reopened.status()).pending).toBe(0); }
    finally { reopened.close(); }
  } finally { first.close(); }
});
