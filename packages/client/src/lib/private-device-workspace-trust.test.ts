// @vitest-environment jsdom
import { IDBFactory } from "fake-indexeddb";
import { webcrypto } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createPrivateDeviceReceiver, encryptPrivateDeviceApproval, privateInventoryVersionRoot } from "@starter/core";
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
const { privateAccountInventoryStorageHost } = await import("./private-replica");
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
