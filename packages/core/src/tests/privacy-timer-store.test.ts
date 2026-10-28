import assert from "node:assert/strict";
import { it } from "node:test";
import type { PrivateTimerPointer, PrivateTimerTransition, SignedPrivateChainedEdit } from "@starter/shared";
import { canonicalJson, createKeyPair, createSigningPair, encodeSecret, randomSecret } from "../privacy/crypto.js";
import { encryptPrivateRecord, type PlainPrivateRecord } from "../privacy/records.js";
import { privateMemberKeyFingerprint, signPrivateWorkspaceDirectory, verifyPrivateWorkspaceDirectory } from "../privacy/directory.js";
import { signPrivateChainedWorkspaceEdit } from "../privacy/history-chain.js";
import { privateRecordDigest } from "../privacy/workspace-edits.js";
import { privateTimerEditBindings, privateTimerRoot, signPrivateTimer } from "../privacy/account-timer.js";
import { emptyPrivateTimerCheckpoint, verifyPrivateTimerRecoveryState, type PrivateTimerRecoveryState } from "../privacy/timer-recovery.js";
import { createPrivateAccountTimerStore, PrivateTimerCheckpointMissingError, PrivateTimerConflictError } from "../privacy/timer-store.js";
import { PrivateStorageLockedError } from "../privacy/storage.js";
const scope = { server: "https://api.example.test", userId: "owner" }, workspaceId = "workspace";
const empty = (): PrivateTimerRecoveryState => ({ v: 1, confirmed: { checkpoint: emptyPrivateTimerCheckpoint(), signed: null }, pending: [], committed: [], conflict: null });
async function fixture() {
  const encryption = await createKeyPair(), signing = await createSigningPair(), master = randomSecret(), files = new Map<string, string>();
  const member = { userId: scope.userId, role: "owner" as const, canViewOthersTime: true, canViewOthersMoney: true, publicKey: encryption.publicKey, signingPublicKey: signing.publicKey };
  const signed = await signPrivateWorkspaceDirectory({ v: 1, server: scope.server, workspaceId, ownerId: scope.userId, revision: 1, previousDigest: null, members: [member] }, signing.privateKey, null, new Map([[scope.userId, await privateMemberKeyFingerprint(scope.server, member)]]));
  const directory = await verifyPrivateWorkspaceDirectory(signed, { ...scope, workspaceId }, { ownerId: scope.userId, signingPublicKey: signing.publicKey, revision: 0, digest: null });
  let generation = 0, fault = false, lock = Promise.resolve();
  const capture = () => { const at = generation; return () => { if (at !== generation) throw new PrivateStorageLockedError(); }; };
  const exclusive = <T>(work: () => Promise<T>) => { const next = lock.then(work); lock = next.then(() => {}, () => {}); return next; };
  const options = { scope, signingPublicKey: signing.publicKey, exclusive, capture, resolveStorageKey: () => ({ key: master, current: () => true }), storage: {
    getItem: async (key: string) => files.get(key) ?? null,
    setItem: async (key: string, value: string) => { if (fault) throw new Error("Disk full"); files.set(key, value); }, removeItem: async (key: string) => { files.delete(key); },
  } };
  const create = () => createPrivateAccountTimerStore(options), store = await create();
  const enroll = async () => store.restore(empty(), await privateRecordDigest(empty()));
  async function packet(previous: PrivateTimerTransition | null = null, stop = false): Promise<PrivateTimerTransition> {
    const before = previous?.signed.header.current ?? null, current: PrivateTimerPointer | null = stop ? null : { workspaceId, entryId: crypto.randomUUID() }, records = [];
    for (const pointer of [before, current].filter((row): row is PrivateTimerPointer => row !== null)) {
      for (const row of [{ kind: "entries", id: pointer.entryId, authorId: scope.userId, value: { _id: pointer.entryId, authorId: scope.userId, workspaceId, description: "Private timer secret", start: "2026-10-29T01:00:00.000Z", end: pointer === current ? null : "2026-10-29T02:00:00.000Z" } }, { kind: "entryMoney", id: pointer.entryId, authorId: scope.userId, value: { _id: pointer.entryId, hourlyRate: 80 } }] as PlainPrivateRecord[]) records.push(await encryptPrivateRecord(workspaceId, row, [member], 2));
    }
    const edit: SignedPrivateChainedEdit = await signPrivateChainedWorkspaceEdit({ edit: { v: 1, workspaceId, userId: scope.userId, operationId: crypto.randomUUID(), expectedRevision: 1, records, remove: [] }, directory, previousRoot: encodeSecret(randomSecret()), secrets: { privateKey: encryption.privateKey, signingPrivateKey: signing.privateKey }, current: () => true });
    const header = { v: 1 as const, protocol: "trackyourtime-private-account-timer-v1" as const, ...scope, operationId: crypto.randomUUID(), revision: (previous?.signed.header.revision ?? 0) + 1, previousRoot: previous ? await privateTimerRoot(previous.signed) : null, previous: before, current, standardStop: null, edits: await privateTimerEditBindings([edit]) };
    return { signed: await signPrivateTimer(header, signing.privateKey, () => true), edits: [edit] };
  }
  return { store, create, enroll, packet, files, signing, master, lock: () => { generation++; }, fault: (value: boolean) => { fault = value; } };
}
it("never treats a missing timer pin as stopped or overwrites existing local work on restore", async () => {
  const f = await fixture(); assert.equal(await f.store.exportRecovery(), null);
  await assert.rejects(f.store.read(), PrivateTimerCheckpointMissingError); await assert.rejects(f.store.nextPending(), PrivateTimerCheckpointMissingError);
  await assert.rejects(f.store.restore(empty(), "A".repeat(43)), /trusted recovery digest/); assert.equal(f.files.size, 0);
  await f.enroll(); const first = await f.packet(); await f.store.enqueue(first);
  await assert.rejects(f.enroll(), /existing account timer/); assert.equal((await f.store.read()).pending, 1);
  assert.equal(JSON.stringify([...f.files.values()]).includes("Private timer secret"), false);
});
it("retains exact packets across reopen, uncertain writes and a lost confirmation", async () => {
  const f = await fixture(); await f.enroll(); const first = await f.packet(), original = structuredClone(first), saving = f.store.enqueue(first);
  first.signed.header.operationId = crypto.randomUUID(); await saving;
  const reopened = await f.create(); assert.deepEqual(await reopened.nextPending(), original);
  assert.equal((await reopened.enqueue(original)).pending, 1);
  await reopened.accept(original.signed); assert.equal((await reopened.read()).committed, 1); assert.equal((await reopened.read()).pending, 0);
  await assert.rejects(reopened.settle(async () => { throw new Error("Workspace pull failed"); }), /pull failed/); assert.equal((await reopened.read()).committed, 1);
  await reopened.settle(async packet => { assert.deepEqual(packet, original); const peer = await f.create(); assert.equal((await peer.read()).committed, 1); });
  assert.equal((await reopened.read()).committed, 0); assert.equal((await reopened.read()).local.revision, 1);
});
it("preserves local time and a verified conflicting remote timer without rebasing or replay", async () => {
  const f = await fixture(); await f.enroll(); const local = await f.packet(), remote = await f.packet(); await f.store.enqueue(local);
  await assert.rejects(f.store.accept(remote.signed), PrivateTimerConflictError);
  const copy = (await f.store.exportRecovery())!; assert.deepEqual(copy.state.pending, [local]); assert.deepEqual(copy.state.conflict, remote.signed);
  assert.equal(copy.state.confirmed.checkpoint.revision, 0); assert.deepEqual(copy.local.current, local.signed.header.current);
  await assert.rejects(f.store.nextPending(), PrivateTimerConflictError); await assert.rejects(f.store.enqueue(await f.packet(local, true)), PrivateTimerConflictError);
});
it("refuses forged or changed packet bindings without replacing the saved state", async () => {
  const f = await fixture(); await f.enroll(); const first = await f.packet(), before = (await f.store.exportRecovery())!.digest;
  const bad = structuredClone(first); bad.edits[0]!.edit.records[0]!.box.data = "A".repeat(24);
  await assert.rejects(f.store.enqueue(bad), /binding/); assert.equal((await f.store.exportRecovery())!.digest, before);
  await f.store.enqueue(first);
  const changed = structuredClone(first); changed.signed.signature = "A".repeat(86); await assert.rejects(f.store.enqueue(changed), /reused/);
  const forged = structuredClone(first.signed); forged.signature = "A".repeat(86); await assert.rejects(f.store.accept(forged), /signature/); assert.equal((await f.store.read()).pending, 1);
});
it("keeps queued and confirmed packets in an independently pinned recovery state", async () => {
  const f = await fixture(); await f.enroll(); const first = await f.packet(), stop = await f.packet(first, true); await f.store.enqueue(first); await f.store.enqueue(stop); await f.store.accept(first.signed);
  const saved = (await f.store.exportRecovery())!, files = new Map<string, string>();
  const restored = await createPrivateAccountTimerStore({ scope, signingPublicKey: f.signing.publicKey, storage: { getItem: async key => files.get(key) ?? null, setItem: async (key, value) => { files.set(key, value); }, removeItem: async key => { files.delete(key); } }, exclusive: async task => task(), capture: () => () => {}, resolveStorageKey: () => ({ key: f.master, current: () => true }) });
  await verifyPrivateTimerRecoveryState(saved.state, { scope, signingPublicKey: f.signing.publicKey, current: () => true });
  await restored.restore(saved.state, saved.digest); assert.deepEqual(await restored.exportRecovery(), saved);
  await restored.settle(async packet => { assert.deepEqual(packet, first); }); assert.deepEqual(await restored.nextPending(), stop);
  assert.equal(saved.state.committed.length, 1); assert.equal(saved.state.pending.length, 1); assert.equal(saved.local.current, null);
  const changed = structuredClone(saved.state); changed.confirmed.checkpoint.current = null;
  await assert.rejects(verifyPrivateTimerRecoveryState(changed, { scope, signingPublicKey: f.signing.publicKey, current: () => true }), /checkpoint/);
});
it("invalidates queued intent and reconciliation after lock/unlock, retaining packets", async () => {
  const f = await fixture(); await f.enroll(); const first = await f.packet(), pending = f.store.enqueue(first); f.lock(); await assert.rejects(pending, PrivateStorageLockedError); assert.equal((await f.store.read()).pending, 0);
  await f.store.enqueue(first); await f.store.accept(first.signed);
  await assert.rejects(f.store.settle(async () => { f.lock(); }), PrivateStorageLockedError); assert.equal((await f.store.read()).committed, 1);
  f.fault(true); await assert.rejects(f.store.settle(async () => {}), /Disk full/); f.fault(false); assert.equal((await f.store.read()).committed, 1);
  assert.ok(canonicalJson((await f.store.exportRecovery())!.state).includes(first.signed.header.operationId));
});
