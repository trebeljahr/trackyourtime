import assert from "node:assert/strict";
import { it } from "node:test";
import { MAX_FAVORITES, type DetailedFavorite } from "@starter/shared";
import { createKeyPair, createSigningPair, randomSecret, encodeSecret } from "../privacy/crypto.js";
import { privateMemberKeyFingerprint, signPrivateWorkspaceDirectory, verifyPrivateWorkspaceDirectory, privateReplicaIdentityFromDirectory } from "../privacy/directory.js";
import { createPrivateWorkspaceReplica } from "../privacy/replica.js";
import { PRIVATE_FAVORITE_EDIT_KINDS, privateFavoriteEdit, type PrivateFavoriteEditPath } from "../privacy/favorite-edit.js";
import { privateFavoriteQuery } from "../privacy/favorite-view.js";
import { signPrivateInitialProjectionRoot, verifyPrivateInitialProjection } from "../privacy/projection-snapshot.js";
import { encryptPrivateRecord, type PlainPrivateRecord } from "../privacy/records.js";
import { privateWorkspaceChainRoot } from "../privacy/history-chain.js";
import { privateWorkspaceManifest, privateWorkspaceManifestForReader, privateRecordDigest } from "../privacy/workspace-edits.js";
import { PrivateStorageLockedError } from "../privacy/storage.js";
import { memoryStorage, type KeyValueStorage } from "../storage.js";
const scope = { server: "https://api.example.test", workspaceId: "workspace", userId: "owner" }, stamp = "2026-10-27T00:00:00.000Z";
async function fixture(backing = memoryStorage()) {
  const pair = await createKeyPair(), signing = await createSigningPair(), master = randomSecret(), secrets = { v: 1 as const, master: encodeSecret(master), privateKey: pair.privateKey, signingPrivateKey: signing.privateKey };
  const person = { userId: scope.userId, role: "owner" as const, canViewOthersTime: true, canViewOthersMoney: true, publicKey: pair.publicKey, signingPublicKey: signing.publicKey };
  const signed = await signPrivateWorkspaceDirectory({ v: 1, server: scope.server, workspaceId: scope.workspaceId, ownerId: scope.userId, revision: 1, previousDigest: null, members: [person] }, signing.privateKey, null, new Map([[scope.userId, await privateMemberKeyFingerprint(scope.server, person)]]));
  const directory = await verifyPrivateWorkspaceDirectory(signed, scope, { ownerId: scope.userId, signingPublicKey: signing.publicKey, revision: 0, digest: null });
  let active = true, epoch = 0, queue = Promise.resolve<unknown>(undefined);
  const current = () => active;
  const originals: PlainPrivateRecord[] = [
    { kind: "clients", id: "client", authorId: null, value: { _id: "client", workspaceId: "workspace", name: "Private client" } },
    { kind: "projects", id: "project", authorId: null, value: { _id: "project", workspaceId: "workspace", name: "Project", color: "#112233", archived: false, clientId: "client", billableDefault: true } },
    { kind: "projectMoney", id: "project", authorId: null, value: { _id: "project", workspaceId: "workspace", hourlyRate: 120 } },
    { kind: "tasks", id: "task", authorId: null, value: { _id: "task", workspaceId: "workspace", name: "Task" } },
  ];
  const records = await Promise.all(originals.map((row) => encryptPrivateRecord(scope.workspaceId, row, [person], 1)));
  const root = await signPrivateInitialProjectionRoot({ directory, secrets, userId: scope.userId, migrationId: crypto.randomUUID(), sharedRecords: records, ownerPersonalRecords: [], personalDigests: new Map([[scope.userId, await privateRecordDigest([])]]), current });
  const snapshot = await verifyPrivateInitialProjection({ signed: root, directory, secrets, scope, sharedRecords: records, personalRecords: [], current });
  const options = { scope, storage: backing, exclusive: <T>(work: () => Promise<T>) => { const next = queue.then(work); queue = next.catch(() => {}); return next; },
    resolveStorageKey: () => { const at = epoch; return active ? { key: master, current: () => active && epoch === at } : null; },
    resolveIdentity: () => { const at = epoch; return active ? privateReplicaIdentityFromDirectory(directory, scope.userId, secrets, () => active && epoch === at) : null; } };
  const replica = await createPrivateWorkspaceReplica(options); await replica.bootstrapProjection(snapshot);
  const edit = (path: PrivateFavoriteEditPath, input: unknown) => {
    const owned = structuredClone(input);
    return replica.transact(PRIVATE_FAVORITE_EDIT_KINDS, ({ records, directory }) => privateFavoriteEdit({ scope, directory, records, current, path, input: owned, now: Date.parse(stamp) }));
  };
  const read = async () => privateFavoriteQuery({ scope, directory, records: (await replica.read()).records, current, input: {} });
  return { replica, edit, read, originals, directory, backing, current, snapshot, reopen: () => createPrivateWorkspaceReplica(options), lock: () => { epoch++; active = false; }, unlock: () => { epoch++; active = true; } };
}
it("serializes concurrent personal pins against the latest optimistic view and persists only one duplicate", async () => {
  const f = await fixture(), input = { description: " Private job ", projectId: "project", taskId: "task" };
  const first = f.edit("favorites.create", input); input.description = "Later input";
  const [a, b] = await Promise.all([first, f.edit("favorites.create", { description: "Private job", projectId: "project", taskId: "task" })]);
  assert.equal((a.result as DetailedFavorite).id, (b.result as DetailedFavorite).id); assert.ok(a.operationId); assert.equal(b.operationId, null);
  assert.deepEqual((await f.read()).map((row) => ({ description: row.description, order: row.order, clientId: row.clientId, billable: row.billable })), [{ description: "Private job", order: 0, clientId: "client", billable: true }]);
  const reopened = await f.reopen(); assert.equal((await reopened.read()).pending, 1); assert.equal((await reopened.read()).records.filter((row) => row.kind === "favorites").length, 1);
  const manifest = await f.backing.getItem(`${f.replica.namespace}${encodeURIComponent("segments:replica:manifest")}`); assert.ok(manifest); assert.doesNotMatch(manifest, /Private job|Private client|favorites/);
});
it("reorders only known pins, retains omitted pins, closes removed gaps and preserves original unknown fields", async () => {
  const f = await fixture(), first = (await f.edit("favorites.create", { description: "First" })).result as DetailedFavorite, second = (await f.edit("favorites.create", { description: "Second" })).result as DetailedFavorite;
  const view = await f.replica.read(), raw = view.records.find((row) => row.id === first.id)!;
  await f.replica.enqueue({ records: [{ ...raw, value: { ...raw.value, legacyNote: { keep: "exact original" } } }] });
  const reordered = await f.edit("favorites.reorder", { ids: [second.id, "foreign", second.id] }); assert.deepEqual((reordered.result as DetailedFavorite[]).map((row) => row.id), [second.id, first.id]);
  assert.deepEqual((await f.replica.read()).records.find((row) => row.id === first.id)!.value.legacyNote, { keep: "exact original" });
  await f.edit("favorites.remove", { id: second.id }); assert.deepEqual((await f.read()).map((row) => [row.id, row.order]), [[first.id, 0]]);
  const sort = (rows: PlainPrivateRecord[]) => rows.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  assert.deepEqual(sort((await f.replica.read()).records.filter((row) => row.kind !== "favorites")), sort(structuredClone(f.originals)));
});
it("validates reference scope, explicit null clients, zero rates, malformed fields and own pin identity", async () => {
  const f = await fixture();
  for (const input of [{ projectId: "foreign" }, { taskId: "foreign" }, { clientId: "foreign" }, { workspaceId: "foreign" }, { userId: "peer" }]) await assert.rejects(f.edit("favorites.create", input));
  assert.equal((await f.replica.checkpoint()).pending, 0);
  const row = (await f.replica.read()).records.find((row) => row.kind === "projectMoney")!; await f.replica.enqueue({ records: [{ ...row, value: { ...row.value, hourlyRate: 0 } }] });
  const pin = (await f.edit("favorites.create", { description: "Unfiled", projectId: "project", clientId: null })).result as DetailedFavorite; assert.equal(pin.billable, false); assert.equal(pin.clientId, null);
  const before = await f.replica.exportRecovery(); await assert.rejects(f.edit("favorites.remove", { id: "foreign" })); assert.deepEqual(await f.replica.exportRecovery(), before);
});
it("does not mistake two legacy project-inferred clients for the same pin", async () => {
  const f = await fixture(); const first = (await f.edit("favorites.create", { description: "Job", projectId: "project" })).result as DetailedFavorite;
  const raw = (await f.replica.read()).records.find((row) => row.id === first.id)!; const { clientId: _legacy, ...legacy } = raw.value; void _legacy;
  await f.replica.enqueue({ records: [{ ...raw, value: legacy }] });
  const duplicate = await f.edit("favorites.create", { description: "Job", projectId: "project" }); assert.equal(duplicate.operationId, null);
  const explicit = (await f.edit("favorites.create", { description: "Job", projectId: "project", clientId: null })).result as DetailedFavorite; assert.notEqual(explicit.id, first.id);
});
it("keeps all originals and returns no success if atomic persistence is dropped", async () => {
  const backing = memoryStorage(); let drop = false;
  const faulty: KeyValueStorage = { ...backing, setItem: async (key, value) => { if (!drop) await backing.setItem(key, value); } };
  const f = await fixture(faulty), before = await f.replica.exportRecovery(); drop = true;
  await assert.rejects(f.edit("favorites.create", { description: "Never acknowledged" })); drop = false;
  assert.deepEqual(await f.replica.exportRecovery(), before); assert.deepEqual(await f.read(), []);
});
it("refuses mutation plans outside the selected domain and no longer revives queued calls after lock/re-unlock", async () => {
  const f = await fixture();
  await assert.rejects(f.replica.transact(["favorites"], () => ({ records: [{ kind: "tags", id: "tag", authorId: null, value: {} }], result: true })), /exceeds/);
  for (const request of [() => f.edit("favorites.create", { description: "Old epoch" }), () => f.replica.enqueue({ records: [{ kind: "favorites", id: "old", authorId: "owner", value: {} }] }), () => f.replica.checkpoint(), () => f.replica.exportRecovery(), () => f.replica.bootstrapProjection(f.snapshot)]) {
    const pending = request(); f.lock(); f.unlock(); await assert.rejects(pending, PrivateStorageLockedError);
  }
  const network = async () => { throw new Error("Must not reach network after a lock"); };
  const transport = { commit: network, changes: network, chainedCommit: network, chainedChanges: network };
  for (const request of [() => f.replica.pull(transport), () => f.replica.flushOne(transport)]) {
    const pending = request(); f.lock(); f.unlock(); await assert.rejects(pending, PrivateStorageLockedError);
  }
  assert.equal((await f.replica.checkpoint()).pending, 0);
});
it("enforces the pin limit and treats an existing pin as a no-op at the limit", async () => {
  const f = await fixture();
  for (let i = 0; i < MAX_FAVORITES; i++) await f.edit("favorites.create", { description: `Job ${i}` });
  assert.equal((await f.read()).length, MAX_FAVORITES); const pending = (await f.replica.checkpoint()).pending;
  await assert.rejects(f.edit("favorites.create", { description: "Too many" }), /limit/);
  assert.equal((await f.edit("favorites.create", { description: "Job 0" })).operationId, null); assert.equal((await f.replica.checkpoint()).pending, pending);
});

it("rejects peer-owned and malformed original pins without editing the source", async () => {
  const f = await fixture(), created = (await f.edit("favorites.create", { description: "Own pin" })).result as DetailedFavorite;
  const records = (await f.replica.read()).records, row = records.find((row) => row.id === created.id)!;
  for (const changed of [{ ...row, authorId: "peer" }, { ...row, value: { ...row.value, userId: "peer" } }, { ...row, value: { ...row.value, workspaceId: "foreign" } }]) {
    const input = records.map((candidate) => candidate.id === row.id ? changed : candidate), before = structuredClone(input);
    assert.throws(() => privateFavoriteEdit({ scope, directory: f.directory, records: input, current: f.current, path: "favorites.remove", input: { id: created.id } })); assert.deepEqual(input, before);
  }
});

it("signs an atomic favorite into a chained personal edit and clears it only after verified journal delivery", async () => {
  const f = await fixture(), edit = await f.edit("favorites.create", { description: "Personal encrypted job" });
  const before = await f.replica.exportRecovery(); let submitted: unknown, change: unknown;
  const rejectLegacy = async (): Promise<never> => { throw new Error("Legacy transport forbidden"); };
  const transport = { commit: rejectLegacy, changes: rejectLegacy,
    chainedCommit: async (input: import("@starter/shared").SignedPrivateChainedEdit) => {
      submitted = structuredClone(input); const manifest = privateWorkspaceManifestForReader(await privateWorkspaceManifest(input.edit), scope.userId);
      change = { revision: 2, manifest, signature: input.readerSignatures.find((row) => row.userId === scope.userId)!.signature, records: input.edit.records, chain: input.chain };
      return { revision: 2, head: await privateWorkspaceChainRoot(input.chain) };
    },
    chainedChanges: async () => ({ through: 2, next: null, changes: [change] as import("@starter/shared").PrivateChainedWorkspaceChange[] }),
  };
  assert.deepEqual(await f.replica.flushOne(transport), { revision: 2, pending: 0 });
  assert.doesNotMatch(JSON.stringify(submitted), /Personal encrypted job|Private client|signingPrivateKey/);
  assert.equal((submitted as import("@starter/shared").SignedPrivateChainedEdit).edit.operationId, edit.operationId);
  assert.equal((submitted as import("@starter/shared").SignedPrivateChainedEdit).edit.records[0]!.grants[0]!.userId, scope.userId);
  assert.deepEqual((await f.read()).map((row) => row.description), ["Personal encrypted job"]);
  assert.equal((await f.replica.checkpoint()).activationRoot, before.activationRoot);
});

it("holds the replica lock across async domain validation and checks the captured key epoch afterward", async () => {
  const f = await fixture(); let entered!: () => void, resume!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { resume = resolve; });
  const first = f.replica.transact(PRIVATE_FAVORITE_EDIT_KINDS, async ({ records, directory }) => {
    entered(); await gate; return privateFavoriteEdit({ scope, directory, records, current: f.current, path: "favorites.create", input: { description: "Async private pin" } });
  });
  await waiting; const second = f.edit("favorites.create", { description: "Async private pin" }); resume();
  const [a, b] = await Promise.all([first, second]); assert.equal((a.result as DetailedFavorite).id, (b.result as DetailedFavorite).id); assert.equal(b.operationId, null); assert.equal((await f.replica.checkpoint()).pending, 1);
  let finish!: () => void, reached!: () => void; const ready = new Promise<void>(resolve => { reached = resolve; });
  const stale = f.replica.transact(["favorites"], async () => { reached(); await new Promise<void>(resolve => { finish = resolve; }); return { records: [], result: "Must not return" }; });
  await ready; f.lock(); f.unlock(); finish(); await assert.rejects(stale, PrivateStorageLockedError); assert.equal((await f.replica.checkpoint()).pending, 1);
});
