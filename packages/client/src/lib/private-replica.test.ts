// @vitest-environment jsdom
import { IDBFactory } from "fake-indexeddb";
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { memoryStorage, privateMemberKeyFingerprint, signPrivateWorkspaceDirectory, verifyPrivateWorkspaceDirectory } from "@starter/core";
import type { PrivateWorkspaceDirectory } from "@starter/shared";
const state = vi.hoisted(() => ({ origin: "https://api.example.test", changed: null as (() => void) | null }));
vi.mock("./api-origin", () => ({ getApiOrigin: () => state.origin, subscribeApiOrigin: (fn: () => void) => { state.changed = fn; return () => {}; } }));
vi.mock("./desktop-activity", () => ({ desktopActivity: () => null }));
const session = await import("./private-session");
const { privateDirectoryStore, privateWorkspaceReplica, privateWorkspaceStorageHost } = await import("./private-replica");
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
