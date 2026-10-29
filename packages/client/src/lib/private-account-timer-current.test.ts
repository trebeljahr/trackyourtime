// @vitest-environment jsdom
import { IDBFactory } from "fake-indexeddb";
import { webcrypto } from "node:crypto";
import { getUntypedClient } from "@trpc/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { emptyPrivateTimerCheckpoint, encryptPrivateRecord, privateRecordDigest, privateTimerEditBindings, privateWorkspaceChainRoot, privateWorkspaceManifest, privateWorkspaceManifestForReader, signPrivateAccountInventory, signPrivateChainedWorkspaceEdit, signPrivateTimer, type PlainPrivateRecord, type PrivateReplicaTransport } from "@starter/core";
import { API_LEVEL, type SignedPrivateChainedEdit, type TimeEntry } from "@starter/shared";
import { privateRecoveryFixture, seedPrivateWorkspaceClient } from "@/test-private-recovery";
const state = vi.hoisted(() => ({ origin: "https://api.example.test", selected: "standard", level: 38, tokenRevision: 0, note: vi.fn() }));
vi.mock("./api-origin", () => ({ getApiOrigin: () => state.origin, getAbsoluteApiOrigin: () => state.origin, getDefaultAbsoluteApiOrigin: () => state.origin, subscribeApiOrigin: () => () => {}, whenApiOriginReady: async () => {}, rebaseApiUrl: (url: string) => url }));
vi.mock("./active-workspace", () => ({ getActiveWorkspaceId: () => state.selected, subscribeActiveWorkspace: () => () => {}, isActiveWorkspaceReady: () => true, whenActiveWorkspaceReady: async () => {}, getKnownWorkspaceIds: () => new Set(["workspace", "standard"]), getKnownWorkspacesOwner: () => "owner", getActiveWorkspaceSnapshot: () => ({ activeId: state.selected, workspaces: null }), workspaceNameFor: () => "Synthetic workspace" }));
vi.mock("./desktop-activity", () => ({ desktopActivity: () => null }));
vi.mock("./server-level", () => ({ currentServerApiLevel: () => state.level, noteClientTooOld: () => {} }));
vi.mock("./native-session", () => ({ getNativeToken: () => null, getNativeTokenRevision: () => state.tokenRevision }));
vi.mock("./shell", () => ({ clientId: () => "desktop", isCapacitor: () => false, isTokenShell: () => true }));
vi.mock("./private-view-lifecycle", () => ({ notePrivateView: (...args: unknown[]) => state.note(...args) }));
vi.mock("./app-query-persistence", () => ({ getQueryPersistence: () => ({ forget: async () => {}, protectPrivateAccount: async () => {} }) }));
vi.mock("./catalog-cache", () => ({ bindCatalogCaches: () => {} }));
vi.mock("./app-version", () => ({ APP_VERSION: "test" }));
const session = await import("./private-session"), offline = await import("./offline");
const { privateAccountTimerStorageHost, privateAccountTimerStore } = await import("./private-replica");
const { openPrivateWorkspaceCoordinatorCopy } = await import("./private-workspace-session");
const { readPrivateAccountCurrent } = await import("./private-account-timer-current");
const { getTRPCClient } = await import("./trpc");
const { writeRunningMirror, __resetRunningMirrorForTests } = await import("./running-mirror");
let closers: (() => void)[] = [];
beforeEach(async () => {
  vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("indexedDB", new IDBFactory()); vi.stubEnv("NEXT_PUBLIC_API_URL", state.origin); localStorage.clear();
  state.origin = "https://api.example.test"; state.selected = "standard"; state.level = API_LEVEL; state.tokenRevision = 0; state.note.mockReset(); closers = [];
  session.lockPrivateData(); session.privateAccountChanged("owner"); __resetRunningMirrorForTests(); offline.__resetOfflineQueueForTests(); offline.__resetOfflineQueueOwnerForTests(); await offline.setOfflineQueueOwner("owner");
});
afterEach(() => { for (const close of closers.reverse()) close(); session.lockPrivateData(); __resetRunningMirrorForTests(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const stamp = "2026-10-29T01:00:00.000Z";
async function fixture(pending = true) {
  const f = await privateRecoveryFixture();
  f.enrollment = await signPrivateAccountInventory({ server: state.origin, userId: "owner", workspaces: [...f.archive.inventory.local.inventory.workspaces, { workspaceId: "standard", mode: "standard" }], previous: null, signingPrivateKey: f.secrets.signingPrivateKey, current: () => true });
  await seedPrivateWorkspaceClient(f);
  const host = await privateAccountTimerStorageHost("owner"); closers.push(host.close);
  const timer = await privateAccountTimerStore("owner", host.storage, host.exclusive), initial = { v: 1 as const, confirmed: { checkpoint: emptyPrivateTimerCheckpoint(), signed: null }, pending: [], committed: [], conflict: null };
  await timer.restore(initial, await privateRecordDigest(initial));
  const raw = await openPrivateWorkspaceCoordinatorCopy("owner", "workspace"); closers.push(raw.close);
  const tail = await raw.prepareTail(), entryId = crypto.randomUUID(), body = { _id: entryId, workspaceId: "workspace", authorId: "owner", description: "Private clock content", clientId: null, projectId: null, taskId: null, billable: true, start: stamp, end: null, durationSec: 0, currency: "EUR", source: "desktop", timeZone: "UTC", tagIds: [], invoiceId: null, importId: null, createdAt: stamp, updatedAt: stamp }, records = [];
  for (const row of [{ kind: "entries", id: entryId, authorId: "owner", value: body }, { kind: "entryMoney", id: entryId, authorId: "owner", value: { _id: entryId, hourlyRate: 90 } }] as PlainPrivateRecord[]) records.push(await encryptPrivateRecord("workspace", row, raw.directory.signed.directory.members, tail.revision + 1));
  const edit = await signPrivateChainedWorkspaceEdit({ edit: { v: 1, workspaceId: "workspace", userId: "owner", operationId: crypto.randomUUID(), expectedRevision: tail.revision, records, remove: [] }, directory: raw.directory, previousRoot: tail.head, secrets: f.secrets, current: () => true });
  const signed = await signPrivateTimer({ v: 1, protocol: "trackyourtime-private-account-timer-v1", server: state.origin, userId: "owner", operationId: crypto.randomUUID(), revision: 1, previousRoot: null, previous: null, current: { workspaceId: "workspace", entryId }, standardStop: null, edits: await privateTimerEditBindings([edit]) }, f.secrets.signingPrivateKey, () => true);
  const packet = { signed, edits: [edit] }, permit = pending ? await timer.prepare(packet) : null;
  if (permit) { await raw.stageCoordinated(permit); await timer.publish(permit); }
  const journal: SignedPrivateChainedEdit[] = [];
  const changes: NonNullable<PrivateReplicaTransport["chainedChanges"]> = async ({ after, through = 1 + journal.length }) => {
    const rows = [];
    for (const row of journal.filter(row => row.edit.expectedRevision >= after && row.edit.expectedRevision < through)) rows.push({ revision: row.edit.expectedRevision + 1, manifest: privateWorkspaceManifestForReader(await privateWorkspaceManifest(row.edit), "owner"), signature: row.readerSignatures.find(reader => reader.userId === "owner")!.signature, records: row.edit.records, chain: row.chain });
    return { through, next: null, changes: rows };
  };
  const transport: PrivateReplicaTransport = { commit: async () => { throw new Error("Unchained transport"); }, changes: async () => { throw new Error("Unchained transport"); }, chainedChanges: changes, chainedCommit: async input => { expect(input.edit.expectedRevision).toBe(1 + journal.length); journal.push(input); return { revision: 1 + journal.length, head: await privateWorkspaceChainRoot(input.chain) }; } };
  const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit): Promise<Response> => { throw new TypeError("Offline"); }); vi.stubGlobal("fetch", fetcher);
  async function confirm() {
    await raw.flushOne(transport); await raw.flushOne(transport); journal.push(edit); await timer.accept(signed);
    if (permit) { await raw.pull(transport); await timer.settle(async () => { expect(await raw.coordinatedReceipt(permit)).toBeTruthy(); }); }
  }
  function serveJournal() { fetcher.mockImplementation(async (url: RequestInfo | URL) => {
    const target = new URL(String(url)); expect(target.origin).toBe("https://api.example.test"); expect(target.pathname).toBe("/api/trpc/privacy.chainedChanges"); expect(String(url)).not.toContain("Private clock content");
    const input = JSON.parse(target.searchParams.get("input")!); return new Response(JSON.stringify({ result: { data: await changes(input) } }), { headers: { "content-type": "application/json" } });
  }); }
  return { ...f, timer, raw, entryId, packet, transport, journal, confirm, fetcher, serveJournal };
}
it("serves the account's pending private clock through the real SDK while a standard workspace is selected", async () => {
  const f = await fixture(), client = getUntypedClient(getTRPCClient({ streamQueries: false }));
  const entry = await client.query("entries.current") as TimeEntry;
  expect(entry).toMatchObject({ id: f.entryId, workspaceId: "workspace", description: "Private clock content", hourlyRate: 90, end: null }); expect(f.fetcher).not.toHaveBeenCalled(); expect(state.note).toHaveBeenCalled();
  await writeRunningMirror(entry); expect(localStorage.getItem("trackyourtime.running-entry")).toBeNull(); expect(JSON.stringify({ ...localStorage })).not.toContain("Private clock content"); expect(await offline.getOfflineQueue().list()).toEqual([]);
});
it("keeps a confirmed clock readable offline after unrelated private history advances", async () => {
  const f = await fixture(); await f.confirm(); expect((await f.timer.exportRecovery())!.state.currentWitness).toBeTruthy();
  await f.raw.editCatalog("tags.update", { id: "tag", name: "Unrelated later label" }); await f.raw.flushOne(f.transport);
  f.fetcher.mockClear(); const result = await readPrivateAccountCurrent("owner", {});
  expect(result).toMatchObject({ handled: true, value: { id: f.entryId, description: "Private clock content" } }); expect(f.fetcher).not.toHaveBeenCalled();
});
it("fetches and saves the exact signed clock projection for a newly received account checkpoint", async () => {
  const f = await fixture(false); await f.confirm(); f.serveJournal();
  expect((await f.timer.exportRecovery())!.state.currentWitness).toBeUndefined();
  expect(await readPrivateAccountCurrent("owner", {})).toMatchObject({ handled: true, value: { id: f.entryId } }); expect(f.fetcher).toHaveBeenCalledTimes(2);
  expect((await f.timer.exportRecovery())!.state.currentWitness).toBeTruthy(); f.fetcher.mockRejectedValue(new TypeError("Offline"));
  expect(await readPrivateAccountCurrent("owner", {})).toMatchObject({ handled: true, value: { id: f.entryId } }); expect(f.fetcher).toHaveBeenCalledTimes(2);
});
it("refuses changed signed projections without storing a witness or declaring the clock stopped", async () => {
  const f = await fixture(false); await f.confirm(); f.serveJournal(); const base = f.fetcher.getMockImplementation()!;
  f.fetcher.mockImplementationOnce(async (...args) => { const response = await base(...args), payload = await response.json(); payload.result.data.changes[0].chain.header.previousRoot = "A".repeat(43); return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } }); });
  await expect(readPrivateAccountCurrent("owner", {})).rejects.toThrow("binding"); expect((await f.timer.exportRecovery())!.state.currentWitness).toBeUndefined(); expect((await f.timer.read()).local.current?.entryId).toBe(f.entryId);
});
it("uses only the account-scoped standard read when private metadata has no active clock", async () => {
  const f = await fixture(false), entry = { id: "a".repeat(24), workspaceId: "standard", authorId: "owner", description: "Standard clock", clientId: null, projectId: null, taskId: null, billable: false, start: stamp, end: null, durationSec: 0, hourlyRate: null, currency: "EUR", source: "desktop", timeZone: "UTC", tagIds: [], runaway: null, invoiceId: null, importId: null, createdAt: stamp, updatedAt: stamp };
  state.selected = "workspace"; f.fetcher.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(new URL(String(url)).pathname).toBe("/api/trpc/privacy.standardCurrentTimer"); expect(init?.method).toBe("POST"); return new Response(JSON.stringify({ result: { data: entry } }), { headers: { "content-type": "application/json" } });
  });
  expect(await readPrivateAccountCurrent("owner", { workspaceId: "workspace" })).toEqual({ handled: true, value: entry }); expect(state.note).not.toHaveBeenCalled();
  f.fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ result: { data: { ...entry, workspaceId: "workspace" } } }), { headers: { "content-type": "application/json" } }));
  await expect(readPrivateAccountCurrent("owner", {})).rejects.toThrow("Private time");
  f.fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ result: { data: { ...entry, authorId: "other" } } }), { headers: { "content-type": "application/json" } }));
  await expect(readPrivateAccountCurrent("owner", {})).rejects.toThrow("another account");
});
it("refuses a late clock response after a lock/re-unlock or native credential change", async () => {
  for (const native of [false, true]) {
    const f = await fixture(false); await f.confirm(); f.serveJournal(); const base = f.fetcher.getMockImplementation()!;
    let entered!: () => void, release!: () => void; const inside = new Promise<void>(resolve => { entered = resolve; }), paused = new Promise<void>(resolve => { release = resolve; });
    f.fetcher.mockImplementationOnce(async (...args) => { const response = await base(...args); entered(); await paused; return response; });
    const reading = readPrivateAccountCurrent("owner", {}); await inside;
    if (native) state.tokenRevision++; else { session.lockPrivateData(); session.installPrivateSession("owner", f.secrets); }
    release(); await expect(reading).rejects.toThrow(/changed/);
    const freshHost = await privateAccountTimerStorageHost("owner"); closers.push(freshHost.close);
    const freshTimer = await privateAccountTimerStore("owner", freshHost.storage, freshHost.exclusive);
    expect((await freshTimer.exportRecovery())!.state.currentWitness).toBeUndefined();
    // A fresh isolated browser store keeps the two credential races separate.
    if (!native) { for (const close of closers.reverse()) close(); closers = []; session.lockPrivateData(); vi.stubGlobal("indexedDB", new IDBFactory()); localStorage.clear(); }
  }
});
