// @vitest-environment jsdom
import { IDBFactory } from "fake-indexeddb";
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPrivateStorage, segmentedPrivateStorage, PRIVATE_ACCOUNT_TIMER_SCOPE, emptyPrivateTimerCheckpoint, encryptPrivateRecord, privateRecordDigest, privateTimerEditBindings, privateTimerRoot, privateWorkspaceChainRoot, privateWorkspaceManifest, privateWorkspaceManifestForReader, signPrivateChainedWorkspaceEdit, signPrivateTimer, type PlainPrivateRecord } from "@starter/core";
import { API_LEVEL, type PrivateTimerPage, type PrivateTimerPointer, type PrivateTimerTransition, type SignedPrivateChainedEdit, type SignedPrivateTimer } from "@starter/shared";
import { privateRecoveryFixture, seedPrivateWorkspaceClient } from "@/test-private-recovery";
const state = vi.hoisted(() => ({ origin: "https://api.example.test" }));
vi.mock("./api-origin", () => ({ getApiOrigin: () => state.origin, subscribeApiOrigin: () => () => {}, whenApiOriginReady: async () => {} }));
vi.mock("./desktop-activity", () => ({ desktopActivity: () => null }));
vi.mock("./server-level", () => ({ currentServerApiLevel: () => API_LEVEL }));
vi.mock("./native-session", () => ({ getNativeToken: () => null }));
vi.mock("./shell", () => ({ clientId: () => "web", isCapacitor: () => false }));
vi.mock("./app-version", () => ({ APP_VERSION: "test" }));
const session = await import("./private-session");
const { privateAccountTimerStorageHost, privateAccountTimerStore, privateWorkspaceStorageHost } = await import("./private-replica");
const { openPrivateWorkspaceCoordinatorCopy, privateWorkspaceJournalTransport } = await import("./private-workspace-session");
const { syncPrivateAccountTimer } = await import("./private-account-timer-sync");
let closers: (() => void)[] = [];
beforeEach(() => { vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("indexedDB", new IDBFactory()); localStorage.clear(); state.origin = "https://api.example.test"; session.lockPrivateData(); session.privateAccountChanged("owner"); closers = []; });
afterEach(() => { for (const close of closers.reverse()) close(); session.lockPrivateData(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function fixture() {
  const f = await privateRecoveryFixture(); await seedPrivateWorkspaceClient(f);
  const host = await privateAccountTimerStorageHost("owner"); closers.push(host.close);
  const timer = await privateAccountTimerStore("owner", host.storage, host.exclusive), initial = { v: 1 as const, confirmed: { checkpoint: emptyPrivateTimerCheckpoint(), signed: null }, pending: [], committed: [], conflict: null };
  await timer.restore(initial, await privateRecordDigest(initial));
  const raw = await openPrivateWorkspaceCoordinatorCopy("owner", "workspace"); closers.push(raw.close);
  const journal: SignedPrivateChainedEdit[] = [], history: SignedPrivateTimer[] = [], writes: PrivateTimerTransition[] = [], events: string[] = [];
  const head = async () => journal.length ? await privateWorkspaceChainRoot(journal.at(-1)!.chain) : f.archive.replica.activationRoot;
  let failReply = false, failJournal = false, fakeAck = false;
  let pageTransform = (page: PrivateTimerPage): PrivateTimerPage => page;
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const target = new URL(String(url)), path = target.pathname.split("/").at(-1)!;
    const input = JSON.parse(init?.body ? String(init.body) : target.searchParams.get("input") ?? "{}"); events.push(path);
    expect(target.origin).toBe(state.origin); expect(String(init?.body)).not.toMatch(/Timer private description|hourlyRate|privateKey|master/);
    let data: unknown;
    if (path === "privacy.timerVersions") {
      const through = input.through ?? history.length, versions = history.slice(input.after, Math.min(through, input.after + 2));
      const last = versions.at(-1)?.header.revision ?? input.after;
      data = pageTransform({ through, root: through ? await privateTimerRoot(history[through - 1]!) : null, next: last < through ? last : null, versions });
    } else if (path === "privacy.timerWrite") {
      const packet = structuredClone(input) as PrivateTimerTransition; writes.push(packet);
      if (!fakeAck) {
        for (const edit of packet.edits) { expect(edit.edit.expectedRevision).toBe(1 + journal.length); expect(edit.chain.header.previousRoot).toBe(await head()); journal.push(edit); }
        history.push(packet.signed);
      }
      if (failReply) { failReply = false; throw new TypeError("Reply lost"); }
      data = { revision: packet.signed.header.revision, root: await privateTimerRoot(packet.signed) };
    } else if (path === "privacy.chainedWrite") {
      const { workspaceId, ...signed } = input; expect(workspaceId).toBe("workspace");
      expect(signed.edit.expectedRevision).toBe(1 + journal.length); expect(signed.chain.header.previousRoot).toBe(await head()); journal.push(signed);
      data = { revision: 1 + journal.length, head: await head() };
    } else if (path === "privacy.chainedChanges") {
      if (failJournal) throw new TypeError("Workspace feed offline");
      const through = input.through ?? 1 + journal.length, rows = journal.filter(row => row.edit.expectedRevision >= input.after && row.edit.expectedRevision < through), changes = [];
      for (const row of rows) changes.push({ revision: row.edit.expectedRevision + 1, manifest: privateWorkspaceManifestForReader(await privateWorkspaceManifest(row.edit), "owner"), signature: row.readerSignatures.find(reader => reader.userId === "owner")!.signature, records: row.edit.records, chain: row.chain });
      data = { through, next: null, changes };
    } else throw new Error(`Unexpected private sync route ${path}`);
    return new Response(JSON.stringify({ result: { data } }), { headers: { "content-type": "application/json" } });
  }); vi.stubGlobal("fetch", fetcher);
  async function packet(current: PrivateTimerPointer | null = { workspaceId: "workspace", entryId: crypto.randomUUID() }) {
    const local = (await timer.read()).local, tail = await raw.prepareTail(), records = [];
    const ids = new Set([local.current?.entryId, current?.entryId].filter((id): id is string => !!id));
    for (const id of ids) for (const row of [{ kind: "entries", id, authorId: "owner", value: { _id: id, workspaceId: "workspace", authorId: "owner", description: "Timer private description", start: "2026-10-29T01:00:00.000Z", end: current?.entryId === id ? null : "2026-10-29T02:00:00.000Z" } }, { kind: "entryMoney", id, authorId: "owner", value: { _id: id, hourlyRate: 60 } }] as PlainPrivateRecord[]) records.push(await encryptPrivateRecord("workspace", row, raw.directory.signed.directory.members, tail.revision + 1));
    const edit = await signPrivateChainedWorkspaceEdit({ edit: { v: 1, workspaceId: "workspace", userId: "owner", operationId: crypto.randomUUID(), expectedRevision: tail.revision, records, remove: [] }, directory: raw.directory, previousRoot: tail.head, secrets: f.secrets, current: () => true });
    const signed = await signPrivateTimer({ v: 1, protocol: "trackyourtime-private-account-timer-v1", server: state.origin, userId: "owner", operationId: crypto.randomUUID(), revision: local.revision + 1, previousRoot: local.root, previous: local.current, current, standardStop: null, edits: await privateTimerEditBindings([edit]) }, f.secrets.signingPrivateKey, () => true);
    return { signed, edits: [edit] } satisfies PrivateTimerTransition;
  }
  async function stage(input: PrivateTimerTransition) { const permit = await timer.prepare(input); await raw.stageCoordinated(permit); await timer.publish(permit); }
  async function replaceRecoveredWorkspace(input: Awaited<ReturnType<typeof raw.exportRecovery>>) {
    const workspace = await privateWorkspaceStorageHost("owner", "workspace");
    try { const storage = segmentedPrivateStorage(await session.privateWorkspaceStorage("owner", "workspace", workspace.storage), () => session.privateOperationScope("owner")); await workspace.exclusive(() => storage.setItem(`replica:${f.archive.replica.activationRoot}`, JSON.stringify(input))); }
    finally { workspace.close(); }
  }
  async function replaceRecoveredTimer(input: NonNullable<Awaited<ReturnType<typeof timer.exportRecovery>>>["state"]) {
    const storage = segmentedPrivateStorage(await createPrivateStorage({ storage: host.storage, scope: { server: state.origin, userId: "owner", workspaceId: PRIVATE_ACCOUNT_TIMER_SCOPE }, resolveKey: () => ({ key: f.master, current: () => true }) }), () => session.privateOperationScope("owner"));
    await host.exclusive(() => storage.setItem("timer-state", JSON.stringify(input)));
  }
  return { ...f, timer, raw, packet, stage, journal, history, writes, events, fetcher, replaceRecoveredWorkspace, replaceRecoveredTimer, failReply: () => { failReply = true; }, failJournal: (value: boolean) => { failJournal = value; }, fakeAck: () => { fakeAck = true; }, transform: (change: typeof pageTransform) => { pageTransform = change; } };
}
it("flushes earlier ordinary work, commits the exact account packet and verifies both histories before retiring it", async () => {
  const f = await fixture(), input = await f.packet(); await f.stage(input);
  const result = await syncPrivateAccountTimer("owner");
  expect(result).toMatchObject({ changed: true, caughtUp: true, pending: 0, committed: 0, revision: 1 }); expect(f.writes).toEqual([input]);
  expect(f.events.indexOf("privacy.chainedWrite")).toBeLessThan(f.events.indexOf("privacy.timerWrite"));
  expect(f.journal).toHaveLength(3); expect((await f.raw.exportRecovery()).pending).toHaveLength(0); expect((await f.timer.read()).checkpoint.current).toEqual(input.signed.header.current);
});
it("recovers a lost commit reply from signed history without sending the timer twice", async () => {
  const f = await fixture(), input = await f.packet(); await f.stage(input); f.failReply();
  await expect(syncPrivateAccountTimer("owner")).rejects.toThrow("Reply lost"); expect((await f.timer.exportRecovery())!.state.pending).toEqual([input]); expect(f.writes).toHaveLength(1);
  expect(await syncPrivateAccountTimer("owner")).toMatchObject({ pending: 0, committed: 0, revision: 1 }); expect(f.writes).toHaveLength(1);
});
it("retains a confirmed packet across an unavailable workspace feed and settles it on retry", async () => {
  const f = await fixture(), input = await f.packet(); await f.stage(input);
  // Fail the workspace feed only after ordinary predecessor work is accepted.
  const base = f.fetcher.getMockImplementation()!;
  f.fetcher.mockImplementation(async (...args) => { const result = await base(...args); if (String(args[0]).endsWith("privacy.timerWrite")) f.failJournal(true); return result; });
  await expect(syncPrivateAccountTimer("owner")).rejects.toThrow("Workspace feed offline");
  expect((await f.timer.exportRecovery())!.state.committed).toEqual([input]); expect((await f.raw.exportRecovery()).pending).toHaveLength(1);
  f.failJournal(false); expect(await syncPrivateAccountTimer("owner")).toMatchObject({ pending: 0, committed: 0 }); expect(f.writes).toHaveLength(1);
});
it("keeps the original packet when an acknowledgement has no authenticated account history", async () => {
  const f = await fixture(), input = await f.packet(); await f.stage(input); f.fakeAck();
  await expect(syncPrivateAccountTimer("owner")).rejects.toThrow("no verified history record"); expect((await f.timer.exportRecovery())!.state.pending).toEqual([input]);
});
it("keeps queued offline transitions ordered through one atomic commit at a time", async () => {
  const f = await fixture(), first = await f.packet(); await f.stage(first);
  const second = await f.packet(null); await f.stage(second);
  const third = await f.packet(); await f.stage(third);
  expect(await syncPrivateAccountTimer("owner")).toMatchObject({ pending: 0, committed: 0, revision: 3 }); expect(f.writes).toEqual([first, second, third]); expect(f.journal).toHaveLength(5);
});
it("refuses a changed page boundary before accepting any signed item", async () => {
  const f = await fixture(), input = await f.packet(); await f.stage(input); f.failReply(); await expect(syncPrivateAccountTimer("owner")).rejects.toThrow("Reply lost");
  f.transform(page => ({ ...page, root: "A".repeat(43) }));
  await expect(syncPrivateAccountTimer("owner")).rejects.toThrow("boundary"); expect((await f.timer.read()).checkpoint.revision).toBe(0); expect((await f.timer.exportRecovery())!.state.pending).toEqual([input]);
});
it("records a valid competing account operation as a conflict without rebasing local time", async () => {
  const f = await fixture(), input = await f.packet(), competing = await f.packet(); await f.stage(input); f.history.push(competing.signed);
  await expect(syncPrivateAccountTimer("owner")).rejects.toThrow("another device"); expect((await f.timer.exportRecovery())!.state.pending).toEqual([input]); expect((await f.timer.read()).conflict).toBe(true); expect(f.writes).toHaveLength(0);
});
it("cannot accept a late page after locking and unlocking the account", async () => {
  const f = await fixture(), input = await f.packet(); await f.stage(input);
  let entered!: () => void, release!: () => void; const inside = new Promise<void>(resolve => { entered = resolve; }), paused = new Promise<void>(resolve => { release = resolve; });
  const base = f.fetcher.getMockImplementation()!; f.fetcher.mockImplementationOnce(async (...args) => { const result = await base(...args); entered(); await paused; return result; });
  const syncing = syncPrivateAccountTimer("owner"); await inside; session.lockPrivateData(); session.installPrivateSession("owner", f.secrets); release();
  await expect(syncing).rejects.toThrow("changed"); expect(f.writes).toHaveLength(0);
});

it("keeps the same signed boundary across paginated history and settles previously accepted packets without resending", async () => {
  const f = await fixture(), packets = [];
  for (let i = 0; i < 3; i++) { const input = await f.packet(); await f.stage(input); packets.push(input); }
  const journal = privateWorkspaceJournalTransport("owner", "workspace");
  await f.raw.flushOne(journal); await f.raw.flushOne(journal);
  for (const input of packets) { f.journal.push(...input.edits); f.history.push(input.signed); }
  expect(await syncPrivateAccountTimer("owner")).toMatchObject({ pending: 0, committed: 0, revision: 3 }); expect(f.writes).toHaveLength(0);
  const pages = f.fetcher.mock.calls.filter(([url]) => String(url).endsWith("privacy.timerVersions")).map(([, init]) => JSON.parse(String(init?.body)));
  expect(pages).toEqual([{ after: 0 }, { after: 2, through: 3 }]);
});
it("refuses a later page that changes the fixed root and retains the unaccepted packet", async () => {
  const f = await fixture(), packets = [];
  for (let i = 0; i < 3; i++) { const input = await f.packet(); await f.stage(input); packets.push(input); }
  const journal = privateWorkspaceJournalTransport("owner", "workspace"); await f.raw.flushOne(journal); await f.raw.flushOne(journal);
  for (const input of packets) { f.journal.push(...input.edits); f.history.push(input.signed); }
  let pages = 0; f.transform(page => ++pages === 2 ? { ...page, root: "A".repeat(43) } : page);
  await expect(syncPrivateAccountTimer("owner")).rejects.toThrow("immutable boundary");
  expect((await f.timer.read()).checkpoint.revision).toBe(2); expect((await f.timer.exportRecovery())!.state.pending).toEqual([packets[2]]); expect(f.writes).toHaveLength(0);
});

it("settles an older account backup against newer workspace history without replaying its timer", async () => {
  const f = await fixture(), input = await f.packet(); await f.stage(input); const original = (await f.timer.exportRecovery())!.state;
  await syncPrivateAccountTimer("owner");
  await f.raw.editCatalog("tags.update", { id: "tag", name: "Later committed catalog name" }); await f.raw.flushOne(privateWorkspaceJournalTransport("owner", "workspace"));
  const workspace = await f.raw.exportRecovery(); delete workspace.coordinatedReceipts;
  await f.replaceRecoveredWorkspace(workspace); await f.replaceRecoveredTimer(original);
  const result = await syncPrivateAccountTimer("owner"); expect(result).toMatchObject({ pending: 0, committed: 0, revision: 1 });
  const after = await f.raw.exportRecovery(); expect(after.revision).toBe(workspace.revision); expect(after.head).toBe(workspace.head); expect(after.records).toEqual(workspace.records); expect(after.pending).toEqual([]); expect(after.coordinatedReceipts).toHaveLength(1);
  expect(f.writes).toHaveLength(1); expect(f.journal).toHaveLength(4);
});
