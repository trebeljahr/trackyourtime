import assert from "node:assert/strict";
import { it } from "node:test";
import type { PrivateTimerPointer, PrivateTimerTransition, SignedPrivateChainedEdit } from "@starter/shared";
import { canonicalJson, encodeSecret, createKeyPair, createSigningPair, randomSecret } from "../privacy/crypto.js";
import { privateMemberKeyFingerprint, privateReplicaIdentityFromDirectory, signPrivateWorkspaceDirectory, verifyPrivateWorkspaceDirectory } from "../privacy/directory.js";
import { signPrivateInitialProjectionRoot, verifyPrivateInitialProjection } from "../privacy/projection-snapshot.js";
import { signPrivateChainedWorkspaceEdit, privateWorkspaceChainRoot } from "../privacy/history-chain.js";
import { encryptPrivateRecord, type PlainPrivateRecord } from "../privacy/records.js";
import { privateRecordDigest, privateWorkspaceManifest, privateWorkspaceManifestForReader } from "../privacy/workspace-edits.js";
import { createPrivateWorkspaceReplica, PrivateReplicaCoordinatedEditError, type PrivateReplicaTransport } from "../privacy/replica.js";
import { privateTimerEditBindings, signPrivateTimer } from "../privacy/account-timer.js";
import { emptyPrivateTimerCheckpoint, privateTimerRecoveryWorkspaceOverlay } from "../privacy/timer-recovery.js";
import { createPrivateAccountTimerStore, type PrivateTimerStagePermit } from "../privacy/timer-store.js";
import { segmentedPrivateStorage } from "../privacy/segmented-storage.js";
import { createPrivateStorage, PrivateStorageLockedError } from "../privacy/storage.js";
const scope = { server: "https://api.example.test", userId: "owner" }, stoppedAt = "2026-10-29T02:00:00.000Z";
async function fixture() {
  const encryption = await createKeyPair(), signing = await createSigningPair(), master = randomSecret(), files = new Map<string, string>();
  let generation = 0, failurePrefix = "";
  const capture = () => { const at = generation; return () => { if (at !== generation) throw new PrivateStorageLockedError(); }; };
  const alive = () => { const check = capture(); return () => { try { check(); return true; } catch { return false; } }; };
  const storage = { getItem: async (key: string) => files.get(key) ?? null, setItem: async (key: string, value: string) => { if (failurePrefix && key.startsWith(failurePrefix)) throw new Error("Synthetic disk full"); files.set(key, value); }, removeItem: async (key: string) => { files.delete(key); } };
  const exclusive = <T>(work: () => Promise<T>) => work();
  const options = { scope, storage, exclusive, capture, signingPublicKey: signing.publicKey, resolveStorageKey: () => ({ key: master, current: alive() }) };
  const store = await createPrivateAccountTimerStore(options), initial = { v: 1 as const, confirmed: { checkpoint: emptyPrivateTimerCheckpoint(), signed: null }, pending: [], committed: [], conflict: null };
  await store.restore(initial, await privateRecordDigest(initial));
  const workspaces = new Map<string, Awaited<ReturnType<typeof workspace>>>();
  async function workspace(workspaceId: string) {
    const member = { userId: scope.userId, role: "owner" as const, canViewOthersTime: true, canViewOthersMoney: true, publicKey: encryption.publicKey, signingPublicKey: signing.publicKey }, secrets = { privateKey: encryption.privateKey, signingPrivateKey: signing.privateKey };
    const signed = await signPrivateWorkspaceDirectory({ v: 1, server: scope.server, workspaceId, ownerId: scope.userId, revision: 1, previousDigest: null, members: [member] }, signing.privateKey, null, new Map([[scope.userId, await privateMemberKeyFingerprint(scope.server, member)]]));
    const directory = await verifyPrivateWorkspaceDirectory(signed, { ...scope, workspaceId }, { ownerId: scope.userId, signingPublicKey: signing.publicKey, revision: 0, digest: null });
    const projection = await signPrivateInitialProjectionRoot({ directory, secrets, userId: scope.userId, migrationId: crypto.randomUUID(), sharedRecords: [], ownerPersonalRecords: [], personalDigests: new Map([[scope.userId, await privateRecordDigest([])]]), current: () => true });
    const snapshot = await verifyPrivateInitialProjection({ signed: projection, directory, secrets, scope: { ...scope, workspaceId }, sharedRecords: [], personalRecords: [], current: () => true });
    const replicaOptions = { scope: { ...scope, workspaceId }, storage, exclusive, resolveStorageKey: options.resolveStorageKey, resolveIdentity: () => privateReplicaIdentityFromDirectory(directory, scope.userId, secrets, alive()) };
    const replica = await createPrivateWorkspaceReplica(replicaOptions); await replica.bootstrapProjection(snapshot);
    const journal: SignedPrivateChainedEdit[] = [], ordinaryCalls: SignedPrivateChainedEdit[] = [];
    let baseRevision = 1, baseHead = snapshot.root;
    const head = async () => journal.length ? await privateWorkspaceChainRoot(journal.at(-1)!.chain) : baseHead;
    const validate = async (edit: SignedPrivateChainedEdit) => { assert.equal(edit.edit.expectedRevision, baseRevision + journal.length); assert.equal(edit.chain.header.previousRoot, await head()); };
    const transport: PrivateReplicaTransport = {
      commit: async () => { throw new Error("Unchained transport refused"); }, changes: async () => { throw new Error("Unchained transport refused"); },
      chainedCommit: async input => { await validate(input); ordinaryCalls.push(structuredClone(input)); journal.push(structuredClone(input)); return { revision: baseRevision + journal.length, head: await head() }; },
      chainedChanges: async ({ after, through = baseRevision + journal.length }) => {
        const changes = [];
        for (const row of journal.filter(row => row.edit.expectedRevision >= after && row.edit.expectedRevision < through)) changes.push({ revision: row.edit.expectedRevision + 1, manifest: privateWorkspaceManifestForReader(await privateWorkspaceManifest(row.edit), scope.userId), signature: row.readerSignatures.find(row => row.userId === scope.userId)!.signature, records: row.edit.records, chain: row.chain });
        return { through, next: null, changes };
      },
    };
    const recoveryStorage = segmentedPrivateStorage(await createPrivateStorage({ storage, scope: replicaOptions.scope, resolveKey: options.resolveStorageKey }), capture);
    const replaceRecoveredState = async (state: Awaited<ReturnType<typeof replica.exportRecovery>>) => {
      await recoveryStorage.setItem("replica", JSON.stringify(state));
      if (!journal.length) { baseRevision = state.revision; baseHead = state.head!; }
    };
    return { replica, reopen: () => createPrivateWorkspaceReplica(replicaOptions), directory, transport, journal, ordinaryCalls, validate, replaceRecoveredState };
  }
  for (const workspaceId of ["a", "b"]) workspaces.set(workspaceId, await workspace(workspaceId));
  async function packet(previous: PrivateTimerPointer | null, current: PrivateTimerPointer | null, discard = false): Promise<PrivateTimerTransition> {
    const checkpoint = await store.read(), edits = [];
    for (const workspaceId of [...new Set([previous?.workspaceId, current?.workspaceId].filter((id): id is string => !!id))].sort()) {
      const target = workspaces.get(workspaceId)!, tail = await target.replica.prepareTail(), records = [], remove = [];
      const ids = new Set([previous, current].filter(row => row?.workspaceId === workspaceId).map(row => row!.entryId));
      for (const id of ids) {
        if (discard && previous?.entryId === id && !current) { for (const kind of ["entries", "entryMoney"] as const) remove.push({ kind, id, authorId: scope.userId, readers: [scope.userId] }); continue; }
        const running = current?.workspaceId === workspaceId && current.entryId === id;
        for (const row of [{ kind: "entries", id, authorId: scope.userId, value: { _id: id, workspaceId, authorId: scope.userId, description: "Exact staged private timer", start: "2026-10-29T01:00:00.000Z", end: running ? null : stoppedAt } }, { kind: "entryMoney", id, authorId: scope.userId, value: { _id: id, hourlyRate: 80 } }] as PlainPrivateRecord[]) records.push(await encryptPrivateRecord(workspaceId, row, target.directory.signed.directory.members, tail.revision + 1));
      }
      edits.push(await signPrivateChainedWorkspaceEdit({ edit: { v: 1, workspaceId, userId: scope.userId, operationId: crypto.randomUUID(), expectedRevision: tail.revision, records, remove }, directory: target.directory, previousRoot: tail.head, secrets: { privateKey: encryption.privateKey, signingPrivateKey: signing.privateKey }, current: () => true }));
    }
    const signed = await signPrivateTimer({ v: 1, protocol: "trackyourtime-private-account-timer-v1", ...scope, operationId: crypto.randomUUID(), revision: checkpoint.local.revision + 1, previousRoot: checkpoint.local.root, previous, current, standardStop: null, edits: await privateTimerEditBindings(edits) }, signing.privateKey, () => true);
    return { signed, edits };
  }
  const commit = async (input: PrivateTimerTransition) => { for (const edit of input.edits) await workspaces.get(edit.edit.workspaceId)!.validate(edit); for (const edit of input.edits) workspaces.get(edit.edit.workspaceId)!.journal.push(structuredClone(edit)); };
  async function finish(input: PrivateTimerTransition, permit: PrivateTimerStagePermit) {
    await commit(input); await store.accept(input.signed);
    await store.settle(async original => { assert.deepEqual(original, input); for (const edit of input.edits) { const target = workspaces.get(edit.edit.workspaceId)!; await target.replica.pull(target.transport, edit.edit.expectedRevision + 1); assert.ok(await target.replica.coordinatedReceipt(permit)); } });
  }
  return { store, workspaces, packet, finish, commit, encryption, signing, files, reopenStore: () => createPrivateAccountTimerStore(options), fail: (prefix: string) => { failurePrefix = prefix; }, lock: () => { generation++; } };
}
const point = (workspaceId = "a"): PrivateTimerPointer => ({ workspaceId, entryId: crypto.randomUUID() });
it("seals preceding ordinary work offline and prevents generic sync from sending a coordinated timer", async () => {
  const f = await fixture(), a = f.workspaces.get("a")!;
  await a.replica.enqueue({ records: [{ kind: "tags", id: "tag", authorId: null, value: { name: "Earlier ordinary draft" } }] });
  const tail = await a.replica.prepareTail(), before = await a.replica.exportRecovery(); assert.deepEqual(await a.replica.prepareTail(), tail); assert.deepEqual(await a.replica.exportRecovery(), before);
  const input = await f.packet(null, point()), permit = await f.store.prepare(input); await a.replica.stageCoordinated(permit); await f.store.publish(permit);
  assert.equal((await a.replica.read()).pending, 2); assert.equal((await f.store.read()).pending, 1);
  await a.replica.flushOne(a.transport); assert.equal(a.ordinaryCalls.length, 1);
  await assert.rejects(a.replica.flushOne(a.transport), PrivateReplicaCoordinatedEditError); assert.equal(a.ordinaryCalls.length, 1);
  await f.finish(input, permit); assert.equal((await f.store.read()).committed, 0); assert.equal((await a.replica.read()).pending, 0);
  await a.replica.enqueue({ records: [{ kind: "tags", id: "tag", authorId: null, value: { name: "Later ordinary work" } }] }); await a.replica.flushOne(a.transport);
  assert.equal((await a.replica.coordinatedReceipt(permit))!.head, input.signed.header.edits[0]!.head);
  assert.doesNotMatch(JSON.stringify([...f.files.values()]), /Exact staged private timer|Earlier ordinary draft/);
});
it("repairs an interrupted two-workspace publication without changing ciphertext or duplicating either node", async () => {
  const f = await fixture(), a = f.workspaces.get("a")!, b = f.workspaces.get("b")!, first = point(), second = point("b");
  const start = await f.packet(null, first), initial = await f.store.prepare(start); await a.replica.stageCoordinated(initial); await f.store.publish(initial); await f.finish(start, initial);
  const input = await f.packet(first, second), permit = await f.store.prepare(input); await a.replica.stageCoordinated(permit);
  f.fail(b.replica.namespace); await assert.rejects(b.replica.stageCoordinated(permit), /disk full/); f.fail("");
  const retained = (await f.store.exportRecovery())!; assert.deepEqual(retained.state.preparing, input); await assert.rejects(f.store.nextPending(), /publishing/);
  const reopened = await f.reopenStore(), restored = (await reopened.prepared())!; assert.deepEqual(restored.transition, input);
  const old = await a.replica.exportRecovery(); await a.replica.stageCoordinated(restored); assert.deepEqual(await a.replica.exportRecovery(), old);
  await b.replica.stageCoordinated(restored); await reopened.publish(restored); assert.equal((await reopened.read()).pending, 1);
  await f.finish(input, restored); assert.deepEqual((await reopened.read()).checkpoint.current, second);
  await a.replica.stageCoordinated(initial); assert.equal((await a.replica.read()).records.find(row => row.kind === "entries" && row.id === first.entryId)!.value.end, stoppedAt);
  assert.equal(a.journal.length, 2); assert.equal(b.journal.length, 1);
});
it("backs up a partially staged plan once and refuses a changed optimistic shadow or missing account plan", async () => {
  const f = await fixture(), a = f.workspaces.get("a")!, input = await f.packet(null, point()), permit = await f.store.prepare(input); await a.replica.stageCoordinated(permit);
  const state = (await f.store.exportRecovery())!.state, replica = await a.replica.exportRecovery();
  const options = { state, replica, records: [], scope: { ...scope, workspaceId: "a" }, privateKey: f.encryption.privateKey, current: () => true };
  const view = await privateTimerRecoveryWorkspaceOverlay(options); assert.equal(view.conflict, false); assert.equal(view.records.filter(row => row.kind === "entries").length, 1);
  const changed = structuredClone(replica); changed.pending[0]!.records[0]!.value.description = "Changed after sealing";
  await assert.rejects(privateTimerRecoveryWorkspaceOverlay({ ...options, replica: changed }), /original ciphertext/);
  const missing = structuredClone(state); delete missing.preparing;
  await assert.rejects(privateTimerRecoveryWorkspaceOverlay({ ...options, state: missing }), /original coordinated/);
  assert.equal(canonicalJson((await f.store.exportRecovery())!.state), canonicalJson(state));
});
it("rejects copied permits, another workspace and old key epochs while keeping the durable prepared packet", async () => {
  const f = await fixture(), a = f.workspaces.get("a")!, b = f.workspaces.get("b")!, input = await f.packet(null, point()), permit = await f.store.prepare(input);
  assert.throws(() => a.replica.stageCoordinated({ ...permit } as PrivateTimerStagePermit), /durable timer staging/);
  assert.throws(() => b.replica.stageCoordinated(permit), /does not include/);
  f.lock(); assert.throws(() => a.replica.stageCoordinated(permit), /durable timer staging/); assert.throws(() => f.store.publish(permit), /durable timer staging/);
  const restored = (await f.store.prepared())!; await a.replica.stageCoordinated(restored); await f.store.publish(restored);
  assert.deepEqual(await f.store.nextPending(), input); assert.equal((await a.replica.read()).pending, 1);
});
it("recovers confirmation after a restart before or after the workspace accepted its timer packet", async () => {
  for (const pullFirst of [false, true]) {
    const f = await fixture(), a = f.workspaces.get("a")!, input = await f.packet(null, point()), original = await f.store.prepare(input);
    await a.replica.stageCoordinated(original); await f.store.publish(original); await f.commit(input); await f.store.accept(input.signed);
    if (pullFirst) await a.replica.pull(a.transport);
    f.lock(); const store = await f.reopenStore(), replica = await a.reopen(), permit = (await store.stagingPermit(input.signed.header.operationId))!;
    assert.ok(permit); assert.throws(() => a.replica.stageCoordinated(original), /durable timer staging/);
    await replica.stageCoordinated(permit);
    await store.settle(async packet => { assert.deepEqual(packet, input); if (!pullFirst) await replica.pull(a.transport); assert.ok(await replica.coordinatedReceipt(permit)); });
    assert.equal((await store.read()).committed, 0); assert.equal((await replica.read()).pending, 0); assert.equal(a.journal.length, 1);
  }
});

it("proves an older timer packet against a newer restored workspace root without replay or checkpoint replacement", async () => {
  const f = await fixture(), a = f.workspaces.get("a")!, input = await f.packet(null, point()), permit = await f.store.prepare(input);
  await a.replica.stageCoordinated(permit); await f.store.publish(permit); await f.commit(input); await f.store.accept(input.signed); await a.replica.pull(a.transport);
  await a.replica.enqueue({ records: [{ kind: "tags", id: "later", authorId: null, value: { name: "Later committed work" } }] }); await a.replica.flushOne(a.transport);
  const recovered = await a.replica.exportRecovery(); delete recovered.coordinatedReceipts; await a.replaceRecoveredState(recovered);
  assert.equal(await a.replica.coordinatedReceipt(permit), null); await assert.rejects(a.replica.stageCoordinated(permit), /workspace changed/);
  const result = await a.replica.recoverCoordinatedReceipt(permit, a.transport); assert.equal(result.next, null); assert.ok(result.receipt);
  const after = await a.replica.exportRecovery(); assert.deepEqual(after.records, recovered.records); assert.equal(after.revision, recovered.revision); assert.equal(after.head, recovered.head); assert.deepEqual(after.pending, []); assert.equal(a.journal.length, 2);
  await f.store.settle(async () => { assert.deepEqual(await a.replica.coordinatedReceipt(permit), result.receipt); }); assert.equal((await f.store.read()).committed, 0);
});
it("keeps encrypted proof progress across restart and resumes from its fixed saved boundary", async () => {
  const f = await fixture(), a = f.workspaces.get("a")!, input = await f.packet(null, point()), original = await f.store.prepare(input);
  await a.replica.stageCoordinated(original); await f.store.publish(original); await f.commit(input); await f.store.accept(input.signed); await a.replica.pull(a.transport);
  for (let i = 0; i < 10; i++) { await a.replica.enqueue({ records: [{ kind: "tags", id: "later", authorId: null, value: { name: `Later draft ${i}` } }] }); await a.replica.flushOne(a.transport); }
  const recovered = await a.replica.exportRecovery(); delete recovered.coordinatedReceipts; await a.replaceRecoveredState(recovered);
  const queries: { after: number; through?: number }[] = [], paged: PrivateReplicaTransport = { ...a.transport, chainedChanges: async input => {
    queries.push(input); const page = await a.transport.chainedChanges!(input), changes = page.changes.slice(0, 1), last = changes.at(-1)?.revision ?? input.after;
    return { through: page.through, next: last < page.through ? last : null, changes };
  } };
  const first = await a.replica.recoverCoordinatedReceipt(original, paged); assert.equal(first.receipt, null); assert.equal(first.next, 9);
  assert.equal((await a.replica.exportRecovery()).coordinatedProofs?.[0]?.through, recovered.revision);
  assert.doesNotMatch(JSON.stringify([...f.files.values()]), /Later draft|Exact staged private timer/);
  f.lock(); const store = await f.reopenStore(), reopened = await a.reopen(), permit = (await store.stagingPermit(input.signed.header.operationId))!;
  const result = await reopened.recoverCoordinatedReceipt(permit, paged); assert.ok(result.receipt); assert.equal(result.next, null); assert.equal(queries[8]!.after, 9); assert.ok(queries.every(query => query.through === recovered.revision));
  const after = await reopened.exportRecovery(); assert.equal(after.coordinatedProofs, undefined); assert.equal(after.head, recovered.head); assert.deepEqual(after.records, recovered.records); assert.equal(a.journal.length, 11);
});
it("rejects omitted packets, changed boundaries and a valid signed fork before saving a recovered receipt", async () => {
  const f = await fixture(), a = f.workspaces.get("a")!, input = await f.packet(null, point()), permit = await f.store.prepare(input);
  await a.replica.stageCoordinated(permit); await f.store.publish(permit); await f.commit(input); await f.store.accept(input.signed); await a.replica.pull(a.transport);
  await a.replica.enqueue({ records: [{ kind: "tags", id: "later", authorId: null, value: { name: "Original later edit" } }] }); await a.replica.flushOne(a.transport);
  const recovered = await a.replica.exportRecovery(); delete recovered.coordinatedReceipts; await a.replaceRecoveredState(recovered);
  for (const alter of [(page: Awaited<ReturnType<NonNullable<PrivateReplicaTransport["chainedChanges"]>>>) => ({ ...page, changes: page.changes.slice(1) }), (page: Awaited<ReturnType<NonNullable<PrivateReplicaTransport["chainedChanges"]>>>) => ({ ...page, through: page.through + 1 })]) {
    await assert.rejects(a.replica.recoverCoordinatedReceipt(permit, { ...a.transport, chainedChanges: async input => alter(await a.transport.chainedChanges!(input)) }));
    assert.deepEqual(await a.replica.exportRecovery(), recovered);
  }
  const saved = a.journal[1]!, fork = await signPrivateChainedWorkspaceEdit({ edit: { ...saved.edit, operationId: crypto.randomUUID() }, directory: a.directory, previousRoot: saved.chain.header.previousRoot, secrets: { privateKey: f.encryption.privateKey, signingPrivateKey: f.signing.privateKey }, current: () => true });
  a.journal[1] = fork; await assert.rejects(a.replica.recoverCoordinatedReceipt(permit, a.transport), /saved workspace root/); a.journal[1] = saved;
  assert.deepEqual(await a.replica.exportRecovery(), recovered); assert.equal((await f.store.read()).committed, 1);
  assert.throws(() => a.replica.recoverCoordinatedReceipt({ ...permit } as PrivateTimerStagePermit, a.transport), /durable timer staging/);
});

it("keeps all pinned older timer receipts when the rolling receipt tail reaches capacity", async () => {
  const f = await fixture(), a = f.workspaces.get("a")!, recovered = await a.replica.exportRecovery();
  // A restored confirmed copy with a full historical metadata tail. Only the
  // new commits need encryption/signatures to exercise actual pull/pruning.
  recovered.coordinatedReceipts = Array.from({ length: 1000 }, (_, i) => ({ coordinatorId: crypto.randomUUID(), operationId: crypto.randomUUID(), revision: i + 2, head: encodeSecret(randomSecret()) }));
  recovered.revision = 1001; recovered.head = recovered.coordinatedReceipts.at(-1)!.head; await a.replaceRecoveredState(recovered);
  const pins = recovered.coordinatedReceipts.slice(0, 32).map(row => row.coordinatorId); await a.replica.pinCoordinatedReceipts(pins);
  const pointer = point(), input = await f.packet(null, pointer), permit = await f.store.prepare(input); await a.replica.stageCoordinated(permit); await f.store.publish(permit); await f.finish(input, permit);
  let saved = await a.replica.exportRecovery(); assert.equal(saved.coordinatedReceipts!.length, 1000); assert.ok(pins.every(id => saved.coordinatedReceipts!.some(row => row.coordinatorId === id))); assert.ok(await a.replica.coordinatedReceipt(permit));
  await a.replica.pinCoordinatedReceipts([]);
  const next = await f.packet(pointer, pointer), nextPermit = await f.store.prepare(next); await a.replica.stageCoordinated(nextPermit); await f.store.publish(nextPermit); await f.finish(next, nextPermit);
  saved = await a.replica.exportRecovery(); assert.equal(saved.coordinatedReceipts!.length, 1000); assert.ok(!saved.coordinatedReceipts!.some(row => row.coordinatorId === pins[0])); assert.equal(saved.coordinatedReceiptPins, undefined);
});

it("backs up mixed-age account and workspace copies after a later stop or discard without resurrecting time", async () => {
  for (const discard of [false, true]) {
    const f = await fixture(), a = f.workspaces.get("a")!, pointer = point(), start = await f.packet(null, pointer), permit = await f.store.prepare(start);
    const preparing = (await f.store.exportRecovery())!.state; await a.replica.stageCoordinated(permit); await f.store.publish(permit); const pending = (await f.store.exportRecovery())!.state;
    await f.finish(start, permit); const confirmed = (await f.store.exportRecovery())!.state;
    const stop = await f.packet(pointer, null, discard), stopping = await f.store.prepare(stop); await a.replica.stageCoordinated(stopping); await f.store.publish(stopping); await f.finish(stop, stopping);
    const replica = await a.replica.exportRecovery(), records = (await a.replica.read()).records;
    for (const state of [preparing, pending, confirmed]) {
      const view = await privateTimerRecoveryWorkspaceOverlay({ state, replica, records, scope: { ...scope, workspaceId: "a" }, privateKey: f.encryption.privateKey, current: () => true });
      assert.equal(view.conflict, true); assert.deepEqual(view.records, records);
      assert.equal(view.records.some(row => row.kind === "entries" && row.value.end == null), false);
    }
    assert.equal((await a.replica.checkpoint()).revision, replica.revision); assert.equal(a.journal.length, 2);
  }
});
it("keeps a missing financial counterpart or unexplained timer mismatch invalid at the same workspace checkpoint", async () => {
  const f = await fixture(), a = f.workspaces.get("a")!, pointer = point(), start = await f.packet(null, pointer), permit = await f.store.prepare(start);
  await a.replica.stageCoordinated(permit); await f.store.publish(permit); await f.finish(start, permit);
  const state = (await f.store.exportRecovery())!.state, replica = await a.replica.exportRecovery(), records = (await a.replica.read()).records;
  const options = { state, replica, records, scope: { ...scope, workspaceId: "a" }, privateKey: f.encryption.privateKey, current: () => true };
  await assert.rejects(privateTimerRecoveryWorkspaceOverlay({ ...options, records: records.filter(row => row.kind !== "entryMoney") }), /financial snapshot/);
  await assert.rejects(privateTimerRecoveryWorkspaceOverlay({ ...options, records: [] }), /account checkpoint/);
});
