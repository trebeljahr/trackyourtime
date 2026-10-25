import assert from "node:assert/strict";
import { it } from "node:test";
import { createKeyPair, createSigningPair, randomSecret, canonicalJson, signPrivateChange } from "../privacy/crypto.js";
import { privateMemberKeyFingerprint, privateReplicaIdentityFromDirectory, signPrivateWorkspaceDirectory, verifyPrivateWorkspaceDirectory } from "../privacy/directory.js";
import { encryptPrivateRecord } from "../privacy/records.js";
import { privateInitialSnapshotProjection } from "../privacy/initial-snapshot.js";
import { signPrivateInitialProjectionRoot } from "../privacy/projection-snapshot.js";
import { loadPrivateInitialProjection, type PrivateProjectionTransport } from "../privacy/projection-delivery.js";
import { createPrivateWorkspaceReplica, type PrivateReplicaTransport } from "../privacy/replica.js";
import { privateRecordDigest, privateWorkspaceManifest, privateWorkspaceManifestForReader } from "../privacy/workspace-edits.js";
import { privateWorkspaceChainRoot } from "../privacy/history-chain.js";
import { memoryStorage } from "../storage.js";
import type { EncryptedRecord, PrivateChainedWorkspaceChange } from "@starter/shared";

const scope = { server: "https://api.example.test", userId: "owner", workspaceId: "workspace" };
async function fixture(count = 3) {
  const keys = await createKeyPair(), signing = await createSigningPair(), storage = memoryStorage(), storageKey = randomSecret();
  const secrets = { privateKey: keys.privateKey, signingPrivateKey: signing.privateKey };
  const person = { userId: "owner", role: "owner" as const, canViewOthersTime: true, canViewOthersMoney: true, publicKey: keys.publicKey, signingPublicKey: signing.publicKey };
  const confirmations = new Map([["owner", await privateMemberKeyFingerprint(scope.server, person)]]);
  const signedDirectory = await signPrivateWorkspaceDirectory({ v: 1, server: scope.server, workspaceId: scope.workspaceId, ownerId: "owner", revision: 1, previousDigest: null, members: [person] }, signing.privateKey, null, confirmations);
  const directory = await verifyPrivateWorkspaceDirectory(signedDirectory, scope, { ownerId: "owner", signingPublicKey: signing.publicKey, revision: 0, digest: null });
  const shared: EncryptedRecord[] = [];
  for (let index = 0; index < count; index++) shared.push(await encryptPrivateRecord(scope.workspaceId, { kind: "tags", id: `tag-${index}`, authorId: null, value: { name: `Secret original tag ${index}` } }, [person], 1));
  const personal = [await encryptPrivateRecord(scope.workspaceId, { kind: "favorites", id: "favorite", authorId: "owner", value: { description: "Secret private favorite" } }, [person], 1)];
  let generation = 0, unlocked = true;
  const current = () => { const at = generation; return () => unlocked && generation === at; };
  const signed = await signPrivateInitialProjectionRoot({ sharedRecords: shared, ownerPersonalRecords: personal, personalDigests: new Map([["owner", await privateRecordDigest(personal)]]), migrationId: crypto.randomUUID(), directory, userId: "owner", secrets, current: current() });
  const expectedRoot = await privateRecordDigest(signed.manifest), calls: unknown[] = [];
  const transport: PrivateProjectionTransport = {
    root: async () => structuredClone(signed),
    page: async (input) => { calls.push(input); const rows = privateInitialSnapshotProjection(input.lane === "shared" ? shared : personal, "owner"), end = Math.min(input.offset + 100, rows.length); return { offset: input.offset, next: end < rows.length ? end : null, records: rows.slice(input.offset, end) }; },
  };
  let dropping = false;
  const options = { storage: { ...storage, setItem: async (key: string, value: string) => { if (!dropping) await storage.setItem(key, value); } }, scope, exclusive: <T>(fn: () => Promise<T>) => fn(), resolveStorageKey: () => ({ key: storageKey, current: current() }), resolveIdentity: () => privateReplicaIdentityFromDirectory(directory, "owner", secrets, current()) };
  const replica = await createPrivateWorkspaceReplica(options);
  return { options: () => ({ transport, expectedRoot, scope, directory, secrets, current: current() }), replica, reopen: () => createPrivateWorkspaceReplica(options), storage, signed, calls, lock: () => { unlocked = false; generation++; }, unlock: () => { unlocked = true; generation++; }, drop: (value: boolean) => { dropping = value; } };
}
it("downloads independent bounded lanes and durably installs only the verified common root", async () => {
  const f = await fixture(105), snapshot = await loadPrivateInitialProjection(f.options());
  assert.equal(snapshot.sharedRecords.length, 105); assert.equal(snapshot.personalRecords.length, 1);
  assert.deepEqual(f.calls, [{ migrationId: f.signed.manifest.migrationId, lane: "shared", offset: 0 }, { migrationId: f.signed.manifest.migrationId, lane: "shared", offset: 100 }, { migrationId: f.signed.manifest.migrationId, lane: "personal", offset: 0 }]);
  assert.deepEqual(await f.replica.bootstrapProjection(snapshot), { revision: 1 });
  assert.deepEqual(await f.replica.bootstrapProjection(snapshot), { revision: 1 });
  const view = await (await f.reopen()).read(); assert.equal(view.head, snapshot.root); assert.equal(view.records.length, 106);
  const raw = await f.storage.getItem(`${f.replica.namespace}${encodeURIComponent("segments:replica:manifest")}`);
  assert.doesNotMatch(raw!, /Secret|favorite|tags|owner/);
});
it("rejects untrusted roots and forged signatures before requesting any record pages", async () => {
  const f = await fixture(), options = f.options();
  await assert.rejects(loadPrivateInitialProjection({ ...options, expectedRoot: "A".repeat(43) }), /trusted root/);
  const forged = structuredClone(f.signed); forged.signature = await signPrivateChange((await createSigningPair()).privateKey, forged.manifest);
  await assert.rejects(loadPrivateInitialProjection({ ...options, transport: { ...options.transport, root: async () => forged } }), /signature/);
  assert.equal(f.calls.length, 0); assert.equal((await f.replica.read()).revision, 0);
});
it("rejects omissions, duplicates, mixed lanes and non-progressing pages without saving a partial checkpoint", async () => {
  const f = await fixture(), options = f.options();
  for (const transform of [
    (page: any) => ({ ...page, records: page.records.slice(1) }),
    (page: any) => ({ ...page, records: [...page.records, page.records[0]] }),
    (page: any) => ({ ...page, next: 1, records: [] }),
    (page: any) => ({ ...page, offset: 5 }),
  ]) await assert.rejects(loadPrivateInitialProjection({ ...options, transport: { ...options.transport, page: async (input) => transform(await options.transport.page(input)) } }));
  await assert.rejects(loadPrivateInitialProjection({ ...options, transport: { ...options.transport, page: async (input) => options.transport.page({ ...input, lane: "shared" }) } }), /namespace/);
  assert.equal((await f.replica.read()).revision, 0);
});
it("keeps pending edits and existing checkpoints, rejects forged brands and invalidated unlock generations", async () => {
  const f = await fixture(), snapshot = await loadPrivateInitialProjection(f.options());
  await assert.rejects(f.replica.bootstrapProjection(JSON.parse(JSON.stringify(snapshot))), /current verified/);
  await f.replica.enqueue({ records: [{ kind: "tags", id: "offline", authorId: null, value: { name: "Unsent work" } }] });
  await assert.rejects(f.replica.bootstrapProjection(snapshot), /pending edits/);
  assert.equal((await f.replica.read()).pending, 1);
  f.lock(); f.unlock(); await assert.rejects(f.replica.bootstrapProjection(snapshot), /current verified/);
  const other = await fixture(), options = other.options();
  await assert.rejects(loadPrivateInitialProjection({ ...options, transport: { ...options.transport, page: async (input) => { const page = await options.transport.page(input); other.lock(); return page; } } }), /changed during delivery/);
});
it("requires confirmed encrypted backing writes and retries installation after storage recovers", async () => {
  const f = await fixture(), snapshot = await loadPrivateInitialProjection(f.options()); f.drop(true);
  await assert.rejects(f.replica.bootstrapProjection(snapshot), /Could not confirm/); f.drop(false);
  assert.equal((await f.replica.read()).revision, 0);
  await f.replica.bootstrapProjection(snapshot); assert.equal((await f.replica.read()).records.length, 4);
});
it("extends a v3 root with exact durable chained edits across a lost reply and refuses legacy history", async () => {
  const f = await fixture(), snapshot = await loadPrivateInitialProjection(f.options()); await f.replica.bootstrapProjection(snapshot);
  await f.replica.enqueue({ records: [{ kind: "tags", id: "later", authorId: null, value: { name: "Private later work" } }] });
  const calls: unknown[] = [], journal: PrivateChainedWorkspaceChange[] = [];
  const transport: PrivateReplicaTransport = {
    commit: async () => { throw new Error("Legacy write"); }, changes: async () => { throw new Error("Legacy read"); },
    chainedCommit: async (input) => {
      calls.push(structuredClone(input));
      if (!journal.length) journal.push({ revision: 2, manifest: privateWorkspaceManifestForReader(await privateWorkspaceManifest(input.edit), "owner"), signature: input.readerSignatures[0]!.signature, records: input.edit.records, chain: input.chain });
      return { revision: 2, head: await privateWorkspaceChainRoot(input.chain) };
    },
    chainedChanges: async ({ after }) => ({ through: journal.length ? 2 : 1, next: null, changes: journal.filter((row) => row.revision > after) }),
  };
  await assert.rejects(f.replica.flushOne({ ...transport, chainedCommit: async (input) => { await transport.chainedCommit!(input); throw new Error("Lost reply"); } }), /Lost reply/);
  f.lock(); f.unlock(); const reopened = await f.reopen();
  assert.deepEqual(await reopened.flushOne(transport), { revision: 2, pending: 0 });
  assert.equal(canonicalJson(calls[0]), canonicalJson(calls[1]));
  await assert.rejects(reopened.bootstrapProjection(await loadPrivateInitialProjection(f.options())), /cannot replace/);
  await assert.rejects(reopened.pull({ commit: transport.commit, changes: transport.changes }), /requires verified chained history/);
  assert.equal((await reopened.read()).records.length, 5);
});
