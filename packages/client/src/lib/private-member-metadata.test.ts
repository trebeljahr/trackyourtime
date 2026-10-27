// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { API_LEVEL, signPrivateWorkspaceDirectory, verifyPrivateWorkspaceDirectory } from "@starter/core";
import { privateRecoveryFixture } from "@/test-private-recovery";
const state = vi.hoisted(() => ({ level: 34 as number | null, fetch: vi.fn() }));
vi.mock("./api-origin", () => ({ getApiOrigin: () => "https://api.example.test", subscribeApiOrigin: () => () => {} }));
vi.mock("./desktop-activity", () => ({ desktopActivity: () => null }));
vi.mock("./shell", () => ({ isCapacitor: () => false }));
vi.mock("./server-level", () => ({ currentServerApiLevel: () => state.level }));
vi.mock("./private-scoped-rpc", () => ({ privateScopedRpc: (_userId: string, capability: string) => { expect(capability).toBe("profile.workspaceMemberMetadata"); return { supported: () => {}, rpc: { profile: { workspaceMemberMetadata: { query: state.fetch } } } }; } }));
const session = await import("./private-session");
const { privateWorkspaceMemberMetadata } = await import("./private-member-metadata");
const { privateDatabaseName } = await import("./private-indexed-storage");
const scope = { server: "https://api.example.test", userId: "owner", workspaceId: "workspace" };
const metadata = () => ({ userId: "owner", workspaceId: "workspace", members: [{ userId: "owner", memberId: "auth-owner", name: "Current private-view display name", email: "owner@example.test" }] });
let options: Parameters<typeof privateWorkspaceMemberMetadata>[0];
let secrets: Awaited<ReturnType<typeof privateRecoveryFixture>>["secrets"];
async function rawStore() {
  const name = await privateDatabaseName(scope);
  return new Promise<string>((resolve, reject) => { const open = indexedDB.open(name); open.onerror = () => reject(open.error); open.onsuccess = () => { const db = open.result, tx = db.transaction("ciphertext"), request = tx.objectStore("ciphertext").getAll(); request.onsuccess = () => { const raw = JSON.stringify(request.result); db.close(); resolve(raw); }; request.onerror = () => { db.close(); reject(request.error); }; }; });
}
beforeEach(async () => {
  vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("indexedDB", new IDBFactory()); session.lockPrivateData(); session.privateAccountChanged("owner");
  const f = await privateRecoveryFixture(); secrets = f.secrets; session.installPrivateSession("owner", f.secrets);
  const directory = await verifyPrivateWorkspaceDirectory(f.archive.directory.signed, scope, { ownerId: "owner", signingPublicKey: f.identity.signingPublicKey, revision: 0, digest: null });
  options = { scope, directory, current: () => true }; state.level = API_LEVEL; state.fetch.mockReset().mockImplementation(async () => metadata());
});
afterEach(() => { session.lockPrivateData(); vi.unstubAllGlobals(); });
it("requests only workspace identity metadata, encrypts the device copy and reopens it offline", async () => {
  expect(await privateWorkspaceMemberMetadata(options)).toEqual(metadata()); expect(state.fetch).toHaveBeenCalledWith({ workspaceId: "workspace" });
  const raw = await rawStore(); expect(raw).not.toContain("Current private-view display name"); expect(raw).not.toContain("owner@example.test");
  state.fetch.mockRejectedValue(new TypeError("Failed to fetch")); expect(await privateWorkspaceMemberMetadata(options)).toEqual(metadata());
  state.level = null; state.fetch.mockClear(); expect(await privateWorkspaceMemberMetadata(options)).toEqual(metadata()); expect(state.fetch).not.toHaveBeenCalled();
});
it("uses original local member facts on a cold offline/older server without sending content or inventing metadata", async () => {
  state.level = 33; expect(await privateWorkspaceMemberMetadata(options)).toBeNull(); expect(state.fetch).not.toHaveBeenCalled();
  state.level = API_LEVEL; state.fetch.mockRejectedValue(new TypeError("Offline")); expect(await privateWorkspaceMemberMetadata(options)).toBeNull();
});
it("refuses wrong account/workspace, untrusted participants and financial/permission injection while preserving the valid copy", async () => {
  await privateWorkspaceMemberMetadata(options); const raw = await rawStore();
  for (const bad of [{ ...metadata(), userId: "other" }, { ...metadata(), workspaceId: "other" }, { ...metadata(), members: [{ ...metadata().members[0]!, userId: "outsider" }] }, { ...metadata(), members: [{ ...metadata().members[0]!, hourlyRate: 999, role: "owner" }] }]) {
    state.fetch.mockResolvedValue(bad); await expect(privateWorkspaceMemberMetadata(options)).rejects.toThrow(); expect(await rawStore()).toBe(raw);
  }
});
it("does not hide auth failures behind cached metadata or return/save a response completed after lock", async () => {
  await privateWorkspaceMemberMetadata(options); const raw = await rawStore();
  state.fetch.mockRejectedValue(Object.assign(new Error("No access"), { data: { code: "UNAUTHORIZED" }, cause: new TypeError("Offline") })); await expect(privateWorkspaceMemberMetadata(options)).rejects.toThrow("No access");
  state.fetch.mockRejectedValue(new TypeError("Outer transport wrapper", { cause: Object.assign(new Error("Still unauthorized"), { data: { code: "UNAUTHORIZED" } }) })); await expect(privateWorkspaceMemberMetadata(options)).rejects.toThrow("Outer transport wrapper");
  state.fetch.mockImplementation(async () => { session.lockPrivateData(); return metadata(); }); await expect(privateWorkspaceMemberMetadata(options)).rejects.toThrow("changed"); expect(await rawStore()).toBe(raw);
});

it("does not reuse a previous roster's metadata after a verified directory revision", async () => {
 await privateWorkspaceMemberMetadata(options);
 const prior = options.directory, directory = { ...prior.signed.directory, revision: 2, previousDigest: prior.digest };
 const signed = await signPrivateWorkspaceDirectory(directory, secrets.signingPrivateKey, prior, new Map());
 const next = await verifyPrivateWorkspaceDirectory(signed, scope, { ...prior.trust, revision: prior.signed.directory.revision, digest: prior.digest });
 state.level = null; state.fetch.mockClear();
 expect(await privateWorkspaceMemberMetadata({ ...options, directory: next })).toBeNull(); expect(state.fetch).not.toHaveBeenCalled();
 expect(await privateWorkspaceMemberMetadata(options)).toEqual(metadata());
});
