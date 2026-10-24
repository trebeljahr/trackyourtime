import assert from "node:assert/strict";
import { it } from "node:test";
import { createKeyPair, createSigningPair, randomSecret, signPrivateChange } from "../privacy/crypto.js";
import { privateMemberKeyFingerprint, privateReplicaIdentityFromDirectory, signPrivateWorkspaceDirectory, verifyPrivateWorkspaceDirectory } from "../privacy/directory.js";
import { assertPrivateInitialSnapshot, downloadPrivateInitialSnapshot, privateInitialSnapshotProjection, signPrivateInitialSnapshot, verifyPrivateInitialSnapshot, type PrivateInitialSnapshotTransport, type VerifiedPrivateInitialSnapshot } from "../privacy/initial-snapshot.js";
import { createPrivateWorkspaceReplica } from "../privacy/replica.js";
import { encryptPrivateRecord } from "../privacy/records.js";
import { privateRecordDigest, privateWorkspaceManifest, privateWorkspaceManifestForReader } from "../privacy/workspace-edits.js";
import { privateWorkspaceChainRoot, signPrivateChainedWorkspaceEdit } from "../privacy/history-chain.js";
import type { PrivateReplicaTransport } from "../privacy/replica.js";
import { memoryStorage, type KeyValueStorage } from "../storage.js";
import type { PrivateDirectoryMember } from "@starter/shared";
const scope = { server: "https://api.example.test", userId: "owner", workspaceId: "workspace" };
async function fixture(storage: KeyValueStorage = memoryStorage()) {
  const ownerKeys = await createKeyPair(), ownerSigning = await createSigningPair();
  const memberKeys = await createKeyPair(), memberSigning = await createSigningPair();
  const owner = { privateKey: ownerKeys.privateKey, signingPrivateKey: ownerSigning.privateKey };
  const member = { privateKey: memberKeys.privateKey, signingPrivateKey: memberSigning.privateKey };
  const people: PrivateDirectoryMember[] = [
    { userId: "member", role: "member", publicKey: memberKeys.publicKey, signingPublicKey: memberSigning.publicKey, canViewOthersTime: false, canViewOthersMoney: false },
    { userId: "owner", role: "owner", publicKey: ownerKeys.publicKey, signingPublicKey: ownerSigning.publicKey, canViewOthersTime: true, canViewOthersMoney: true },
  ];
  const confirmations = new Map(await Promise.all(people.map(async (p) => [p.userId, await privateMemberKeyFingerprint(scope.server, p)] as const)));
  const signedDirectory = await signPrivateWorkspaceDirectory({ v: 1, server: scope.server, workspaceId: scope.workspaceId, ownerId: "owner", revision: 1, previousDigest: null, members: people }, owner.signingPrivateKey, null, confirmations);
  const directory = await verifyPrivateWorkspaceDirectory(signedDirectory, scope, { ownerId: "owner", signingPublicKey: ownerSigning.publicKey, revision: 0, digest: null });
  let generation = 0, unlocked = true;
  const current = () => { const at = generation; return () => unlocked && generation === at; };
  const recipients = directory.signed.directory.members;
  const inputs = [
    { kind: "tags" as const, id: "tag", authorId: null, value: { name: "Shared label" } },
    { kind: "entries" as const, id: "owner-entry", authorId: "owner", value: { description: "Owner's private task" } },
    { kind: "entries" as const, id: "member-entry", authorId: "member", value: { description: "Member's task" } },
    { kind: "entryMoney" as const, id: "owner-entry", authorId: "owner", value: { hourlyRate: 80 } },
    { kind: "favorites" as const, id: "owner-favorite", authorId: "owner", value: { label: "Owner's private shortcut" } },
    { kind: "favorites" as const, id: "member-favorite", authorId: "member", value: { label: "Member's private shortcut" } },
  ];
  const records = await Promise.all(inputs.map((row) => encryptPrivateRecord(scope.workspaceId, row, recipients, 1)));
  const signed = await signPrivateInitialSnapshot({ records, migrationId: crypto.randomUUID(), userId: "owner", secrets: owner, directory, current: current() });
  const options = (userId = "owner") => ({ scope: { ...scope, userId }, directory, secrets: userId === "owner" ? owner : member, current: current() });
  const reader = (userId = "owner") => signed.readers.find((row) => row.manifest.readerId === userId)!;
  const projection = (userId = "owner") => privateInitialSnapshotProjection(signed.records, userId);
  const transport = (userId = "owner", pageSize = 2): PrivateInitialSnapshotTransport => ({
    manifest: async () => reader(userId),
    page: async ({ offset }) => { const rows = projection(userId); const end = Math.min(offset + pageSize, rows.length); return { offset, next: end < rows.length ? end : null, records: rows.slice(offset, end) }; },
  });
  const storageKey = randomSecret();
  const replicaOptions = { storage, scope, exclusive: <T>(task: () => Promise<T>) => task(), resolveStorageKey: () => ({ key: storageKey, current: current() }), resolveIdentity: () => privateReplicaIdentityFromDirectory(directory, "owner", owner, current()) };
  const replica = await createPrivateWorkspaceReplica(replicaOptions);
  return { owner, member, directory, signed, reader, projection, options, transport, replica, reopen: () => createPrivateWorkspaceReplica(replicaOptions), storage, recipients, lock: () => { unlocked = false; generation++; }, unlock: () => { unlocked = true; generation++; } };
}
it("verifies each complete reader projection without exposing other members' private IDs or counts", async () => {
  const f = await fixture();
  const owner = await downloadPrivateInitialSnapshot({ ...f.options(), transport: f.transport() });
  const member = await downloadPrivateInitialSnapshot({ ...f.options("member"), transport: f.transport("member") });
  assert.equal(owner.records.length, 5); assert.equal(member.records.length, 3);
  assert.doesNotMatch(JSON.stringify(member), /owner-entry|owner-favorite/);
  assert.doesNotMatch(JSON.stringify(owner), /member-favorite/);
  assert.ok(member.records.every((row) => row.grants.length === 1 && row.grants[0]!.userId === "member"));
  assert.equal(member.signed.manifest.recordCount, 3);
  assert.ok(Object.isFrozen(member.records[0]!.box));
});
it("installs the verified initial checkpoint durably, then accepts an ordinary signed revision", async () => {
  const f = await fixture(), snapshot = await downloadPrivateInitialSnapshot({ ...f.options(), transport: f.transport() });
  assert.deepEqual(await f.replica.bootstrap(snapshot), { revision: 1 });
  assert.deepEqual(await f.replica.bootstrap(snapshot), { revision: 1 });
  assert.equal((await f.replica.read()).records.length, 5);
  const record = await encryptPrivateRecord(scope.workspaceId, { kind: "tags", id: "later", authorId: null, value: { name: "New label" } }, f.recipients, 2);
  const signed = await signPrivateChainedWorkspaceEdit({ edit: { v: 1, workspaceId: scope.workspaceId, userId: "owner", operationId: crypto.randomUUID(), expectedRevision: 1, records: [record], remove: [] }, directory: f.directory, previousRoot: snapshot.signed.manifest.root, secrets: f.owner, current: () => true });
  const change = { revision: 2, manifest: privateWorkspaceManifestForReader(await privateWorkspaceManifest(signed.edit), "owner"), signature: signed.readerSignatures.find((r) => r.userId === "owner")!.signature, records: [record], chain: signed.chain };
  await f.replica.pull({ commit: async () => { throw new Error("Unexpected write"); }, changes: async () => { throw new Error("Unexpected legacy downgrade"); }, chainedChanges: async () => ({ through: 2, next: null, changes: [change] }) });
  assert.equal((await f.replica.read()).records.length, 6);
  await assert.rejects(f.replica.bootstrap(snapshot), /cannot replace/);
  for (const key of ["replica", "segments:replica:manifest"]) {
    const raw = await f.storage.getItem(`${f.replica.namespace}${encodeURIComponent(key)}`);
    if (raw) assert.doesNotMatch(raw, /Owner's private|owner-entry|hourlyRate/);
  }
});
it("rejects omission, duplication, modified ciphertext, a forged owner and cross-account/server snapshots", async () => {
  const f = await fixture(), records = f.projection();
  await assert.rejects(verifyPrivateInitialSnapshot({ ...f.options(), signed: f.reader(), records: records.slice(1) }), /omitted or changed/);
  await assert.rejects(verifyPrivateInitialSnapshot({ ...f.options(), signed: f.reader(), records: [...records, records[0]] }), /Duplicate/);
  const changed = structuredClone(records); changed[0]!.box.nonce = "AAAAAAAAAAAAAAAA";
  await assert.rejects(verifyPrivateInitialSnapshot({ ...f.options(), signed: f.reader(), records: changed }), /omitted or changed/);
  const forged = structuredClone(f.reader()); forged.signature = await signPrivateChange(f.member.signingPrivateKey, forged.manifest);
  await assert.rejects(verifyPrivateInitialSnapshot({ ...f.options(), signed: forged, records }), /signature did not match/);
  await assert.rejects(verifyPrivateInitialSnapshot({ ...f.options("member"), signed: f.reader(), records }), /another account/);
  await assert.rejects(verifyPrivateInitialSnapshot({ ...f.options(), scope: { ...scope, server: "https://other.example.test" }, signed: f.reader(), records }), /another account/);
  await assert.rejects(signPrivateInitialSnapshot({ records, migrationId: crypto.randomUUID(), directory: f.directory, userId: "member", secrets: f.member, current: () => true }), /Only the verified workspace owner/);
  const unsigned = JSON.parse(JSON.stringify(await verifyPrivateInitialSnapshot({ ...f.options(), signed: f.reader(), records }))) as VerifiedPrivateInitialSnapshot;
  assert.throws(() => assertPrivateInitialSnapshot(unsigned, scope, f.directory.digest), /current verified/);
});
it("authenticates ciphertext and audience even when the signed delivery hash matches", async () => {
  const f = await fixture(), records = f.projection();
  const corrupt = structuredClone(records); const box = corrupt[0]!.box; box.data = (box.data[0] === "A" ? "B" : "A") + box.data.slice(1);
  const signed = structuredClone(f.reader()); signed.manifest.recordsDigest = await privateRecordDigest(corrupt); signed.signature = await signPrivateChange(f.owner.signingPrivateKey, signed.manifest);
  await assert.rejects(verifyPrivateInitialSnapshot({ ...f.options(), signed, records: corrupt }));
  const extra = structuredClone(records); extra[0]!.grants.push({ ...extra[0]!.grants[0]!, userId: "member" });
  signed.manifest.recordsDigest = await privateRecordDigest(extra); signed.signature = await signPrivateChange(f.owner.signingPrivateKey, signed.manifest);
  await assert.rejects(verifyPrivateInitialSnapshot({ ...f.options(), signed, records: extra }), /another member/);
  assert.equal((await f.replica.read()).revision, 0);
});
it("copies input before asynchronous verification and refuses earlier unlock generations", async () => {
  const f = await fixture(), records = f.projection();
  const verifying = verifyPrivateInitialSnapshot({ ...f.options(), signed: f.reader(), records });
  records[0]!.grants.length = 0;
  const snapshot = await verifying;
  f.lock(); f.unlock();
  await assert.rejects(f.replica.bootstrap(snapshot), /current verified/);
  assert.equal((await f.replica.read()).revision, 0);
});
it("keeps unsent work and refuses incomplete/mixed page boundaries before checkpoint installation", async () => {
  const f = await fixture(), good = f.transport();
  const snapshot = await downloadPrivateInitialSnapshot({ ...f.options(), transport: good });
  await f.replica.enqueue({ records: [{ kind: "tags", id: "offline", authorId: null, value: { name: "Unsent label" } }] });
  await assert.rejects(f.replica.bootstrap(snapshot), /pending edits/);
  await assert.rejects(downloadPrivateInitialSnapshot({ ...f.options(), transport: { ...good, page: async () => ({ offset: 0, next: null, records: [] }) } }), /Invalid initial snapshot page/);
  await assert.rejects(downloadPrivateInitialSnapshot({ ...f.options(), transport: { ...good, page: async (input) => ({ ...await good.page(input), next: null }) } }), /omitted records/);
  await assert.rejects(downloadPrivateInitialSnapshot({ ...f.options(), transport: { ...good, page: async (input) => ({ ...await good.page(input), offset: input.offset + 1 }) } }), /Invalid initial snapshot page/);
  assert.equal((await f.replica.read()).pending, 1);
});
it("verifies a signed empty projection and cancels a download after locking", async () => {
  const f = await fixture();
  const signed = await signPrivateInitialSnapshot({ records: [], migrationId: crypto.randomUUID(), directory: f.directory, userId: "owner", secrets: f.owner, current: () => true });
  const empty = await downloadPrivateInitialSnapshot({ ...f.options(), transport: { manifest: async () => signed.readers.find((r) => r.manifest.readerId === "owner"), page: async () => { throw new Error("Empty snapshot requested a page"); } } });
  assert.equal(empty.records.length, 0);
  const good = f.transport();
  await assert.rejects(downloadPrivateInitialSnapshot({ ...f.options(), transport: { ...good, page: async (input) => { f.lock(); return good.page(input); } } }), /changed during download/);
  f.unlock(); assert.equal((await f.replica.read()).revision, 0);
});
it("loads an initial dataset larger than an ordinary edit without truncating records", async () => {
  const f = await fixture();
  const records = [];
  for (let i = 0; i < 105; i++) records.push(await encryptPrivateRecord(scope.workspaceId, { kind: "tags", id: `tag-${String(i).padStart(3, "0")}`, authorId: null, value: { name: `Imported label ${i}` } }, f.recipients, 1));
  const signed = await signPrivateInitialSnapshot({ records, migrationId: crypto.randomUUID(), userId: "owner", directory: f.directory, secrets: f.owner, current: () => true });
  const projection = privateInitialSnapshotProjection(signed.records, "owner"), calls: number[] = [];
  const snapshot = await downloadPrivateInitialSnapshot({ ...f.options(), transport: {
    manifest: async () => signed.readers.find((r) => r.manifest.readerId === "owner"),
    page: async ({ offset }) => { calls.push(offset); const end = Math.min(offset + 100, projection.length); return { offset, next: end < projection.length ? end : null, records: projection.slice(offset, end) }; },
  } });
  assert.deepEqual(calls, [0, 100]);
  await f.replica.bootstrap(snapshot);
  assert.equal((await f.replica.read()).records.length, 105);
});
it("never acknowledges an initial checkpoint if encrypted backing writes cannot be confirmed", async () => {
  const backing = memoryStorage(); let dropping = false;
  const f = await fixture({ ...backing, setItem: async (key, value) => { if (!dropping) await backing.setItem(key, value); } });
  const snapshot = await downloadPrivateInitialSnapshot({ ...f.options(), transport: f.transport() });
  dropping = true;
  await assert.rejects(f.replica.bootstrap(snapshot), /Could not confirm/);
  dropping = false;
  assert.equal((await f.replica.read()).revision, 0);
  await f.replica.bootstrap(snapshot);
  assert.equal((await f.replica.read()).records.length, 5);
});
it("persists exact chained requests across lost replies and restart, and requires a matching journal proof", async () => {
  const f = await fixture(), snapshot = await downloadPrivateInitialSnapshot({ ...f.options(), transport: f.transport() });
  await f.replica.bootstrap(snapshot);
  await f.replica.enqueue({ records: [{ kind: "tags", id: "queued", authorId: null, value: { name: "Private queued label" } }] });
  const calls: unknown[] = [];
  const journal: Awaited<ReturnType<NonNullable<PrivateReplicaTransport["chainedChanges"]>>>["changes"] = [];
  const transport: PrivateReplicaTransport = {
    commit: async () => { throw new Error("Unexpected legacy write"); }, changes: async () => { throw new Error("Unexpected legacy read"); },
    chainedCommit: async (input) => {
      calls.push(structuredClone(input));
      const prior = journal.find((row) => row.manifest.operationId === input.edit.operationId);
      if (!prior) journal.push({ revision: 2, manifest: privateWorkspaceManifestForReader(await privateWorkspaceManifest(input.edit), "owner"), signature: input.readerSignatures.find((r) => r.userId === "owner")!.signature, records: input.edit.records, chain: input.chain });
      return { revision: 2, head: await privateWorkspaceChainRoot(input.chain) };
    },
    chainedChanges: async ({ after }) => ({ through: journal.length ? 2 : 1, next: null, changes: journal.filter((row) => row.revision > after) }),
  };
  await assert.rejects(f.replica.flushOne({ ...transport, chainedCommit: async (input) => { await transport.chainedCommit!(input); throw new Error("Lost reply"); } }), /Lost reply/);
  f.lock(); f.unlock();
  const reopened = await f.reopen();
  assert.equal((await reopened.read()).pending, 1);
  await assert.rejects(reopened.flushOne({ ...transport, chainedChanges: async () => ({ through: 1, next: null, changes: [] }) }), /no verified journal record/);
  assert.equal((await reopened.read()).pending, 1);
  assert.deepEqual(await reopened.flushOne(transport), { revision: 2, pending: 0 });
  assert.deepEqual(calls[0], calls[2]);
  assert.equal(journal.length, 1); assert.equal((await reopened.read()).records.length, 6);
  assert.equal((await reopened.read()).head, await privateWorkspaceChainRoot(journal[0]!.chain));
});
it("refuses another author's record being replaced or removed even by a valid owner signature", async () => {
  const f = await fixture(), snapshot = await downloadPrivateInitialSnapshot({ ...f.options(), transport: f.transport() });
  await f.replica.bootstrap(snapshot);
  const replacement = await encryptPrivateRecord(scope.workspaceId, { kind: "entries", id: "member-entry", authorId: "owner", value: { description: "Forged self-author claim" } }, f.recipients, 2);
  for (const remove of [false, true]) {
    const signed = await signPrivateChainedWorkspaceEdit({ edit: { v: 1, workspaceId: scope.workspaceId, userId: "owner", operationId: crypto.randomUUID(), expectedRevision: 1, records: remove ? [] : [replacement], remove: remove ? [{ kind: "entries", id: "member-entry", authorId: "owner", readers: ["owner"] }] : [] }, directory: f.directory, previousRoot: snapshot.signed.manifest.root, secrets: f.owner, current: () => true });
    const change = { revision: 2, manifest: privateWorkspaceManifestForReader(await privateWorkspaceManifest(signed.edit), "owner"), signature: signed.readerSignatures.find((r) => r.userId === "owner")!.signature, records: signed.edit.records, chain: signed.chain };
    await assert.rejects(f.replica.pull({ commit: async () => { throw new Error("Unexpected write"); }, changes: async () => { throw new Error("Legacy downgrade"); }, chainedChanges: async () => ({ through: 2, next: null, changes: [change] }) }), /another author's record/);
  }
  assert.equal((await f.replica.read()).revision, 1);
  assert.equal((await f.replica.read()).head, snapshot.signed.manifest.root);
  await assert.rejects(f.replica.enqueue({ records: [{ kind: "entries", id: "member-entry", authorId: "owner", value: {} }] }), /another author's record/);
});
it("keeps a headed checkpoint when the transport offers only legacy history", async () => {
  const f = await fixture();
  await f.replica.bootstrap(await downloadPrivateInitialSnapshot({ ...f.options(), transport: f.transport() }));
  const legacy: PrivateReplicaTransport = { commit: async () => { throw new Error("Legacy write reached network"); }, changes: async () => { throw new Error("Legacy read reached network"); } };
  await assert.rejects(f.replica.pull(legacy), /requires verified chained history/);
  await f.replica.enqueue({ records: [{ kind: "tags", id: "local", authorId: null, value: {} }] });
  await assert.rejects(f.replica.flushOne(legacy), /requires verified chained history/);
  assert.equal((await f.replica.read()).pending, 1);
  assert.equal((await f.replica.read()).revision, 1);
});
