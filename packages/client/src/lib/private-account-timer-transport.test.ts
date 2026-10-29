// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { encryptPrivateRecord, privateTimerEditBindings, privateTimerRoot, signPrivateChainedWorkspaceEdit, signPrivateTimer, verifyPrivateWorkspaceDirectory, type PlainPrivateRecord } from "@starter/core";
import { API_LEVEL, type PrivateTimerTransition } from "@starter/shared";
import { privateRecoveryFixture } from "@/test-private-recovery";
const state = vi.hoisted(() => ({ origin: "https://api.example.test", level: null as number | null, token: null as string | null, ready: async () => {} }));
vi.mock("./api-origin", () => ({ getApiOrigin: () => state.origin, subscribeApiOrigin: () => () => {}, whenApiOriginReady: () => state.ready() }));
vi.mock("./desktop-activity", () => ({ desktopActivity: () => null }));
vi.mock("./server-level", () => ({ currentServerApiLevel: () => state.level }));
vi.mock("./native-session", () => ({ getNativeToken: () => state.token }));
vi.mock("./shell", () => ({ clientId: () => "desktop", isCapacitor: () => false }));
vi.mock("./app-version", () => ({ APP_VERSION: "test" }));
const session = await import("./private-session");
const { privateAccountTimerTransport } = await import("./private-account-timer-transport");
beforeEach(() => { vi.stubGlobal("crypto", webcrypto); state.origin = "https://api.example.test"; state.level = API_LEVEL; state.token = null; state.ready = async () => {}; session.lockPrivateData(); session.privateAccountChanged("owner"); });
afterEach(() => { session.lockPrivateData(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function fixture() {
  const f = await privateRecoveryFixture(); session.installPrivateSession("owner", f.secrets);
  const scope = { server: state.origin, userId: "owner", workspaceId: "workspace" }, entryId = crypto.randomUUID(), records = [];
  const directory = await verifyPrivateWorkspaceDirectory(f.archive.directory.signed, scope, { ownerId: "owner", signingPublicKey: f.identity.signingPublicKey, revision: 0, digest: null });
  for (const row of [{ kind: "entries", id: entryId, authorId: "owner", value: { _id: entryId, workspaceId: "workspace", authorId: "owner", description: "Transport private description", start: "2026-10-29T01:00:00.000Z", end: null } }, { kind: "entryMoney", id: entryId, authorId: "owner", value: { _id: entryId, hourlyRate: 80 } }] as PlainPrivateRecord[]) records.push(await encryptPrivateRecord("workspace", row, directory.signed.directory.members, 2));
  const edit = await signPrivateChainedWorkspaceEdit({ edit: { v: 1, workspaceId: "workspace", userId: "owner", operationId: crypto.randomUUID(), expectedRevision: 1, records, remove: [] }, directory, previousRoot: f.archive.replica.activationRoot!, secrets: f.secrets, current: () => true });
  const signed = await signPrivateTimer({ v: 1, protocol: "trackyourtime-private-account-timer-v1", server: state.origin, userId: "owner", operationId: crypto.randomUUID(), revision: 1, previousRoot: null, previous: null, current: { workspaceId: "workspace", entryId }, standardStop: null, edits: await privateTimerEditBindings([edit]) }, f.secrets.signingPrivateKey, () => true);
  const packet: PrivateTimerTransition = { signed, edits: [edit] }, root = await privateTimerRoot(signed), requests: unknown[] = [];
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(new URL(String(url)).origin).toBe(scope.server); expect(init?.method).toBe("POST"); expect(init?.cache).toBe("no-store"); expect(init?.redirect).toBe("error");
    expect(String(init?.body)).not.toMatch(/Transport private description|hourlyRate|master|privateKey/);
    const input = JSON.parse(String(init?.body)); requests.push(input);
    const data = String(url).endsWith("privacy.timerWrite") ? { revision: 1, root } : { through: 1, root, next: null, versions: input.after === 0 ? [signed] : [] };
    return new Response(JSON.stringify({ result: { data } }), { headers: { "content-type": "application/json" } });
  }); vi.stubGlobal("fetch", fetcher);
  return { ...f, packet, root, requests, fetcher };
}
it("refuses unknown or older servers before dispatch and preserves exact packets through a lost reply", async () => {
  const f = await fixture(), transport = privateAccountTimerTransport("owner");
  for (const level of [null, 35]) { state.level = level; await expect(transport.commit(f.packet)).rejects.toThrow("Confirm this server supports"); await expect(transport.versions({ after: 0 })).rejects.toThrow("Confirm this server supports"); }
  expect(f.fetcher).not.toHaveBeenCalled(); state.level = API_LEVEL;
  const base = f.fetcher.getMockImplementation()!;
  f.fetcher.mockImplementationOnce(async (...args) => { await base(...args); throw new TypeError("Reply lost"); });
  await expect(transport.commit(f.packet)).rejects.toThrow("Reply lost"); expect(await transport.commit(f.packet)).toEqual({ revision: 1, root: f.root });
  expect(f.requests[0]).toEqual(f.packet); expect(f.requests[1]).toEqual(f.requests[0]);
  expect((await transport.versions({ after: 0 })).versions).toEqual([f.packet.signed]);
});
it.each([null, "synthetic-native-session"])("uses the account-bound metadata channel and the correct credentials (%s)", async token => {
  const f = await fixture(); state.token = token; const transport = privateAccountTimerTransport("owner");
  await transport.commit(f.packet); await transport.versions({ after: 1, through: 1 });
  for (const [, init] of f.fetcher.mock.calls) {
    const headers = new Headers(init?.headers); expect(headers.get("authorization")).toBe(token ? `Bearer ${token}` : null); expect(headers.get("x-trackyourtime-api-level")).toBe(String(API_LEVEL)); expect(init?.credentials).toBe(token ? "omit" : "include");
  }
});
it("freezes a packet before native readiness and refuses a late request after lock/re-unlock", async () => {
  const f = await fixture(), transport = privateAccountTimerTransport("owner"), original = structuredClone(f.packet);
  const pause = () => {
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; }), pending = new Promise<void>(resolve => { release = resolve; });
    state.ready = async () => { enter(); await pending; }; return { entered, release };
  };
  const first = pause(), sending = transport.commit(f.packet); await first.entered; f.packet.signed.header.operationId = crypto.randomUUID(); first.release(); await sending; expect(f.requests[0]).toEqual(original);
  const second = pause(), waiting = transport.commit(original); await second.entered; session.lockPrivateData(); session.installPrivateSession("owner", f.secrets); second.release(); await expect(waiting).rejects.toThrow("changed"); expect(f.fetcher).toHaveBeenCalledTimes(1);
});
it("rejects malformed acknowledgements and pages without accepting them as timer state", async () => {
  const f = await fixture(), transport = privateAccountTimerTransport("owner");
  f.fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ result: { data: { revision: 1, root: f.root, plaintext: "unexpected" } } }), { headers: { "content-type": "application/json" } }));
  await expect(transport.commit(f.packet)).rejects.toThrow();
  f.fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ result: { data: { through: 1, root: null, next: null, versions: [] } } }), { headers: { "content-type": "application/json" } }));
  await expect(transport.versions({ after: 0 })).rejects.toThrow();
});

it("requires the newer handoff capability before sending a transient standard body", async () => {
  const f = await fixture(), signed = await signPrivateTimer({ ...f.packet.signed.header, operationId: crypto.randomUUID(), revision: 2, previousRoot: f.root, previous: f.packet.signed.header.current, current: null, standardStart: { workspaceId: "standard", entryId: "a".repeat(24) } }, f.secrets.signingPrivateKey, () => true);
  const packet = { ...f.packet, signed, standardStartInput: { description: "Standard target label", start: "2026-10-29T02:00:00.000Z" } }, transport = privateAccountTimerTransport("owner");
  state.level = 36; await expect(transport.commit(packet)).rejects.toThrow("Confirm this server supports"); expect(f.fetcher).not.toHaveBeenCalled();
  state.level = API_LEVEL; const root = await privateTimerRoot(signed);
  f.fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ result: { data: { revision: 2, root } } }), { headers: { "content-type": "application/json" } }));
  expect(await transport.commit(packet)).toEqual({ revision: 2, root }); expect(JSON.parse(String(f.fetcher.mock.calls[0]![1]!.body))).toEqual(packet);
});
