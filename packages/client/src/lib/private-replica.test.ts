// @vitest-environment jsdom
import { IDBFactory } from "fake-indexeddb";
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { encryptPrivateRecord, privateRecordDigest, privateInitialSnapshotProjection, signPrivateInitialProjectionRoot, memoryStorage, privateMemberKeyFingerprint, signPrivateWorkspaceDirectory, verifyPrivateWorkspaceDirectory, requirePrivateWorkspacePolicy, accountWorkspacePolicy } from "@starter/core";
import type { PrivateWorkspaceDirectory } from "@starter/shared";
const state = vi.hoisted(() => ({ origin: "https://api.example.test", changed: null as (() => void) | null }));
vi.mock("./api-origin", () => ({ getApiOrigin: () => state.origin, subscribeApiOrigin: (fn: () => void) => { state.changed = fn; return () => {}; } }));
vi.mock("./desktop-activity", () => ({ desktopActivity: () => null }));
const session = await import("./private-session");
const { privateDirectoryStore, privateWorkspaceReplica, privateWorkspaceStorageHost, loadPrivateWorkspaceProjection, privateWorkspacePolicyStore, signPrivateWorkspaceDevicePolicy, privateAccountInventoryStorageHost, privateAccountWorkspaceInventoryStore, signPrivateAccountWorkspaceInventory } = await import("./private-replica");
const exclusive = <T,>(task: () => Promise<T>) => task();
beforeEach(() => { vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("indexedDB", new IDBFactory()); state.origin = "https://api.example.test"; session.lockPrivateData(); session.privateAccountChanged(null); });
afterEach(() => { session.lockPrivateData(); vi.unstubAllGlobals(); });
async function fixture() {
  const root = await session.newPrivateIdentity("owner"); session.installPrivateSession("owner", root.secrets);
  const directory: PrivateWorkspaceDirectory = { v: 1, server: state.origin, workspaceId: "workspace", revision: 1, previousDigest: null, ownerId: "owner", members: [{ userId: "owner", role: "owner", canViewOthersTime: true, canViewOthersMoney: true, publicKey: root.identity.publicKey, signingPublicKey: root.identity.signingPublicKey }] };
  const signed = await signPrivateWorkspaceDirectory(directory, root.secrets.signingPrivateKey, null, new Map([["owner", await privateMemberKeyFingerprint(state.origin, directory.members[0]!)]]));
  const verified = await verifyPrivateWorkspaceDirectory(signed, directory, { ownerId: "owner", signingPublicKey: root.identity.signingPublicKey, revision: 0, digest: null });
  return { root, directory, signed, verified };
}
it("scopes encrypted directory checkpoints and replica views to the unlocked account and server", async () => {
  const f = await fixture(), backing = memoryStorage();
  const store = await privateDirectoryStore("owner", "workspace", backing, exclusive, { ownerId: "owner", signingPublicKey: f.root.identity.signingPublicKey });
  await store.accept(f.signed); expect((await store.read())!.digest).toBe(f.verified.digest);
  const replica = await privateWorkspaceReplica("owner", "workspace", backing, exclusive, () => f.verified);
  await replica.enqueue({ records: [{ kind: "entries", id: "entry", authorId: "owner", value: { description: "Sensitive local work" } }] });
  expect((await replica.read()).records[0]!.value.description).toBe("Sensitive local work");
  session.lockPrivateData(); await expect(replica.read()).rejects.toThrow("Unlock private data"); await expect(store.read()).rejects.toThrow("Unlock private data");
  session.installPrivateSession("owner", f.root.secrets); expect((await replica.read()).pending).toBe(1);
  state.origin = "https://other.example.test"; state.changed?.(); await expect(replica.read()).rejects.toThrow("Unlock private data");
});
it("refuses another workspace's directory and substituted account keys", async () => {
  const f = await fixture(), backing = memoryStorage();
  const wrong = await privateWorkspaceReplica("owner", "elsewhere", backing, exclusive, () => f.verified);
  await expect(wrong.read()).rejects.toThrow("another server or workspace");
  session.installPrivateSession("owner", (await session.newPrivateIdentity("owner")).secrets);
  const mismatch = await privateWorkspaceReplica("owner", "workspace", backing, exclusive, () => f.verified);
  await expect(mismatch.read()).rejects.toThrow("do not match");
});
it("cancels late saves and holds their old recipient grants after verified sharing keys change", async () => {
  const f = await fixture(); let directory = f.verified;
  const replica = await privateWorkspaceReplica("owner", "workspace", memoryStorage(), exclusive, () => directory);
  await replica.enqueue({ records: [{ kind: "entries", id: "entry", authorId: "owner", value: { description: "Retained offline work" } }] });
  const signed = await signPrivateWorkspaceDirectory({ ...f.directory, revision: 2, previousDigest: directory.digest }, f.root.secrets.signingPrivateKey, directory, new Map());
  const next = await verifyPrivateWorkspaceDirectory(signed, f.directory, directory.trust);
  const transport = { commit: vi.fn(async () => { directory = next; return { revision: 1 }; }), changes: vi.fn() };
  await expect(replica.flushOne(transport)).rejects.toThrow("Unlock private data"); expect(transport.changes).not.toHaveBeenCalled();
  expect((await replica.read()).pending).toBe(1); await expect(replica.flushOne(transport)).rejects.toThrow("sharing keys changed"); expect(transport.commit).toHaveBeenCalledTimes(1);
});


it("retains an encrypted outbox across lock, host close and fresh unlock", async () => {
  const f = await fixture();
  const host = await privateWorkspaceStorageHost("owner", "workspace");
  const replica = await privateWorkspaceReplica("owner", "workspace", host.storage, host.exclusive, () => f.verified);
  await replica.enqueue({ records: [{ kind: "entries", id: "durable", authorId: "owner", value: { description: "Keep unsent work after lock" } }] });
  session.lockPrivateData();
  await expect(replica.read()).rejects.toThrow();
  session.installPrivateSession("owner", f.root.secrets);
  const reopened = await privateWorkspaceStorageHost("owner", "workspace");
  try {
    const recovered = await privateWorkspaceReplica("owner", "workspace", reopened.storage, reopened.exclusive, () => f.verified);
    expect((await recovered.read()).records[0]!.value.description).toBe("Keep unsent work after lock");
    expect((await recovered.read()).pending).toBe(1);
    await expect(replica.read()).rejects.toThrow("Private database was closed");
  } finally { reopened.close(); host.close(); }
});

it("binds separated projection downloads and durable installation to the live account unlock", async () => {
  const f = await fixture();
  const shared = [await encryptPrivateRecord("workspace", { kind: "tags", id: "tag", authorId: null, value: { name: "Private original tag" } }, f.directory.members, 1)];
  const signed = await signPrivateInitialProjectionRoot({ sharedRecords: shared, ownerPersonalRecords: [], personalDigests: new Map([["owner", await privateRecordDigest([])]]), migrationId: crypto.randomUUID(), directory: f.verified, userId: "owner", secrets: f.root.secrets, current: () => true });
  const root = await privateRecordDigest(signed.manifest), transport = { root: vi.fn(async () => signed), page: vi.fn(async ({ lane, offset }: { lane: "shared" | "personal"; offset: number }) => ({ offset, next: null, records: lane === "shared" ? privateInitialSnapshotProjection(shared, "owner") : [] })) };
  const host = await privateWorkspaceStorageHost("owner", "workspace");
  let inventoryHost: Awaited<ReturnType<typeof privateAccountInventoryStorageHost>> | undefined;
  try {
    const snapshot = await loadPrivateWorkspaceProjection("owner", "workspace", f.verified, root, transport);
    const policies = await privateWorkspacePolicyStore("owner", "workspace", host.storage, host.exclusive, { activationRoot: root, directoryDigest: f.verified.digest });
    await expect(policies.read()).rejects.toThrow("Trusted workspace policy is missing");
    const signedPolicy = await signPrivateWorkspaceDevicePolicy("owner", snapshot, f.verified, "UTC");
    const pin = await policies.accept(signedPolicy);
    expect(requirePrivateWorkspacePolicy(pin, snapshot.scope, "encrypted").activationRoot).toBe(root);
    expect(() => requirePrivateWorkspacePolicy(pin, snapshot.scope, "standard")).toThrow("Plaintext access is refused");
    inventoryHost = await privateAccountInventoryStorageHost("owner");
    const inventories = await privateAccountWorkspaceInventoryStore("owner", inventoryHost.storage, inventoryHost.exclusive);
    await expect(inventories.read()).rejects.toThrow("Trusted account workspace inventory is missing");
    const signedInventory = await signPrivateAccountWorkspaceInventory("owner", [{ workspaceId: "workspace", mode: "encrypted", signedPolicy }], null);
    const inventory = await inventories.enroll(signedInventory);
    expect(accountWorkspacePolicy(inventory, snapshot.scope, "workspace").mode).toBe("encrypted");
    expect(() => accountWorkspacePolicy(inventory, snapshot.scope, "unknown")).toThrow("absent from the trusted");
    const replica = await privateWorkspaceReplica("owner", "workspace", host.storage, host.exclusive, () => f.verified);
    await replica.bootstrapProjection(snapshot); expect((await replica.read()).records[0]!.value.name).toBe("Private original tag");
    session.lockPrivateData(); session.installPrivateSession("owner", f.root.secrets);
    expect(() => requirePrivateWorkspacePolicy(pin, snapshot.scope, "encrypted")).toThrow("current verified");
    await expect(policies.read()).rejects.toThrow();
    expect(() => accountWorkspacePolicy(inventory, snapshot.scope, "workspace")).toThrow("current verified");
    await expect(inventories.read()).rejects.toThrow();
    const freshInventory = await privateAccountWorkspaceInventoryStore("owner", memoryStorage(), exclusive);
    await expect(freshInventory.enroll(signedInventory)).rejects.toThrow("Trusted account workspace inventory is missing");
    await expect(replica.bootstrapProjection(snapshot)).rejects.toThrow();
    const late = loadPrivateWorkspaceProjection("owner", "workspace", f.verified, root, { ...transport, page: async (input) => { const page = await transport.page(input); session.lockPrivateData(); return page; } });
    await expect(late).rejects.toThrow("changed during delivery");
  } finally { inventoryHost?.close(); host.close(); }
});
