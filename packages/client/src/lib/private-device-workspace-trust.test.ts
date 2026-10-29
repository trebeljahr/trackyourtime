// @vitest-environment jsdom
import { IDBFactory } from "fake-indexeddb";
import { webcrypto } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createPrivateDeviceReceiver, encryptPrivateDeviceApproval, privateInventoryVersionRoot } from "@starter/core";
import { encryptPrivateRecord, signPrivateChainedWorkspaceEdit, privateTimerEditBindings, privateTimerWitnessFromPacket, emptyPrivateTimerCheckpoint, encodeSecret, randomSecret, privateRecordDigest, privateTimerRoot, signPrivateTimer, type PrivateTimerRecoveryState } from "@starter/core";
import { API_LEVEL, type PrivateDeviceTransfer, type SignedPrivateInventoryVersion } from "@starter/shared";
import { privateRecoveryFixture, seedPrivateWorkspaceClient } from "@/test-private-recovery";
const state = vi.hoisted(() => ({ origin: "https://api.example.test", changed: null as (() => void) | null }));
vi.mock("./api-origin", () => ({ getApiOrigin: () => state.origin, getChosenWebUrl: () => "https://app.example.test", subscribeApiOrigin: (fn: () => void) => { state.changed = fn; return () => {}; }, whenApiOriginReady: async () => {} }));
vi.mock("./desktop-activity", () => ({ desktopActivity: () => null }));
vi.mock("./server-level", () => ({ currentServerApiLevel: () => API_LEVEL }));
vi.mock("./native-session", () => ({ getNativeToken: () => null }));
vi.mock("./shell", () => ({ clientId: () => "web", isCapacitor: () => false }));
vi.mock("./app-version", () => ({ APP_VERSION: "test" }));
const session = await import("./private-session");
const { createPrivateDeviceUnlock, sealPrivateDeviceUnlock } = await import("./private-device");
const { privateAccountInventoryStorageHost, privateAccountTimerStorageHost, privateAccountTimerStore } = await import("./private-replica");
const { stagePrivateAccountTimer } = await import("./private-timer-staging");
const { privateAccountWorkspaceInventorySync } = await import("./private-inventory-sync");
const { capturePrivateDeviceWorkspaceTrust, restorePrivateDeviceWorkspaceTrust } = await import("./private-device-workspace-trust");
const { privateRoutingRequired } = await import("./private-routing-requirement");
beforeEach(() => { vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("indexedDB", new IDBFactory()); localStorage.clear(); state.origin = "https://api.example.test"; session.lockPrivateData(); session.privateAccountChanged("owner"); });
afterEach(() => { session.lockPrivateData(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function fixture() {
  const f = await privateRecoveryFixture(); await seedPrivateWorkspaceClient(f);
  const versions = new Map<number, SignedPrivateInventoryVersion>();
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(new URL(String(url)).origin).toBe(state.origin); expect(init?.method).toBe("POST"); expect(init?.cache).toBe("no-store"); expect(init?.redirect).toBe("error");
    expect(String(init?.body)).not.toMatch(/master|privateKey|Unsent private|Original private/);
    const input = JSON.parse(String(init?.body)); let data;
    if (String(url).endsWith("privacy.inventoryWrite")) {
      const signed = input.signed as SignedPrivateInventoryVersion; versions.set(signed.header.revision, signed);
      data = { revision: signed.header.revision, root: await privateInventoryVersionRoot(signed) };
    } else {
      expect(String(url)).toMatch(/privacy.inventoryVersions$/);
      const revision = input.through, version = versions.get(revision)!;
      data = { through: revision, root: await privateInventoryVersionRoot(version), next: null, versions: [version] };
    }
    return new Response(JSON.stringify({ result: { data } }), { headers: { "content-type": "application/json" } });
  }); vi.stubGlobal("fetch", fetcher);
  return { ...f, fetcher, versions };
}
async function approval(f: Awaited<ReturnType<typeof fixture>>) {
  const receiver = await createPrivateDeviceReceiver<PrivateDeviceTransfer>({ server: state.origin, userId: "owner" });
  const sealed = await sealPrivateDeviceUnlock("owner", receiver.invite, { ...f.identity, passkeys: [] });
  await receiver.accept(sealed.approval); const value = receiver.confirm(sealed.code);
  expect(JSON.stringify(sealed.approval)).not.toContain(f.secrets.master); return value;
}
async function freshReceiver(value: PrivateDeviceTransfer) {
  session.lockPrivateData(); vi.stubGlobal("indexedDB", new IDBFactory()); localStorage.clear();
  const receiver = await createPrivateDeviceUnlock("owner"), sealed = await encryptPrivateDeviceApproval(receiver.invite, value);
  await receiver.accept(sealed.approval); return { receiver, sealed };
}
async function timerState(f: Awaited<ReturnType<typeof fixture>>) {
  const signed = await signPrivateTimer({ v: 1, protocol: "trackyourtime-private-account-timer-v1", server: state.origin, userId: "owner", operationId: crypto.randomUUID(), revision: 1, previousRoot: null, previous: null, current: { workspaceId: "workspace", entryId: crypto.randomUUID() }, standardStop: null, edits: [{ workspaceId: "workspace", operationId: crypto.randomUUID(), expectedRevision: 1, head: encodeSecret(randomSecret()) }] }, f.secrets.signingPrivateKey, () => true);
  return { v: 1, confirmed: { checkpoint: { revision: 1, root: await privateTimerRoot(signed), current: signed.header.current }, signed }, pending: [], committed: [], conflict: null } satisfies PrivateTimerRecoveryState;
}
async function seedTimer(f: Awaited<ReturnType<typeof fixture>>, timer: PrivateTimerRecoveryState) {
  const staged = await stagePrivateAccountTimer({ server: state.origin, userId: "owner" }, f.secrets, () => {});
  try { await staged.restore(timer, await privateRecordDigest(timer)); } finally { staged.close(); }
}
it("hands over the independently approved timer checkpoint before publishing the receiving keys", async () => {
  const f = await fixture(), timer = await timerState(f); await seedTimer(f, timer);
  const value = await approval(f); expect(value.v).toBe(3);
  if (value.v !== 3) throw new Error("Missing timer transfer protocol");
  expect(value.workspaceTrust.timer).toEqual({ ...timer.confirmed, digest: await privateRecordDigest(timer) });
  const { receiver, sealed } = await freshReceiver(value); expect(session.privateSession("owner")).toBeNull();
  await receiver.confirm(sealed.code); expect(session.privateSession("owner")).toEqual(f.secrets);
  const host = await privateAccountTimerStorageHost("owner");
  try { const timers = await privateAccountTimerStore("owner", host.storage, host.exclusive); expect((await timers.exportRecovery())!.state).toEqual(timer); } finally { host.close(); }
});
it("hands over a confirmed clock anchor without making the donor's optional body witness part of its digest", async () => {
  const f = await fixture(), { openPrivateWorkspaceCoordinatorCopy } = await import("./private-workspace-session");
  const copy = await openPrivateWorkspaceCoordinatorCopy("owner", "workspace");
  let timer: PrivateTimerRecoveryState;
  try {
    const entryId = crypto.randomUUID(), tail = await copy.prepareTail();
    const row = await encryptPrivateRecord("workspace", { kind: "entries", id: entryId, authorId: "owner", value: { _id: entryId, workspaceId: "workspace", authorId: "owner", end: null } }, copy.directory.signed.directory.members, tail.revision + 1);
    const edit = await signPrivateChainedWorkspaceEdit({ edit: { v: 1, workspaceId: "workspace", userId: "owner", operationId: crypto.randomUUID(), expectedRevision: tail.revision, records: [row], remove: [] }, directory: copy.directory, previousRoot: tail.head, secrets: f.secrets, current: () => true });
    const signed = await signPrivateTimer({ v: 1, protocol: "trackyourtime-private-account-timer-v1", server: state.origin, userId: "owner", operationId: crypto.randomUUID(), revision: 1, previousRoot: null, previous: null, current: { workspaceId: "workspace", entryId }, standardStop: null, edits: await privateTimerEditBindings([edit]) }, f.secrets.signingPrivateKey, () => true);
    timer = { v: 1, confirmed: { checkpoint: { revision: 1, root: await privateTimerRoot(signed), current: signed.header.current }, signed }, pending: [], committed: [], conflict: null, currentWitness: (await privateTimerWitnessFromPacket({ signed, edits: [edit] }))! };
  } finally { copy.close(); }
  await seedTimer(f, timer);
  const value = await approval(f); if (value.v !== 3) throw new Error("Missing timer transfer protocol");
  const { currentWitness, ...anchor } = timer; expect(currentWitness).toBeTruthy();
  expect(value.workspaceTrust.timer.digest).toBe(await privateRecordDigest(anchor));
  const { receiver, sealed } = await freshReceiver(value); await receiver.confirm(sealed.code);
  const host = await privateAccountTimerStorageHost("owner");
  try { const timers = await privateAccountTimerStore("owner", host.storage, host.exclusive); expect((await timers.exportRecovery())!.state).toEqual(anchor); } finally { host.close(); }
});
it("keeps the receiving device locked if its approved timer digest or signed coordinates differ", async () => {
  const f = await fixture(), timer = await timerState(f); await seedTimer(f, timer);
  const value = await approval(f); if (value.v !== 3) throw new Error("Missing timer transfer protocol");
  value.workspaceTrust.timer.digest = "A".repeat(43);
  const { receiver, sealed } = await freshReceiver(value); await expect(receiver.confirm(sealed.code)).rejects.toThrow("trusted recovery digest"); expect(session.privateSession("owner")).toBeNull();
});
it("refuses to erase a distinct local timer checkpoint during device restoration", async () => {
  const f = await fixture(), timer = await timerState(f); await seedTimer(f, timer);
  const value = await approval(f), { receiver, sealed } = await freshReceiver(value);
  const local = await timerState(f); await seedTimer(f, local);
  await expect(receiver.confirm(sealed.code)).rejects.toThrow("existing account timer"); expect(session.privateSession("owner")).toBeNull();
  const staged = await stagePrivateAccountTimer({ server: state.origin, userId: "owner" }, f.secrets, () => {});
  try { expect((await staged.exportRecovery())!.state).toEqual(local); } finally { staged.close(); }
});
it("preserves a timer conflict and refuses approving a device with only an empty checkpoint", async () => {
  const f = await fixture(), timer = await timerState(f), conflict: PrivateTimerRecoveryState = { ...timer, confirmed: { checkpoint: emptyPrivateTimerCheckpoint(), signed: null }, conflict: timer.confirmed.signed };
  await seedTimer(f, conflict); await expect(capturePrivateDeviceWorkspaceTrust("owner")).rejects.toThrow("pending timer work");
  const host = await privateAccountTimerStorageHost("owner");
  try { const timers = await privateAccountTimerStore("owner", host.storage, host.exclusive); expect((await timers.exportRecovery())!.state).toEqual(conflict); } finally { host.close(); }
});
it("publishes pending encrypted inventory, hands over only its anchor, and restores that exact version after confirmation", async () => {
  const f = await fixture(), value = await approval(f); expect(value.v).toBe(2); expect(value.workspaceTrust?.inventory.revision).toBe(1); expect(f.versions.size).toBe(1);
  expect(JSON.stringify(value.workspaceTrust)).not.toMatch(/workspaceId|signedPolicy|publicKey/);
  const { receiver, sealed } = await freshReceiver(value); expect(session.privateSession("owner")).toBeNull();
  await receiver.confirm(sealed.code); expect(session.privateSession("owner")).toEqual(f.secrets);
  expect(await privateRoutingRequired({ server: state.origin, userId: "owner" })).toBe(true);
  const host = await privateAccountInventoryStorageHost("owner");
  try { const sync = await privateAccountWorkspaceInventorySync("owner", host.storage, host.exclusive), profile = await sync.read(); expect(profile.inventory.checkpoint).toEqual(value.workspaceTrust!.inventory); expect(profile.pending).toBe(0); } finally { host.close(); }
  receiver.cancel(); expect(session.privateSession("owner")).toEqual(f.secrets);
});
it("rejects substituted ciphertext/checkpoints and stays locked with durable routing protection after failed restoration", async () => {
  const f = await fixture(), value = await approval(f); value.workspaceTrust!.transport.root = "A".repeat(43);
  const { receiver, sealed } = await freshReceiver(value); await expect(receiver.confirm(sealed.code)).rejects.toThrow("approved checkpoint");
  expect(session.privateSession("owner")).toBeNull(); expect(await privateRoutingRequired({ server: state.origin, userId: "owner" })).toBe(true);
});
it("authenticates ciphertext even when the server claims the approved root", async () => {
  const f = await fixture(), value = await approval(f), { receiver, sealed } = await freshReceiver(value);
  const bad = structuredClone(f.versions.get(1)!); bad.box.nonce = "A".repeat(16);
  f.fetcher.mockResolvedValue(new Response(JSON.stringify({ result: { data: { through: 1, root: value.workspaceTrust!.transport.root, next: null, versions: [bad] } } }), { headers: { "content-type": "application/json" } }));
  await expect(receiver.confirm(sealed.code)).rejects.toThrow("signature did not match"); expect(session.privateSession("owner")).toBeNull();
});
it("does not approve when inventory delivery fails and preserves the exact encrypted pending version", async () => {
  await fixture(); const host = await privateAccountInventoryStorageHost("owner");
  try {
    const sync = await privateAccountWorkspaceInventorySync("owner", host.storage, host.exclusive), before = await sync.exportRecovery();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Offline"); }));
    await expect(capturePrivateDeviceWorkspaceTrust("owner")).rejects.toThrow("Offline"); expect(await sync.exportRecovery()).toEqual(before);
  } finally { host.close(); }
});
it("preserves an existing inventory and its pending work rather than replacing it with the approving device's checkpoint", async () => {
  const f = await fixture(), trust = await capturePrivateDeviceWorkspaceTrust("owner");
  const host = await privateAccountInventoryStorageHost("owner");
  try {
    const sync = await privateAccountWorkspaceInventorySync("owner", host.storage, host.exclusive);
    await sync.update([...f.enrollment.inventory.workspaces, { workspaceId: "standard", mode: "standard" }]); const before = await sync.exportRecovery();
    await expect(restorePrivateDeviceWorkspaceTrust("owner", trust!)).rejects.toThrow("Keep or export existing"); expect(await sync.exportRecovery()).toEqual(before);
  } finally { host.close(); }
});
it.each(["cancel", "expiry", "account"])("refuses a late restoration after %s while ciphertext is in flight", async (change) => {
  const f = await fixture(), value = await approval(f), { receiver, sealed } = await freshReceiver(value);
  let resume!: () => void, enter!: () => void; const entered = new Promise<void>((resolve) => { enter = resolve; }), base = f.fetcher.getMockImplementation()!;
  f.fetcher.mockImplementation(async (...args) => { enter(); await new Promise<void>((resolve) => { resume = resolve; }); return base(...args); });
  const pending = receiver.confirm(sealed.code); await entered; expect(session.privateSession("owner")).toBeNull();
  if (change === "cancel") receiver.cancel();
  if (change === "expiry") vi.spyOn(Date, "now").mockReturnValue(receiver.invite.expiresAt + 1);
  if (change === "account") session.privateAccountChanged("other");
  resume(); await expect(pending).rejects.toThrow();
  expect(session.privateSession("owner")).toBeNull(); expect(await privateRoutingRequired({ server: state.origin, userId: "owner" })).toBe(true);
});
it("refuses a root-only approval for an account already requiring workspace trust and refuses legacy payloads", async () => {
  const f = await fixture(), value = await approval(f); session.lockPrivateData();
  const receiver = await createPrivateDeviceUnlock("owner"), sealed = await encryptPrivateDeviceApproval(receiver.invite, { ...value, workspaceTrust: null }); await receiver.accept(sealed.approval);
  await expect(receiver.confirm(sealed.code)).rejects.toThrow("trusted workspace checkpoint"); expect(session.privateSession("owner")).toBeNull();
  const legacy = await createPrivateDeviceUnlock("owner"), old = await encryptPrivateDeviceApproval(legacy.invite, { ...value, v: 1 }); await legacy.accept(old.approval);
  await expect(legacy.confirm(old.code)).rejects.toThrow(); expect(session.privateSession("owner")).toBeNull();
});
it("invalidates an old receiving request when another unlock installs the same account keys", async () => {
  const f = await fixture(), value = await approval(f), { receiver, sealed } = await freshReceiver(value);
  session.installPrivateSession("owner", f.secrets); await expect(receiver.confirm(sealed.code)).rejects.toThrow("changed during"); receiver.cancel(); expect(session.privateSession("owner")).toEqual(f.secrets);
});
