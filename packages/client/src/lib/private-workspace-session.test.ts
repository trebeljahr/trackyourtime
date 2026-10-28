// @vitest-environment jsdom
import { IDBFactory } from "fake-indexeddb";
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { API_LEVEL } from "@starter/shared";
import { createPrivateWorkspaceReplica, decodeSecret, privateInventoryVersionRoot, privateReplicaIdentityFromDirectory, encryptPrivateRecord, privateInitialSnapshotProjection, privateMemberKeyFingerprint, privateRecordDigest, signPrivateInitialProjectionRoot, signPrivateWorkspaceDirectory, verifyPrivateInitialProjection, verifyPrivateWorkspaceDirectory } from "@starter/core";
import { emptyPrivateTimerCheckpoint, privateTimerEditBindings, signPrivateChainedWorkspaceEdit, signPrivateTimer, type PlainPrivateRecord } from "@starter/core";
const state = vi.hoisted(() => ({ origin: "https://api.example.test", changed: null as (() => void) | null, level: 32 as number | null, token: null as string | null, ready: async () => {} }));
vi.mock("./api-origin", () => ({ getApiOrigin: () => state.origin, subscribeApiOrigin: (fn: () => void) => { state.changed = fn; return () => {}; }, whenApiOriginReady: () => state.ready() }));
vi.mock("./desktop-activity", () => ({ desktopActivity: () => null }));
vi.mock("./server-level", () => ({ currentServerApiLevel: () => state.level }));
vi.mock("./native-session", () => ({ getNativeToken: () => state.token }));
vi.mock("./shell", () => ({ clientId: () => "desktop", isCapacitor: () => false }));
vi.mock("./app-version", () => ({ APP_VERSION: "test" }));
const session = await import("./private-session");
const { privateAccountInventoryStorageHost, privateWorkspaceStorageHost, signPrivateAccountWorkspaceInventory, signPrivateWorkspaceDevicePolicy, privateAccountTimerStorageHost, privateAccountTimerStore } = await import("./private-replica");
const { privateAccountWorkspaceInventorySync } = await import("./private-inventory-sync");
const { openPrivateWorkspaceSession, capturePrivateWorkspaceRecovery } = await import("./private-workspace-session");
beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("indexedDB", new IDBFactory());
  state.origin = "https://api.example.test"; state.level = 32; state.token = null; state.ready = async () => {};
  session.lockPrivateData(); session.privateAccountChanged(null);
});
afterEach(() => { session.lockPrivateData(); vi.unstubAllGlobals(); });
async function fixture(standard = false) {
  const root = await session.newPrivateIdentity("owner"); session.installPrivateSession("owner", root.secrets);
  const scope = { server: state.origin, userId: "owner", workspaceId: "workspace" };
  const person = { userId: "owner", role: "owner" as const, canViewOthersTime: true, canViewOthersMoney: true, publicKey: root.identity.publicKey, signingPublicKey: root.identity.signingPublicKey };
  const signedDirectory = await signPrivateWorkspaceDirectory({ v: 1, server: scope.server, workspaceId: scope.workspaceId, ownerId: "owner", revision: 1, previousDigest: null, members: [person] }, root.secrets.signingPrivateKey, null, new Map([["owner", await privateMemberKeyFingerprint(scope.server, person)]]));
  const directory = await verifyPrivateWorkspaceDirectory(signedDirectory, scope, { ownerId: "owner", signingPublicKey: person.signingPublicKey, revision: 0, digest: null });
  const shared = [await encryptPrivateRecord(scope.workspaceId, { kind: "tags", id: "tag", authorId: null, value: { name: "Confidential shared tag" } }, [person], 1)];
  const personal = [await encryptPrivateRecord(scope.workspaceId, { kind: "favorites", id: "favorite", authorId: "owner", value: { description: "Confidential personal pin" } }, [person], 1)];
  const signed = await signPrivateInitialProjectionRoot({ directory, secrets: root.secrets, userId: "owner", migrationId: crypto.randomUUID(), sharedRecords: shared, ownerPersonalRecords: personal, personalDigests: new Map([["owner", await privateRecordDigest(personal)]]), current: () => true });
  const snapshot = await verifyPrivateInitialProjection({ signed, scope, directory, secrets: root.secrets, sharedRecords: privateInitialSnapshotProjection(shared, "owner"), personalRecords: privateInitialSnapshotProjection(personal, "owner"), current: () => true });
  const signedPolicy = await signPrivateWorkspaceDevicePolicy("owner", snapshot, directory, "UTC"), host = await privateAccountInventoryStorageHost("owner");
  try {
    const inventory = await privateAccountWorkspaceInventorySync("owner", host.storage, host.exclusive);
    await inventory.enroll(await signPrivateAccountWorkspaceInventory("owner", standard ? [{ workspaceId: "workspace", mode: "standard" }] : [{ workspaceId: "workspace", mode: "encrypted", signedPolicy }], null));
  } finally { host.close(); }
  const fetcher = vi.fn(async (url: RequestInfo | URL, input?: RequestInit) => {
    expect(input?.method).toBe("POST"); expect(input?.cache).toBe("no-store"); expect(input?.redirect).toBe("error");
    expect(new URL(String(url)).origin).toBe(scope.server);
    const args = JSON.parse(String(input?.body)); expect(args.workspaceId).toBe(scope.workspaceId);
    expect(String(input?.body)).not.toMatch(/Confidential|master|privateKey/);
    let result;
    if (String(url).endsWith("privacy.projectionDirectory")) {
      expect(args).toEqual({ workspaceId: "workspace", after: 0, through: 1 });
      result = { through: 1, next: null, directories: [{ digest: directory.digest, signed: signedDirectory }] };
    } else if (String(url).endsWith("privacy.projectionRoot")) result = signed;
    else {
      expect(String(url)).toMatch(/privacy.projectionPage$/); expect(args.migrationId).toBe(signed.manifest.migrationId); expect(args.offset).toBe(0);
      result = { offset: 0, next: null, records: privateInitialSnapshotProjection(args.lane === "shared" ? shared : personal, "owner") };
    }
    return new Response(JSON.stringify({ result: { data: result } }), { headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetcher); return { root, scope, directory, signed, snapshot, signedPolicy, fetcher };
}
it.each([null, "synthetic-native-session"])("boots a pinned private workspace using only authenticated ciphertext transport (%s)", async (token) => {
  const f = await fixture(); state.token = token;
  const opened = await openPrivateWorkspaceSession("owner", "workspace");
  try {
    const value = await opened.read(); expect(value.records).toHaveLength(2);
    expect(value.records.map((row) => row.value)).toContainEqual({ name: "Confidential shared tag" });
    expect(value.records.map((row) => row.value)).toContainEqual({ description: "Confidential personal pin" });
    expect((await opened.readKinds(["tags"])).records.map((row) => row.value)).toEqual([{ name: "Confidential shared tag" }]);
    expect(await opened.checkpoint()).toEqual({ activationRoot: f.snapshot.root, revision: 1, head: f.snapshot.root, pending: 0 });
    expect(f.fetcher).toHaveBeenCalledTimes(4);
    for (const [, input] of f.fetcher.mock.calls) {
      const headers = new Headers(input?.headers);
      expect(headers.get("authorization")).toBe(token ? `Bearer ${token}` : null);
      expect(input?.credentials).toBe(token ? "omit" : "include");
      expect(headers.get("x-trackyourtime-api-level")).toBe(String(API_LEVEL));
      expect(String(input?.body)).not.toContain(f.root.secrets.master);
    }
  } finally { opened.close(); }
});
it("reopens verified ciphertext offline without asking the server to choose its mode or root", async () => {
  const f = await fixture(), first = await openPrivateWorkspaceSession("owner", "workspace"); first.close(); f.fetcher.mockClear();
  expect(first.current()).toBe(false); await expect(first.read()).rejects.toThrow("session was closed");
  state.level = null; f.fetcher.mockRejectedValue(new Error("Offline"));
  const reopened = await openPrivateWorkspaceSession("owner", "workspace");
  try { expect((await reopened.read()).records).toHaveLength(2); expect(f.fetcher).not.toHaveBeenCalled(); }
  finally { reopened.close(); }
});
it("never enrolls a missing inventory or falls back for unknown/standard workspace policies", async () => {
  const root = await session.newPrivateIdentity("owner"); session.installPrivateSession("owner", root.secrets); const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  await expect(openPrivateWorkspaceSession("owner", "workspace")).rejects.toThrow("Trusted account workspace inventory is missing");
  expect(fetcher).not.toHaveBeenCalled();
  const host = await privateAccountInventoryStorageHost("owner");
  try {
    const inventory = await privateAccountWorkspaceInventorySync("owner", host.storage, host.exclusive);
    await inventory.enroll(await signPrivateAccountWorkspaceInventory("owner", [{ workspaceId: "workspace", mode: "standard" }], null));
  } finally { host.close(); }
  await expect(openPrivateWorkspaceSession("owner", "workspace")).rejects.toThrow("no trusted encrypted storage policy");
  await expect(openPrivateWorkspaceSession("owner", "unknown")).rejects.toThrow("absent from the trusted");
  expect(fetcher).not.toHaveBeenCalled();
});
it("refuses unknown/older server levels before dispatch and keeps trusted enrollment intact", async () => {
  const f = await fixture();
  for (const level of [null, 31]) {
    state.level = level; await expect(openPrivateWorkspaceSession("owner", "workspace")).rejects.toThrow("Confirm this server supports"); expect(f.fetcher).not.toHaveBeenCalled();
  }
  state.level = 32; const opened = await openPrivateWorkspaceSession("owner", "workspace");
  try { expect((await opened.read()).head).toBe(f.snapshot.root); } finally { opened.close(); }
});
it("rejects an altered projection before it becomes a local replica", async () => {
  const f = await fixture(), base = f.fetcher.getMockImplementation()!;
  f.fetcher.mockImplementation(async (url, input) => {
    const response = await base(url, input);
    if (!String(url).endsWith("privacy.projectionRoot")) return response;
    const body = await response.json(); body.result.data.signature = "A".repeat(86);
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  });
  await expect(openPrivateWorkspaceSession("owner", "workspace")).rejects.toThrow(/signature/);
  f.fetcher.mockImplementation(base);
  const opened = await openPrivateWorkspaceSession("owner", "workspace");
  try { expect((await opened.read()).records).toHaveLength(2); } finally { opened.close(); }
});
it("does not replace an older unanchored history or send it through a standard path", async () => {
  const f = await fixture(), host = await privateWorkspaceStorageHost("owner", "workspace");
  try {
    const storage = await session.privateWorkspaceStorage("owner", "workspace", host.storage), raw = JSON.stringify({ v: 1, revision: 2, head: "A".repeat(43), records: [], pending: [] });
    await host.exclusive(() => storage.setItem("replica", raw));
    await expect(openPrivateWorkspaceSession("owner", "workspace")).rejects.toThrow("no matching activation checkpoint");
    expect(await storage.getItem("replica")).toBe(raw);
    expect(f.fetcher.mock.calls.every(([url]) => String(url).endsWith("privacy.projectionDirectory"))).toBe(true);
  } finally { host.close(); }
});
it.each(["unlock", "server"])("refuses delayed bootstrap after a %s change and preserves existing encrypted state", async (change) => {
  const f = await fixture(); let resume!: () => void, enter!: () => void;
  const ready = new Promise<void>((resolve) => { enter = resolve; });
  state.ready = async () => { enter(); await new Promise<void>((resolve) => { resume = resolve; }); };
  const opening = openPrivateWorkspaceSession("owner", "workspace"); await ready;
  if (change === "unlock") { session.lockPrivateData(); session.installPrivateSession("owner", f.root.secrets); }
  else { state.origin = "https://other.example.test"; state.changed?.(); }
  resume(); await expect(opening).rejects.toThrow(/changed/); expect(f.fetcher).not.toHaveBeenCalled();
});
it("invalidates the opened client handle immediately on locking, including unlocking the same keys again", async () => {
  const f = await fixture(), opened = await openPrivateWorkspaceSession("owner", "workspace");
  try {
    session.lockPrivateData(); session.installPrivateSession("owner", f.root.secrets);
    expect(opened.current()).toBe(false); await expect(opened.read()).rejects.toThrow(/changed/);
  } finally { opened.close(); }
});

it("captures a cached private copy offline, preserving signed submitted packets and unsent edits", async () => {
  const f = await fixture(), opened = await openPrivateWorkspaceSession("owner", "workspace"); opened.close();
  const host = await privateWorkspaceStorageHost("owner", "workspace"), master = decodeSecret(f.root.secrets.master, 32);
  try {
    const replica = await createPrivateWorkspaceReplica({ scope: f.scope, storageKey: `replica:${f.snapshot.root}`, storage: host.storage, exclusive: host.exclusive, resolveStorageKey: () => ({ key: master, current: () => true }), resolveIdentity: () => privateReplicaIdentityFromDirectory(f.directory, "owner", f.root.secrets, () => true) });
    await replica.enqueue({ records: [{ kind: "tags", id: "tag", authorId: null, value: { name: "Private offline rename" } }] });
    const offline = async () => { throw new Error("Offline"); };
    await expect(replica.flushOne({ commit: offline, changes: offline, chainedCommit: offline, chainedChanges: offline })).rejects.toThrow("Offline");
    await replica.enqueue({ records: [], remove: [{ kind: "favorites", id: "favorite", authorId: "owner" }] });
    const before = await replica.exportRecovery(); f.fetcher.mockClear(); f.fetcher.mockRejectedValue(new Error("Offline"));
    const captured = await capturePrivateWorkspaceRecovery("owner", "workspace", f.root.identity);
    expect(captured.replica).toEqual(before); expect(captured.replica.pending[0]!.submitted).not.toBeNull(); expect(captured.replica.pending[1]!.submitted).toBeNull();
    expect(await replica.exportRecovery()).toEqual(before); expect(f.fetcher).not.toHaveBeenCalled();
  } finally { master.fill(0); host.close(); }
});
it("captures a pinned account timer and its exact queued ciphertext in the versioned offline backup", async () => {
  const f = await fixture(), opened = await openPrivateWorkspaceSession("owner", "workspace"); opened.close();
  const host = await privateAccountTimerStorageHost("owner");
  try {
    const timers = await privateAccountTimerStore("owner", host.storage, host.exclusive), initial = { v: 1 as const, confirmed: { checkpoint: emptyPrivateTimerCheckpoint(), signed: null }, pending: [], committed: [], conflict: null };
    await timers.restore(initial, await privateRecordDigest(initial));
    const entryId = crypto.randomUUID(), records = [];
    for (const row of [{ kind: "entries", id: entryId, authorId: "owner", value: { _id: entryId, workspaceId: "workspace", authorId: "owner", description: "Offline private timer", start: "2026-10-29T01:00:00.000Z", end: null } }, { kind: "entryMoney", id: entryId, authorId: "owner", value: { _id: entryId, hourlyRate: 60 } }] as PlainPrivateRecord[]) records.push(await encryptPrivateRecord("workspace", row, f.directory.signed.directory.members, 2));
    const edit = await signPrivateChainedWorkspaceEdit({ edit: { v: 1, workspaceId: "workspace", userId: "owner", operationId: crypto.randomUUID(), expectedRevision: 1, records, remove: [] }, directory: f.directory, previousRoot: f.snapshot.root, secrets: f.root.secrets, current: () => true });
    const signed = await signPrivateTimer({ v: 1, protocol: "trackyourtime-private-account-timer-v1", server: state.origin, userId: "owner", operationId: crypto.randomUUID(), revision: 1, previousRoot: null, previous: null, current: { workspaceId: "workspace", entryId }, standardStop: null, edits: await privateTimerEditBindings([edit]) }, f.root.secrets.signingPrivateKey, () => true);
    const packet = { signed, edits: [edit] }; await timers.enqueue(packet);
    const before = await timers.exportRecovery(); f.fetcher.mockClear(); f.fetcher.mockRejectedValue(new Error("Offline"));
    const archive = await capturePrivateWorkspaceRecovery("owner", "workspace", f.root.identity);
    expect(archive.format).toBe("trackyourtime-private-workspace-recovery-v2");
    if (archive.format !== "trackyourtime-private-workspace-recovery-v2") throw new Error("Missing timer recovery format");
    expect(archive.accountTimer.pending).toEqual([packet]); expect(archive.replica.pending).toEqual([]);
    expect(await timers.exportRecovery()).toEqual(before); expect(f.fetcher).not.toHaveBeenCalled();
  } finally { host.close(); }
});
it("backs up an inventory conflict while refusing to use that conflict for live routing", async () => {
  const f = await fixture(), opened = await openPrivateWorkspaceSession("owner", "workspace"); opened.close();
  const host = await privateAccountInventoryStorageHost("owner");
  try {
    const inventories = await privateAccountWorkspaceInventorySync("owner", host.storage, host.exclusive), before = await inventories.exportRecovery();
    // Re-sign a valid competing version through a separate enrolled device.
    const { createPrivateAccountInventorySync, memoryStorage, signPrivateAccountInventory } = await import("@starter/core");
    const master = decodeSecret(f.root.secrets.master, 32);
    try {
      const peer = await createPrivateAccountInventorySync({ ...f.scope, storage: memoryStorage(), exclusive: (task) => task(), capture: () => () => {}, resolveStorageKey: () => ({ key: master, current: () => true }), resolveIdentity: () => ({ master, signingPrivateKey: f.root.secrets.signingPrivateKey, signingPublicKey: f.root.identity.signingPublicKey, current: () => true }) });
      await peer.enroll(await signPrivateAccountInventory({ ...f.scope, workspaces: before.local.inventory.workspaces, previous: null, signingPrivateKey: f.root.secrets.signingPrivateKey, current: () => true }));
      const incoming = (await peer.exportPending()).pending[0]!, root = await privateInventoryVersionRoot(incoming);
      await expect(inventories.pull({ commit: async () => { throw new Error("Unexpected commit"); }, versions: async () => ({ through: 1, root, next: null, versions: [incoming] }) })).rejects.toThrow(/needs review/);
      const conflicted = await inventories.exportRecovery(); expect(conflicted.conflict).not.toBeNull();
      f.fetcher.mockClear(); f.fetcher.mockRejectedValue(new Error("Offline"));
      await expect(openPrivateWorkspaceSession("owner", "workspace")).rejects.toThrow(/needs review/);
      expect((await capturePrivateWorkspaceRecovery("owner", "workspace", f.root.identity)).inventory).toEqual(conflicted);
      expect(await inventories.exportRecovery()).toEqual(conflicted); expect(f.fetcher).not.toHaveBeenCalled();
    } finally { master.fill(0); }
  } finally { host.close(); }
});

it("bounds journal transport decoding after headers so a stalled response cannot freeze later retries", async () => {
  await fixture();
  const { privateScopedRpc } = await import("./private-scoped-rpc");
  const { rpc } = privateScopedRpc("owner", "privacy.historyChain", 20);
  const fetcher = vi.fn(async (_url: RequestInfo | URL, input?: RequestInit) => {
    expect(input?.signal).toBeTruthy();
    return new Response(new ReadableStream({ start(controller) { input!.signal!.addEventListener("abort", () => controller.error(input!.signal!.reason), { once: true }); } }), { headers: { "content-type": "application/json" } });
  }); vi.stubGlobal("fetch", fetcher);
  await expect(rpc.privacy.chainedChanges.query({ workspaceId: "workspace", after: 1 })).rejects.toThrow(); expect(fetcher).toHaveBeenCalledOnce();
});
