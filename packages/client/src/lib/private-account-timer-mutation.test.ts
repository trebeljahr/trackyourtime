// @vitest-environment jsdom
import { IDBFactory } from "fake-indexeddb";
import { webcrypto } from "node:crypto";
import { getUntypedClient } from "@trpc/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { privateTimerRoot, privateWorkspaceChainRoot, privateWorkspaceManifest, privateWorkspaceManifestForReader, createPrivateWorkspaceReplica, privateReplicaIdentityFromDirectory, privateMemberKeyFingerprint, signPrivateWorkspaceDirectory, verifyPrivateWorkspaceDirectory, encryptPrivateRecord, signPrivateInitialProjectionRoot, verifyPrivateInitialProjection, privateInitialSnapshotProjection, signPrivateWorkspacePolicy, emptyPrivateTimerCheckpoint, privateRecordDigest, signPrivateAccountInventory } from "@starter/core";
import { API_LEVEL, type SignedPrivateChainedEdit, type SignedPrivateTimer, type EncryptedRecord, type TimeEntry } from "@starter/shared";
import { privateManualEntryFixture, seedPrivateWorkspaceClient } from "@/test-private-recovery";
const state = vi.hoisted(() => ({ origin: "https://api.example.test", selected: "standard", level: 38, tokenRevision: 0, ready: async () => {}, note: vi.fn() }));
vi.mock("./api-origin", () => ({ getApiOrigin: () => state.origin, getAbsoluteApiOrigin: () => state.origin, getDefaultAbsoluteApiOrigin: () => state.origin, subscribeApiOrigin: () => () => {}, whenApiOriginReady: () => state.ready(), rebaseApiUrl: (url: string) => url }));
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
const { privateAccountInventoryStorageHost, privateDirectoryStore, privateWorkspaceStorageHost, privateAccountTimerStorageHost, privateAccountTimerStore } = await import("./private-replica");
const { openPrivateWorkspaceCoordinatorCopy } = await import("./private-workspace-session");
const { beginPrivateMutationIntent, privateMutationIntent, finishPrivateMutationIntent } = await import("./private-mutation-intent");
const { getTRPCClient } = await import("./trpc");
const { writeRunningMirror, __resetRunningMirrorForTests } = await import("./running-mirror");
let closers: (() => void)[] = [];
beforeEach(async () => {
  vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("indexedDB", new IDBFactory()); vi.stubEnv("NEXT_PUBLIC_API_URL", state.origin); localStorage.clear();
  state.origin = "https://api.example.test"; state.selected = "standard"; state.level = API_LEVEL; state.tokenRevision = 0; state.ready = async () => {}; state.note.mockReset(); closers = [];
  session.lockPrivateData(); session.privateAccountChanged("owner"); __resetRunningMirrorForTests(); offline.__resetOfflineQueueForTests(); offline.__resetOfflineQueueOwnerForTests(); await offline.setOfflineQueueOwner("owner");
});
afterEach(() => { for (const close of closers.reverse()) close(); session.lockPrivateData(); __resetRunningMirrorForTests(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const stamp = "2026-10-29T01:00:00.000Z", end = "2026-10-29T02:00:00.000Z";
async function fixture(name?: string) {
  const f = await privateManualEntryFixture();
  if (name) { await f.replica.enqueue({ records: [{ kind: "workspaceIdentity", id: "organization", authorId: null, value: { workspaceId: "workspace", organization: { _id: "workspace", id: "workspace", name, kind: "team" } } }] }); f.archive = await f.capture(); }
  f.enrollment = await signPrivateAccountInventory({ server: state.origin, userId: "owner", workspaces: [...f.archive.inventory.local.inventory.workspaces, { workspaceId: "standard", mode: "standard" }], previous: null, signingPrivateKey: f.secrets.signingPrivateKey, current: () => true });
  await seedPrivateWorkspaceClient(f); state.selected = "workspace";
  const host = await privateAccountTimerStorageHost("owner"); closers.push(host.close);
  const timer = await privateAccountTimerStore("owner", host.storage, host.exclusive), initial = { v: 1 as const, confirmed: { checkpoint: emptyPrivateTimerCheckpoint(), signed: null }, pending: [], committed: [], conflict: null };
  await timer.restore(initial, await privateRecordDigest(initial));
  const fetcher = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    if (new URL(String(url)).pathname !== "/api/trpc/privacy.standardCurrentTimer") throw new TypeError("Offline");
    return new Response(JSON.stringify({ result: { data: null } }), { headers: { "content-type": "application/json" } });
  }); vi.stubGlobal("fetch", fetcher);
  const client = getUntypedClient(getTRPCClient({ streamQueries: false }));
  return { ...f, host, timer, fetcher, client };
}
async function copy() { const raw = await openPrivateWorkspaceCoordinatorCopy("owner", "workspace"); closers.push(raw.close); return raw; }
it("runs real SDK start, update and stop entirely through encrypted durable account packets", async () => {
  const f = await fixture(), operationId = crypto.randomUUID();
  const started = await f.client.mutation("entries.start", { operationId, start: stamp, description: "Private start", billable: true }) as TimeEntry;
  expect(started).toMatchObject({ id: operationId, workspaceId: "workspace", description: "Private start", hourlyRate: 60, end: null });
  expect(await f.client.query("entries.current")).toMatchObject({ id: operationId });
  f.fetcher.mockClear(); f.fetcher.mockRejectedValue(new TypeError("Offline"));
  const updated = await f.client.mutation("entries.update", { id: operationId, operationId: crypto.randomUUID(), description: "Private rename", start: "2026-10-29T01:15:00.000Z" }) as TimeEntry;
  expect(updated.description).toBe("Private rename");
  const stopId = crypto.randomUUID(), stopped = await f.client.mutation("entries.stop", { operationId: stopId, end }) as TimeEntry;
  expect(stopped).toMatchObject({ id: operationId, durationSec: 2700, end });
  expect(await f.client.query("entries.current")).toBeNull();
  expect(await f.client.mutation("entries.start", { operationId, start: stamp, description: "Private start", billable: true })).toEqual(started);
  expect(await f.client.mutation("entries.stop", { operationId: stopId, end })).toEqual(stopped);
  await expect(f.client.mutation("entries.start", { operationId, start: stamp, description: "Changed intent", billable: true })).rejects.toThrow("different request");
  expect(f.fetcher).not.toHaveBeenCalled(); expect((await f.timer.read()).pending).toBe(3); expect(await offline.getOfflineQueue().list()).toEqual([]);
  await writeRunningMirror(started); expect(localStorage.getItem("trackyourtime.running-entry")).toBeNull();
  const file = JSON.stringify((await f.timer.exportRecovery())!.state); expect(file).not.toContain("Private start"); expect(file).not.toContain("Private rename");
});
it("keeps start and discard retry results after the original entry has been removed", async () => {
  const f = await fixture(), operationId = crypto.randomUUID(), start = { operationId, start: stamp, description: "Discarded private start" };
  const started = await f.client.mutation("entries.start", start) as TimeEntry, discardId = crypto.randomUUID();
  f.fetcher.mockClear(); f.fetcher.mockRejectedValue(new TypeError("Offline"));
  const removed = await f.client.mutation("entries.discard", { id: started.id, operationId: discardId });
  expect(removed).toEqual({ success: true, id: started.id });
  expect(await f.client.mutation("entries.start", start)).toEqual(started);
  expect(await f.client.mutation("entries.discard", { id: started.id, operationId: discardId })).toEqual(removed);
  expect(await f.client.query("entries.current")).toBeNull();
  const raw = await copy(), view = await raw.readKinds(["entries", "entryMoney", "imports"]);
  expect(view.records.filter(row => row.kind === "entries" || row.kind === "entryMoney")).toEqual([]);
  expect(view.records.filter(row => row.kind === "imports")).toHaveLength(2); expect(f.fetcher).not.toHaveBeenCalled();
});
it("stops the original private clock while a standard workspace is selected", async () => {
  const f = await fixture(), startId = crypto.randomUUID();
  await f.client.mutation("entries.start", { operationId: startId, start: stamp });
  state.selected = "standard"; f.fetcher.mockClear(); f.fetcher.mockRejectedValue(new TypeError("Offline"));
  const stopId = crypto.randomUUID(), stopped = await f.client.mutation("entries.stop", { operationId: stopId, id: startId, end });
  expect(stopped).toMatchObject({ id: startId, workspaceId: "workspace", end });
  expect(await f.client.mutation("entries.stop", { operationId: stopId, id: startId, end })).toEqual(stopped);
  expect(f.fetcher).not.toHaveBeenCalled(); expect((await f.timer.read()).pending).toBe(2);
});
it("continues and reopens completed time with stable original identities", async () => {
  const f = await fixture(), first = crypto.randomUUID(); await f.client.mutation("entries.start", { operationId: first, start: stamp, billable: true }); await f.client.mutation("entries.stop", { operationId: crypto.randomUUID(), end });
  const continued = await f.client.mutation("entries.continue", { id: first, timeZone: "Australia/Sydney" }) as TimeEntry;
  expect(continued.id).not.toBe(first); expect(continued).toMatchObject({ end: null, timeZone: "Australia/Sydney", hourlyRate: 60 });
  const reopened = await f.client.mutation("entries.update", { id: first, end: null, operationId: crypto.randomUUID() }) as TimeEntry;
  expect(reopened).toMatchObject({ id: first, end: null, hourlyRate: 60 });
  const raw = await copy(), rows = (await raw.readKinds(["entries"])).records;
  expect(rows.filter(row => row.value.end === null).map(row => row.id)).toEqual([first]);
});
it("captures action identity and time before optimistic hooks can alter the variables", async () => {
  await fixture(); const variables = { description: "Before", start: stamp }, owner = {}, now = Date.now();
  beginPrivateMutationIntent([["entries", "start"]], variables, owner);
  const captured = privateMutationIntent("entries.start", variables)!; variables.description = "After";
  expect(privateMutationIntent("entries.start", variables)!.input).toEqual(captured.input);
  expect(captured.timerAction?.now).toBeGreaterThanOrEqual(now); expect(captured.timerAction?.operationId).toMatch(/^[a-f0-9-]{36}$/);
  expect(privateMutationIntent("entries.start", variables)!.timerAction).toBe(captured.timerAction); finishPrivateMutationIntent(owner);
});

it("binds an existing standard clock to the same private start without copying its body", async () => {
  const f = await fixture(), standard = { id: "a".repeat(24), workspaceId: "standard", authorId: "owner", description: "Existing standard description", clientId: null, projectId: null, taskId: null, billable: false, start: stamp, end: null, durationSec: 0, hourlyRate: null, currency: "EUR", source: "desktop", timeZone: "UTC", tagIds: [], runaway: null, invoiceId: null, importId: null, createdAt: stamp, updatedAt: stamp };
  f.fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ result: { data: standard } }), { headers: { "content-type": "application/json" } }));
  const operationId = crypto.randomUUID(), started = await f.client.mutation("entries.start", { operationId, start: end, description: "Private replacement" });
  expect(started).toMatchObject({ id: operationId, start: end });
  const packet = (await f.timer.exportRecovery())!.state.pending[0]!;
  expect(packet.signed.header.standardStop).toEqual({ workspaceId: "standard", entryId: standard.id }); expect(packet.standardStopEnd).toBe(end);
  expect(JSON.stringify(packet)).not.toMatch(/Existing standard description|Private replacement/); expect(await offline.getOfflineQueue().list()).toEqual([]);
});
it("refuses older servers before staging a private action and retains its original state", async () => {
  const f = await fixture(), before = await f.timer.exportRecovery(); state.level = 38;
  await expect(f.client.mutation("entries.start", { start: stamp, operationId: crypto.randomUUID() })).rejects.toThrow("Confirm this server supports");
  expect(await f.timer.exportRecovery()).toEqual(before); expect((await (await copy()).exportRecovery()).pending).toHaveLength(3);
});
it("recovers a crash after saving the preparing packet and returns the original SDK result on retry", async () => {
  const f = await fixture(), module = await import("./private-workspace-session"), base = module.openPrivateWorkspaceCoordinatorCopy;
  const intercept = vi.spyOn(module, "openPrivateWorkspaceCoordinatorCopy").mockImplementation(async (...args) => { const raw = await base(...args); return { ...raw, stageCoordinated: async () => { throw new Error("Simulated process interruption"); } }; });
  const operationId = crypto.randomUUID(), input = { operationId, start: stamp, description: "Prepared original clock" };
  await expect(f.client.mutation("entries.start", input)).rejects.toThrow("Simulated process interruption");
  const interrupted = (await f.timer.exportRecovery())!; expect(interrupted.state.preparing?.signed.header.operationId).toBe(operationId); expect(interrupted.state.pending).toEqual([]);
  intercept.mockRestore(); f.fetcher.mockClear(); f.fetcher.mockRejectedValue(new TypeError("Offline"));
  expect(await f.client.query("entries.current")).toMatchObject({ id: operationId, description: input.description });
  expect((await f.timer.read()).pending).toBe(1); expect((await f.timer.exportRecovery())!.state.preparing).toBeUndefined();
  expect(await f.client.mutation("entries.start", input)).toMatchObject({ id: operationId, description: input.description }); expect(f.fetcher).not.toHaveBeenCalled();
});

it("accepts only the tracker hook's scoped optimistic start metadata and keeps its original intent", async () => {
  const f = await fixture(), { assignPrivateMutationMetadata } = await import("./private-mutation-guard"), variables = { start: stamp, description: "Original optimistic start" }, owner = {};
  beginPrivateMutationIntent([["entries", "start"]], variables, owner);
  const captured = privateMutationIntent("entries.start", variables)!;
  assignPrivateMutationMetadata(variables, { __durableScope: { server: state.origin, owner: "owner", workspaceId: "workspace" }, __durableTempId: "temp:synthetic-start", workspaceId: "workspace" });
  expect(await f.client.mutation("entries.start", variables)).toMatchObject({ id: captured.timerAction!.operationId, description: "Original optimistic start", start: stamp });
  finishPrivateMutationIntent(owner); expect(await offline.getOfflineQueue().list()).toEqual([]);
});

async function secondWorkspace(f: Awaited<ReturnType<typeof fixture>>, workspaceId: string) {
  const scope = { server: state.origin, userId: "owner", workspaceId }, member = f.archive.directory.signed.directory.members[0]!;
  const signed = await signPrivateWorkspaceDirectory({ v: 1, server: scope.server, workspaceId, ownerId: "owner", revision: 1, previousDigest: null, members: [member] }, f.secrets.signingPrivateKey, null, new Map([["owner", await privateMemberKeyFingerprint(scope.server, member)]]));
  const directory = await verifyPrivateWorkspaceDirectory(signed, scope, { ownerId: "owner", signingPublicKey: f.identity.signingPublicKey, revision: 0, digest: null }), shared: EncryptedRecord[] = [], personal: EncryptedRecord[] = [];
  for (const row of (await f.replica.read()).records.filter(row => ["settings", "settingsMoney", "members", "memberMoney"].includes(row.kind))) {
    const encrypted = await encryptPrivateRecord(workspaceId, { ...row, value: { ...row.value, ...(row.value.workspaceId !== undefined ? { workspaceId } : {}) } }, [member], 1);
    shared.push(encrypted);
  }
  const root = await signPrivateInitialProjectionRoot({ directory, secrets: f.secrets, userId: "owner", migrationId: crypto.randomUUID(), sharedRecords: shared, ownerPersonalRecords: personal, personalDigests: new Map([["owner", await privateRecordDigest(personal)]]), current: () => true });
  const snapshot = await verifyPrivateInitialProjection({ signed: root, directory, secrets: f.secrets, scope, sharedRecords: privateInitialSnapshotProjection(shared, "owner"), personalRecords: privateInitialSnapshotProjection(personal, "owner"), current: () => true });
  const signedPolicy = await signPrivateWorkspacePolicy({ reportRangeTimeZone: "UTC", snapshot, directory, secrets: f.secrets, current: () => true }), host = await privateWorkspaceStorageHost("owner", workspaceId);
  try {
    const directories = await privateDirectoryStore("owner", workspaceId, host.storage, host.exclusive, { ownerId: "owner", signingPublicKey: f.identity.signingPublicKey }); await directories.accept(signed);
    const replica = await createPrivateWorkspaceReplica({ scope, storageKey: `replica:${snapshot.root}`, storage: host.storage, exclusive: host.exclusive, resolveStorageKey: () => ({ key: f.master, current: () => true }), resolveIdentity: () => privateReplicaIdentityFromDirectory(directory, "owner", f.secrets, () => true) });
    await replica.bootstrapProjection(snapshot);
  } finally { host.close(); }
  const account = await privateAccountInventoryStorageHost("owner"), { privateAccountWorkspaceInventorySync } = await import("./private-inventory-sync");
  try { const sync = await privateAccountWorkspaceInventorySync("owner", account.storage, account.exclusive); await sync.update([...f.enrollment.inventory.workspaces.filter(row => row.workspaceId !== workspaceId), { workspaceId, mode: "encrypted", signedPolicy }]); } finally { account.close(); }
}
it("publishes one atomic account plan when the real SDK switches between two private workspaces", async () => {
  const f = await fixture(); await secondWorkspace(f, "private-other");
  const first = crypto.randomUUID(), second = crypto.randomUUID();
  await f.client.mutation("entries.start", { operationId: first, start: stamp, description: "First private workspace" });
  state.selected = "private-other"; f.fetcher.mockClear(); f.fetcher.mockRejectedValue(new TypeError("Offline"));
  expect(await f.client.mutation("entries.start", { operationId: second, start: end, description: "Second private workspace" })).toMatchObject({ id: second, workspaceId: "private-other" });
  const packet = (await f.timer.exportRecovery())!.state.pending[1]!;
  expect(packet.signed.header.previous).toEqual({ workspaceId: "workspace", entryId: first }); expect(packet.signed.header.current).toEqual({ workspaceId: "private-other", entryId: second });
  expect(packet.edits.map(edit => edit.edit.workspaceId)).toEqual(["private-other", "workspace"]);
  expect(await f.client.query("entries.current")).toMatchObject({ id: second, workspaceId: "private-other" });
  const old = await copy(); expect((await old.readKinds(["entries"])).records[0]!.value.end).toBe(end);
  expect(f.fetcher).not.toHaveBeenCalled(); expect(await offline.getOfflineQueue().list()).toEqual([]);
});

it("verifies SDK-created receipts through account and workspace sync after a lost reply", async () => {
  const f = await fixture(), operationId = crypto.randomUUID(), input = { operationId, start: stamp, description: "Durable SDK private clock", billable: true };
  const original = await f.client.mutation("entries.start", input), { syncPrivateAccountTimer } = await import("./private-account-timer-sync");
  const journal: SignedPrivateChainedEdit[] = [], history: SignedPrivateTimer[] = []; let loseReply = true;
  f.fetcher.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const target = new URL(String(url)), path = target.pathname.split("/").at(-1)!, request = JSON.parse(init?.body ? String(init.body) : target.searchParams.get("input") ?? "{}");
    expect(String(init?.body)).not.toMatch(/Durable SDK private clock|hourlyRate/); let data;
    if (path === "privacy.timerVersions") { const through = request.through ?? history.length; data = { through, root: through ? await privateTimerRoot(history[through - 1]!) : null, next: null, versions: history.slice(request.after, through) }; }
    else if (path === "privacy.chainedWrite") { const { workspaceId, ...signed } = request; expect(workspaceId).toBe("workspace"); journal.push(signed); data = { revision: 1 + journal.length, head: await privateWorkspaceChainRoot(signed.chain) }; }
    else if (path === "privacy.timerWrite") { journal.push(...request.edits); history.push(request.signed); if (loseReply) { loseReply = false; throw new TypeError("Commit reply lost"); } data = { revision: history.length, root: await privateTimerRoot(request.signed) }; }
    else if (path === "privacy.chainedChanges") {
      const through = request.through ?? journal.length + 1, changes = [];
      for (const signed of journal.filter(row => row.edit.expectedRevision >= request.after && row.edit.expectedRevision < through)) changes.push({ revision: signed.edit.expectedRevision + 1, manifest: privateWorkspaceManifestForReader(await privateWorkspaceManifest(signed.edit), "owner"), signature: signed.readerSignatures.find(row => row.userId === "owner")!.signature, records: signed.edit.records, chain: signed.chain });
      data = { through, next: null, changes };
    } else throw new Error("Unexpected synthetic timer sync route");
    return new Response(JSON.stringify({ result: { data } }), { headers: { "content-type": "application/json" } });
  });
  await expect(syncPrivateAccountTimer("owner")).rejects.toThrow("Commit reply lost"); expect((await f.timer.read()).pending).toBe(1);
  expect(await syncPrivateAccountTimer("owner")).toMatchObject({ pending: 0, committed: 0, revision: 1 }); expect(history).toHaveLength(1);
  expect((await f.timer.exportRecovery())!.state.currentWitness).toBeTruthy(); f.fetcher.mockClear(); f.fetcher.mockRejectedValue(new TypeError("Offline"));
  expect(await f.client.query("entries.current")).toMatchObject({ id: operationId, description: input.description });
  expect(await f.client.mutation("entries.start", input)).toEqual(original); expect(f.fetcher).not.toHaveBeenCalled();
});

it("never forwards a private retry into standard storage after selection changes", async () => {
  const f = await fixture(), operationId = crypto.randomUUID(), input = { operationId, start: stamp, description: "Original private retry" };
  await f.client.mutation("entries.start", input); await f.client.mutation("entries.stop", { operationId: crypto.randomUUID(), end });
  state.selected = "standard"; f.fetcher.mockClear();
  await expect(f.client.mutation("entries.start", input)).rejects.toThrow("another workspace");
  expect(f.fetcher).not.toHaveBeenCalled(); expect((await f.timer.read()).pending).toBe(2); expect(await offline.getOfflineQueue().list()).toEqual([]);
});

function serveHandoff(f: Awaited<ReturnType<typeof fixture>>, loseStandardReply = false) {
  const journal: SignedPrivateChainedEdit[] = [], history: SignedPrivateTimer[] = [], results = new Map<string, TimeEntry>(), requests: { path: string; input: Record<string, unknown> }[] = [];
  let standardCreated = 0, running: TimeEntry | null = null, continuationDescription = "Original standard continuation source";
  f.fetcher.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const target = new URL(String(url)), path = target.pathname.split("/").at(-1)!, input = JSON.parse(init?.body ? String(init.body) : target.searchParams.get("input") ?? "{}");
    requests.push({ path, input }); expect(String(init?.body)).not.toMatch(/Hidden private source|Private source clock/); let data;
    if (path === "privacy.timerVersions") { const through = input.through ?? history.length; data = { through, root: through ? await privateTimerRoot(history[through - 1]!) : null, next: null, versions: history.slice(input.after, through) }; }
    else if (path === "privacy.chainedWrite") { const { workspaceId, ...signed } = input; expect(workspaceId).toBe("workspace"); journal.push(signed); data = { revision: 1 + journal.length, head: await privateWorkspaceChainRoot(signed.chain) }; }
    else if (path === "privacy.timerWrite") {
      journal.push(...input.edits); history.push(input.signed);
      if (input.signed.header.standardStart) {
        standardCreated++; const body = input.standardStartInput, pointer = input.signed.header.standardStart;
        const entry: TimeEntry = { id: pointer.entryId, workspaceId: pointer.workspaceId, authorId: "owner", description: body.description ?? "", clientId: body.clientId ?? null, projectId: body.projectId ?? null, taskId: body.taskId ?? null, billable: body.billable ?? false, start: new Date(body.start).toISOString(), end: null, durationSec: 0, hourlyRate: null, currency: "EUR", source: body.source ?? "web", timeZone: body.timeZone ?? null, tagIds: body.tagIds ?? [], runaway: null, invoiceId: null, importId: null, createdAt: body.start, updatedAt: body.start };
        results.set(input.signed.header.operationId, structuredClone(entry)); running = entry;
        if (loseStandardReply) { loseStandardReply = false; throw new TypeError("Standard handoff reply lost"); }
      }
      data = { revision: history.length, root: await privateTimerRoot(input.signed) };
    } else if (path === "privacy.chainedChanges") {
      const through = input.through ?? journal.length + 1, changes = [];
      for (const signed of journal.filter(row => row.edit.expectedRevision >= input.after && row.edit.expectedRevision < through)) changes.push({ revision: signed.edit.expectedRevision + 1, manifest: privateWorkspaceManifestForReader(await privateWorkspaceManifest(signed.edit), "owner"), signature: signed.readerSignatures.find(row => row.userId === "owner")!.signature, records: signed.edit.records, chain: signed.chain });
      data = { through, next: null, changes };
    } else if (path === "privacy.standardContinueTimerInput") {
      expect(input.workspaceId).toBe("standard");
      data = { description: continuationDescription, start: input.at, timeZone: input.timeZone, originId: input.originId, tagIds: ["retained-tag"], source: "desktop", billable: true };
    } else if (path === "privacy.standardTimerResult") {
      expect(history.some(row => row.header.operationId === input.operationId && row.header.standardStart?.entryId === input.entryId)).toBe(true);
      data = results.get(input.operationId); if (!data) throw new Error("No original standard result");
    } else if (path === "privacy.standardCurrentTimer") data = running;
    else throw new Error("Unexpected synthetic handoff route");
    return new Response(JSON.stringify({ result: { data } }), { headers: { "content-type": "application/json" } });
  });
  return { requests, history, results, changeContinuation: () => { continuationDescription = "Changed after original preparation"; }, get standardCreated() { return standardCreated; }, stopStandard: () => { running = null; } };
}
it("finishes a private-to-standard SDK handoff and keeps its private replacement notice out of the mirror", async () => {
  const f = await fixture("Hidden private source"); await f.client.mutation("entries.start", { start: stamp, operationId: crypto.randomUUID(), description: "Private source clock" });
  const backend = serveHandoff(f); state.selected = "standard";
  const operationId = crypto.randomUUID(), input = { operationId, start: end, description: "Standard target clock" }, started = await f.client.mutation("entries.start", input) as TimeEntry;
  expect(started).toMatchObject({ workspaceId: "standard", description: input.description, replaced: { workspaceName: "Hidden private source", end } });
  expect((await f.timer.read()).pending).toBe(0); expect(backend.standardCreated).toBe(1); expect(await f.client.query("entries.current")).toMatchObject({ id: started.id });
  backend.stopStandard(); expect(await f.client.mutation("entries.start", input)).toEqual(started); expect(backend.standardCreated).toBe(1); expect(await f.client.query("entries.current")).toBeNull();
  await writeRunningMirror(started); expect(localStorage.getItem("trackyourtime.running-entry")).toContain("Standard target clock"); expect(JSON.stringify({ ...localStorage })).not.toContain("Hidden private source");
  expect(await offline.getOfflineQueue().list()).toEqual([]);
});
it("resumes the exact saved handoff after a lost reply and blocks a premature ordinary stop", async () => {
  const f = await fixture("Hidden private source"); await f.client.mutation("entries.start", { start: stamp, operationId: crypto.randomUUID(), description: "Private source clock" });
  const backend = serveHandoff(f, true); state.selected = "standard"; const operationId = crypto.randomUUID(), input = { operationId, start: end, description: "Resumed standard clock" };
  await expect(f.client.mutation("entries.start", input)).rejects.toThrow("handoff is saved");
  expect(backend.standardCreated).toBe(1); expect((await f.timer.read()).pending).toBe(1); const packet = (await f.timer.exportRecovery())!.state.pending[0]!;
  expect(packet.standardStartInput?.description).toBe(input.description);
  await expect(f.client.mutation("entries.stop", { id: packet.signed.header.standardStart!.entryId, operationId: crypto.randomUUID(), end: "2026-10-29T03:00:00.000Z" })).rejects.toThrow("saved timer handoff");
  expect(backend.requests.some(row => row.path.startsWith("entries."))).toBe(false);
  expect(await f.client.mutation("entries.start", input)).toMatchObject({ id: packet.signed.header.standardStart!.entryId, description: input.description });
  expect(backend.standardCreated).toBe(1); expect((await f.timer.read()).pending).toBe(0); expect(await offline.getOfflineQueue().list()).toEqual([]);
});
it("keeps a saved standard start sealed after its target policy changes to private", async () => {
  const f = await fixture(); await f.client.mutation("entries.start", { start: stamp, operationId: crypto.randomUUID() });
  state.selected = "standard"; f.fetcher.mockRejectedValue(new TypeError("Offline")); const operationId = crypto.randomUUID(), input = { operationId, start: end, description: "Pending standard intent" };
  await expect(f.client.mutation("entries.start", input)).rejects.toThrow("handoff is saved");
  await secondWorkspace(f, "standard"); const backend = serveHandoff(f), { syncPrivateAccountTimer } = await import("./private-account-timer-sync");
  await expect(syncPrivateAccountTimer("owner")).rejects.toThrow("now private");
  expect(backend.standardCreated).toBe(0); expect(JSON.stringify(backend.requests)).not.toContain("Pending standard intent"); expect((await f.timer.read()).pending).toBe(1);
  f.fetcher.mockClear(); await expect(f.client.mutation("entries.start", input)).rejects.toThrow("now private"); expect(f.fetcher).not.toHaveBeenCalled();
});

it("refuses a private current-entry body addressed to a standard workspace before any legacy transport", async () => {
  const f = await fixture(), operationId = crypto.randomUUID(); await f.client.mutation("entries.start", { operationId, start: stamp, description: "Private current content" });
  state.selected = "standard"; f.fetcher.mockClear();
  await expect(f.client.mutation("entries.update", { id: operationId, description: "Private edited description" })).rejects.toThrow("own workspace");
  await expect(f.client.mutation("entries.resolveRunaway", { id: operationId, resolution: "end-at", start: stamp, end })).rejects.toThrow("own workspace");
  await expect(f.client.mutation("entries.remove", { id: operationId })).rejects.toThrow("own workspace");
  expect(f.fetcher).not.toHaveBeenCalled(); expect(await offline.getOfflineQueue().list()).toEqual([]); expect((await f.timer.read()).pending).toBe(1);
});

it("continues a standard source atomically after private time and reuses the encrypted recipe", async () => {
  const f = await fixture("Hidden private source"); await f.client.mutation("entries.start", { start: stamp, operationId: crypto.randomUUID(), description: "Private source clock" });
  const backend = serveHandoff(f); state.selected = "standard"; vi.spyOn(Date, "now").mockReturnValue(Date.parse(end));
  const input = { operationId: crypto.randomUUID(), id: "000000000000000000000001", timeZone: "Australia/Sydney", originId: "continue-sdk-test" };
  const started = await f.client.mutation("entries.continue", input) as TimeEntry;
  expect(started).toMatchObject({ workspaceId: "standard", description: "Original standard continuation source", start: end, timeZone: input.timeZone, tagIds: ["retained-tag"], replaced: { workspaceName: "Hidden private source", end } });
  backend.changeContinuation(); backend.stopStandard(); vi.mocked(Date.now).mockReturnValue(Date.parse(end) + 60_000);
  expect(await f.client.mutation("entries.continue", input)).toEqual(started);
  expect(backend.standardCreated).toBe(1); expect(backend.requests.filter(row => row.path === "privacy.standardContinueTimerInput")).toHaveLength(1);
  const count = backend.requests.length;
  await expect(f.client.mutation("entries.continue", { ...input, id: "000000000000000000000002" })).rejects.toThrow("different request");
  expect(backend.requests).toHaveLength(count); expect(await offline.getOfflineQueue().list()).toEqual([]);
});
it("recovers a continued standard timer after a lost handoff reply without preparing its source twice", async () => {
  const f = await fixture(); await f.client.mutation("entries.start", { start: stamp, operationId: crypto.randomUUID() });
  const backend = serveHandoff(f, true); state.selected = "standard"; vi.spyOn(Date, "now").mockReturnValue(Date.parse(end));
  const input = { operationId: crypto.randomUUID(), id: "000000000000000000000001" };
  await expect(f.client.mutation("entries.continue", input)).rejects.toThrow("handoff is saved");
  backend.changeContinuation(); vi.mocked(Date.now).mockReturnValue(Date.parse(end) + 60_000);
  expect(await f.client.mutation("entries.continue", input)).toMatchObject({ description: "Original standard continuation source", start: end });
  expect(backend.standardCreated).toBe(1); expect(backend.requests.filter(row => row.path === "privacy.standardContinueTimerInput")).toHaveLength(1); expect((await f.timer.read()).pending).toBe(0);
});
it("keeps private time intact when standard continuation preparation is unsupported or unavailable", async () => {
  const f = await fixture(), operationId = crypto.randomUUID(); await f.client.mutation("entries.start", { start: stamp, operationId });
  state.selected = "standard"; state.level = 40; f.fetcher.mockClear();
  await expect(f.client.mutation("entries.continue", { id: "000000000000000000000001" })).rejects.toThrow("supports this encrypted data protocol");
  expect(f.fetcher).not.toHaveBeenCalled(); expect((await f.timer.read()).local.current?.entryId).toBe(operationId); expect((await f.timer.read()).pending).toBe(1);
  state.level = API_LEVEL; f.fetcher.mockRejectedValue(new TypeError("Offline"));
  await expect(f.client.mutation("entries.continue", { id: "000000000000000000000001" })).rejects.toThrow("Offline");
  expect((await f.timer.read()).local.current?.entryId).toBe(operationId); expect((await f.timer.read()).pending).toBe(1); expect(await offline.getOfflineQueue().list()).toEqual([]);
});

it("refuses continuation preparation when native credentials change before dispatch", async () => {
  const f = await fixture(), operationId = crypto.randomUUID(); await f.client.mutation("entries.start", { operationId, start: stamp });
  state.selected = "standard"; state.ready = async () => { state.tokenRevision++; }; f.fetcher.mockClear();
  await expect(f.client.mutation("entries.continue", { id: "000000000000000000000001" })).rejects.toThrow();
  expect(f.fetcher).not.toHaveBeenCalled(); expect((await f.timer.read()).local.current?.entryId).toBe(operationId); expect((await f.timer.read()).pending).toBe(1); expect(await offline.getOfflineQueue().list()).toEqual([]);
});
