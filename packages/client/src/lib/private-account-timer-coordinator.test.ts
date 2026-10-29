// @vitest-environment jsdom
import { IDBFactory } from "fake-indexeddb";
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPrivateStorage, emptyPrivateTimerCheckpoint, encryptPrivateRecord, PRIVATE_ACCOUNT_TIMER_SCOPE, privateRecordDigest, privateTimerEditBindings, segmentedPrivateStorage, signPrivateChainedWorkspaceEdit, signPrivateTimer, type PlainPrivateRecord } from "@starter/core";
import { API_LEVEL } from "@starter/shared";
import { privateRecoveryFixture, seedPrivateWorkspaceClient } from "@/test-private-recovery";
const state = vi.hoisted(() => ({ origin: "https://api.example.test" }));
vi.mock("./api-origin", () => ({ getApiOrigin: () => state.origin, subscribeApiOrigin: () => () => {}, whenApiOriginReady: async () => {} }));
vi.mock("./desktop-activity", () => ({ desktopActivity: () => null }));
vi.mock("./server-level", () => ({ currentServerApiLevel: () => API_LEVEL }));
vi.mock("./native-session", () => ({ getNativeToken: () => null }));
vi.mock("./shell", () => ({ clientId: () => "web", isCapacitor: () => false }));
vi.mock("./app-version", () => ({ APP_VERSION: "test" }));
const session = await import("./private-session");
const { privateAccountTimerStorageHost, privateAccountTimerStore } = await import("./private-replica");
const { privateAccountTimerCoordinatorExclusive, privateDatabaseName } = await import("./private-indexed-storage");
const { withPrivateAccountTimerGate } = await import("./private-account-timer-coordinator");
const { openPrivateWorkspaceSession, openPrivateWorkspaceSyncSession, openPrivateWorkspaceCoordinatorCopy, capturePrivateWorkspaceRecovery } = await import("./private-workspace-session");
let closers: (() => void)[] = [];
beforeEach(() => { vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("indexedDB", new IDBFactory()); localStorage.clear(); state.origin = "https://api.example.test"; session.lockPrivateData(); session.privateAccountChanged("owner"); closers = []; });
afterEach(() => { for (const close of closers.reverse()) close(); session.lockPrivateData(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function fixture() {
  const f = await privateRecoveryFixture(); await seedPrivateWorkspaceClient(f);
  const fetcher = vi.fn(async () => { throw new Error("Offline"); }); vi.stubGlobal("fetch", fetcher);
  const host = await privateAccountTimerStorageHost("owner"); closers.push(host.close);
  const timer = await privateAccountTimerStore("owner", host.storage, host.exclusive), initial = { v: 1 as const, confirmed: { checkpoint: emptyPrivateTimerCheckpoint(), signed: null }, pending: [], committed: [], conflict: null };
  await timer.restore(initial, await privateRecordDigest(initial));
  // Raw handles simulate a crash between internal publication phases. Actual
  // app readers and mutations below always use the guarded public sessions.
  const raw = await openPrivateWorkspaceCoordinatorCopy("owner", "workspace"); closers.push(raw.close);
  const tail = await raw.prepareTail(), entryId = crypto.randomUUID(), records = [];
  for (const row of [{ kind: "entries", id: entryId, authorId: "owner", value: { _id: entryId, workspaceId: "workspace", authorId: "owner", description: "Prepared private timer", start: "2026-10-29T01:00:00.000Z", end: null } }, { kind: "entryMoney", id: entryId, authorId: "owner", value: { _id: entryId, hourlyRate: 60 } }] as PlainPrivateRecord[]) records.push(await encryptPrivateRecord("workspace", row, raw.directory.signed.directory.members, tail.revision + 1));
  const edit = await signPrivateChainedWorkspaceEdit({ edit: { v: 1, workspaceId: "workspace", userId: "owner", operationId: crypto.randomUUID(), expectedRevision: tail.revision, records, remove: [] }, directory: raw.directory, previousRoot: tail.head, secrets: f.secrets, current: () => true });
  const signed = await signPrivateTimer({ v: 1, protocol: "trackyourtime-private-account-timer-v1", server: state.origin, userId: "owner", operationId: crypto.randomUUID(), revision: 1, previousRoot: null, previous: null, current: { workspaceId: "workspace", entryId }, standardStop: null, edits: await privateTimerEditBindings([edit]) }, f.secrets.signingPrivateKey, () => true);
  return { ...f, host, timer, raw, packet: { signed, edits: [edit] }, fetcher };
}
it("repairs an unfinished local publication before a private view can observe it", async () => {
  const f = await fixture(); await f.timer.prepare(f.packet);
  const opened = await openPrivateWorkspaceSession("owner", "workspace"); closers.push(opened.close);
  const view = await opened.readKinds(["entries"]);
  expect(view.records).toHaveLength(1); expect(view.records[0]!.value.description).toBe("Prepared private timer");
  const account = (await f.timer.exportRecovery())!.state;
  expect(account.preparing).toBeUndefined(); expect(account.pending).toEqual([f.packet]);
  expect((await f.raw.exportRecovery()).pending.filter(row => row.coordinatorId === f.packet.signed.header.operationId)).toHaveLength(1); expect(f.fetcher).not.toHaveBeenCalled();
});
it("keeps backup capture readonly while retaining the complete unprepared workspace intent", async () => {
  const f = await fixture(); await f.timer.prepare(f.packet);
  const account = await f.timer.exportRecovery(), replica = await f.raw.exportRecovery();
  const archive = await capturePrivateWorkspaceRecovery("owner", "workspace", f.identity);
  expect(archive.format).toBe("trackyourtime-private-workspace-recovery-v2");
  if (archive.format !== "trackyourtime-private-workspace-recovery-v2") throw new Error("Missing timer recovery");
  expect(archive.accountTimer.preparing).toEqual(f.packet); expect(archive.replica).toEqual(replica);
  expect(await f.timer.exportRecovery()).toEqual(account); expect(await f.raw.exportRecovery()).toEqual(replica); expect(f.fetcher).not.toHaveBeenCalled();
});
it("holds private readers behind the account publication boundary", async () => {
  const f = await fixture(); let entered!: () => void, release!: () => void;
  const inside = new Promise<void>(resolve => { entered = resolve; }), paused = new Promise<void>(resolve => { release = resolve; });
  const writer = withPrivateAccountTimerGate("owner", async ({ timer }) => {
    const permit = await timer!.prepare(f.packet); await f.raw.stageCoordinated(permit); entered(); await paused; await timer!.publish(permit);
  });
  await inside; let completed = false;
  const reading = openPrivateWorkspaceSession("owner", "workspace").then(async copy => { try { const value = await copy.readKinds(["entries"]); completed = true; return value; } finally { copy.close(); } });
  const exclusive = await privateAccountTimerCoordinatorExclusive({ server: state.origin, userId: "owner" });
  let otherEntered = false; const other = exclusive(async () => { otherEntered = true; });
  const name = `${await privateDatabaseName({ server: state.origin, userId: "owner" })}:timer-coordinator`;
  try {
    await vi.waitFor(async () => { expect(((await navigator.locks.query()).pending ?? []).filter(lock => lock.name === name).length).toBeGreaterThanOrEqual(2); });
    expect(completed).toBe(false); expect(otherEntered).toBe(false);
  } finally { release(); await Promise.allSettled([writer, other, reading]); }
  expect((await reading).records).toHaveLength(1); expect((await f.timer.read()).preparing).toBeUndefined();
});
it("freezes a domain draft before waiting for another timer operation", async () => {
  const f = await fixture(), opened = await openPrivateWorkspaceSyncSession("owner", "workspace"); closers.push(opened.close);
  let entered!: () => void, release!: () => void;
  const inside = new Promise<void>(resolve => { entered = resolve; }), paused = new Promise<void>(resolve => { release = resolve; });
  const holder = withPrivateAccountTimerGate("owner", async () => { entered(); await paused; }); await inside;
  const draft = { id: "tag", name: "Original waiting draft" }, saving = opened.editCatalog("tags.update", draft); draft.name = "Later caller mutation";
  release(); await holder; await saving;
  const copy = await openPrivateWorkspaceSession("owner", "workspace"); closers.push(copy.close);
  expect((await copy.readKinds(["tags"])).records.find(row => row.id === "tag")!.value.name).toBe("Original waiting draft"); expect(f.fetcher).not.toHaveBeenCalled();
});
it("refuses legacy fallback if a coordinator-marked workspace loses its account pin", async () => {
  const f = await fixture(); await f.timer.prepare(f.packet);
  const copy = await openPrivateWorkspaceSession("owner", "workspace"); copy.close();
  const before = await f.raw.exportRecovery(), encrypted = await createPrivateStorage({ storage: f.host.storage, scope: { server: state.origin, userId: "owner", workspaceId: PRIVATE_ACCOUNT_TIMER_SCOPE }, resolveKey: () => ({ key: f.master, current: () => true }) });
  const segmented = segmentedPrivateStorage(encrypted, () => () => {}); await f.host.exclusive(() => segmented.removeItem("timer-state"));
  await expect(openPrivateWorkspaceSession("owner", "workspace")).rejects.toThrow("trusted account timer checkpoint");
  await expect(capturePrivateWorkspaceRecovery("owner", "workspace", f.identity)).rejects.toThrow("trusted account timer checkpoint");
  expect(await f.raw.exportRecovery()).toEqual(before); expect(f.fetcher).not.toHaveBeenCalled();
});
it("cannot revive a waiting save after locking and unlocking the same identity", async () => {
  const f = await fixture(), copy = await openPrivateWorkspaceSyncSession("owner", "workspace"); closers.push(copy.close);
  let entered!: () => void, release!: () => void;
  const inside = new Promise<void>(resolve => { entered = resolve; }), paused = new Promise<void>(resolve => { release = resolve; });
  const holder = withPrivateAccountTimerGate("owner", async () => { entered(); await paused; }); await inside;
  const saving = copy.editCatalog("tags.update", { id: "tag", name: "Must not revive" });
  const results = Promise.allSettled([holder, saving]); session.lockPrivateData(); session.installPrivateSession("owner", f.secrets); release();
  expect((await results).map(row => row.status)).toEqual(["rejected", "rejected"]);
  const reopened = await openPrivateWorkspaceSession("owner", "workspace"); closers.push(reopened.close);
  expect((await reopened.readKinds(["tags"])).records.find(row => row.id === "tag")!.value.name).toBe("Unsent private rename");
});
it("leaves account erasure's exclusive lock available while the timer gate is held", async () => {
  await fixture(); const account = `${await privateDatabaseName({ server: state.origin, userId: "owner" })}:account`;
  await withPrivateAccountTimerGate("owner", async () => {
    const available = await navigator.locks.request(account, { mode: "exclusive", ifAvailable: true }, lock => Boolean(lock));
    expect(available).toBe(true);
  });
});
