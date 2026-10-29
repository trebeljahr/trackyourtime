import assert from "node:assert/strict";
import { it } from "node:test";
import { canonicalJson, createKeyPair, createSigningPair, decodeSecret, encodeSecret, randomSecret, seal } from "../privacy/crypto.js";
import { privateMemberKeyFingerprint, privateReplicaIdentityFromDirectory, signPrivateWorkspaceDirectory, verifyPrivateWorkspaceDirectory } from "../privacy/directory.js";
import { decryptPrivateRecord, encryptPrivateRecord } from "../privacy/records.js";
import { signPrivateInitialProjectionRoot, verifyPrivateInitialProjection } from "../privacy/projection-snapshot.js";
import { privateInitialSnapshotProjection } from "../privacy/initial-snapshot.js";
import { privateRecordDigest } from "../privacy/workspace-edits.js";
import { signPrivateWorkspacePolicy } from "../privacy/mode-policy.js";
import { createPrivateAccountInventorySync, PrivateInventoryConflictError } from "../privacy/inventory-sync.js";
import { signPrivateAccountInventory } from "../privacy/account-inventory.js";
import { createPrivateWorkspaceReplica } from "../privacy/replica.js";
import { privateInventoryVersionRoot } from "../privacy/inventory-version.js";
import { deriveRecoveryBackupKey } from "../privacy/recovery-backup.js";
import { decryptPrivateWorkspaceBackup, encryptPrivateWorkspaceBackup, PRIVATE_RECOVERY_MAX_BYTES, writePrivateWorkspaceBackup, verifyPrivateRecoveryIdentity, verifyPrivateWorkspaceBackup, verifyPrivateWorkspaceRecoveryArchive } from "../privacy/private-recovery.js";
import { memoryStorage } from "../storage.js";
import { emptyPrivateTimerCheckpoint, type PrivateTimerRecoveryState } from "../privacy/timer-recovery.js";
import { signPrivateChainedWorkspaceEdit, privateWorkspaceChainRoot } from "../privacy/history-chain.js";
import { privateTimerEditBindings, privateTimerRoot, signPrivateTimer } from "../privacy/account-timer.js";
import type { PlainPrivateRecord } from "../privacy/records.js";
const scope = { server: "https://api.example.test", userId: "owner", workspaceId: "workspace" };
async function fixture(padding = 0) {
  const pair = await createKeyPair(), signing = await createSigningPair(), master = randomSecret(), rawRecovery = randomSecret(), state = { open: true }, current = () => state.open;
  const secrets = { v: 1 as const, master: encodeSecret(master), privateKey: pair.privateKey, signingPrivateKey: signing.privateKey }, recoveryKey = encodeSecret(rawRecovery);
  const identity = { publicKey: pair.publicKey, signingPublicKey: signing.publicKey, recovery: await seal(rawRecovery, secrets, `trackyourtime:identity:v1:${scope.server}:${scope.userId}`) }; rawRecovery.fill(0);
  const person = { userId: "owner", role: "owner" as const, canViewOthersTime: true, canViewOthersMoney: true, publicKey: pair.publicKey, signingPublicKey: signing.publicKey };
  const signed = await signPrivateWorkspaceDirectory({ v: 1, server: scope.server, workspaceId: scope.workspaceId, ownerId: "owner", revision: 1, previousDigest: null, members: [person] }, signing.privateKey, null, new Map([["owner", await privateMemberKeyFingerprint(scope.server, person)]]));
  const directory = await verifyPrivateWorkspaceDirectory(signed, scope, { ownerId: "owner", signingPublicKey: signing.publicKey, revision: 0, digest: null });
  const shared = [await encryptPrivateRecord(scope.workspaceId, { kind: "tags", id: "tag", authorId: null, value: { name: "Original private tag", padding: "x".repeat(padding) } }, [person], 1)];
  const personal = [await encryptPrivateRecord(scope.workspaceId, { kind: "favorites", id: "favorite", authorId: "owner", value: { description: "Original private favorite" } }, [person], 1)];
  const root = await signPrivateInitialProjectionRoot({ directory, secrets, userId: "owner", migrationId: crypto.randomUUID(), sharedRecords: shared, ownerPersonalRecords: personal, personalDigests: new Map([["owner", await privateRecordDigest(personal)]]), current });
  const snapshot = await verifyPrivateInitialProjection({ signed: root, directory, secrets, scope, sharedRecords: privateInitialSnapshotProjection(shared, "owner"), personalRecords: privateInitialSnapshotProjection(personal, "owner"), current });
  const signedPolicy = await signPrivateWorkspacePolicy({ reportRangeTimeZone: "UTC", snapshot, directory, secrets, current });
  const inventoryOptions = { ...scope, storage: memoryStorage(), exclusive: <T>(work: () => Promise<T>) => work(), capture: () => () => { if (!current()) throw new Error("Locked recovery"); }, resolveStorageKey: () => ({ key: master, current }), resolveIdentity: () => ({ master, signingPrivateKey: signing.privateKey, signingPublicKey: signing.publicKey, current }) };
  const inventory = await createPrivateAccountInventorySync(inventoryOptions), enrollment = await signPrivateAccountInventory({ ...scope, workspaces: [{ workspaceId: scope.workspaceId, mode: "encrypted", signedPolicy }], previous: null, signingPrivateKey: signing.privateKey, current });
  await inventory.enroll(enrollment);
  const replica = await createPrivateWorkspaceReplica({ scope, storageKey: `replica:${snapshot.root}`, storage: memoryStorage(), exclusive: (work) => work(), resolveStorageKey: () => ({ key: master, current }), resolveIdentity: () => privateReplicaIdentityFromDirectory(directory, "owner", secrets, current) });
  await replica.bootstrapProjection(snapshot);
  await replica.enqueue({ records: [{ kind: "tags", id: "tag", authorId: null, value: { name: "Unsent private rename" } }], remove: [{ kind: "favorites", id: "favorite", authorId: "owner" }] });
  const offline = async () => { throw new Error("Offline after durable signing"); };
  await assert.rejects(replica.flushOne({ commit: offline, changes: offline, chainedCommit: offline, chainedChanges: offline }), /Offline after durable/);
  await replica.enqueue({ records: [{ kind: "tags", id: "another", authorId: null, value: { name: "Another unsent private tag" } }] });
  const capture = async () => verifyPrivateWorkspaceRecoveryArchive({ format: "trackyourtime-private-workspace-recovery-v1", ...scope, createdAt: new Date().toISOString(), identity, inventory: await inventory.exportRecovery(), directory: { signed: directory.signed, digest: directory.digest }, replica: await replica.exportRecovery() }, secrets, current);
  const archive = await capture(), key = await deriveRecoveryBackupKey(recoveryKey, scope);
  return { secrets, master, identity, recoveryKey, state, current, inventory, inventoryOptions, enrollment, replica, archive, key, capture, directory };
}
async function withTimer(f: Awaited<ReturnType<typeof fixture>>, committed = false) {
  const entryId = crypto.randomUUID(), basedOn = f.archive.replica.revision + f.archive.replica.pending.length;
  const records = [];
  for (const row of [{ kind: "entries", id: entryId, authorId: scope.userId, value: { _id: entryId, workspaceId: scope.workspaceId, authorId: scope.userId, description: "Unsent private timer", start: "2026-10-29T01:00:00.000Z", end: null, durationSec: 0, billable: true, currency: "EUR", source: "desktop", createdAt: "2026-10-29T01:00:00.000Z", updatedAt: "2026-10-29T01:00:00.000Z" } }, { kind: "entryMoney", id: entryId, authorId: scope.userId, value: { _id: entryId, hourlyRate: 90 } }] as PlainPrivateRecord[]) records.push(await encryptPrivateRecord(scope.workspaceId, row, f.directory.signed.directory.members, basedOn + 1));
  const edit = await signPrivateChainedWorkspaceEdit({ edit: { v: 1, workspaceId: scope.workspaceId, userId: scope.userId, operationId: crypto.randomUUID(), expectedRevision: basedOn, records, remove: [] }, directory: f.directory, previousRoot: encodeSecret(randomSecret()), secrets: f.secrets, current: f.current });
  const signed = await signPrivateTimer({ v: 1, protocol: "trackyourtime-private-account-timer-v1", server: scope.server, userId: scope.userId, operationId: crypto.randomUUID(), revision: 1, previousRoot: null, previous: null, current: { workspaceId: scope.workspaceId, entryId }, standardStop: null, edits: await privateTimerEditBindings([edit]) }, f.secrets.signingPrivateKey, f.current);
  const packet = { signed, edits: [edit] }, accountTimer: PrivateTimerRecoveryState = { v: 1, confirmed: committed ? { checkpoint: { revision: 1, root: await privateTimerRoot(signed), current: signed.header.current }, signed } : { checkpoint: emptyPrivateTimerCheckpoint(), signed: null }, pending: committed ? [] : [packet], committed: committed ? [packet] : [], conflict: null };
  return { archive: { ...f.archive, format: "trackyourtime-private-workspace-recovery-v2" as const, accountTimer }, packet, entryId };
}
it("backs up pending and confirmed timer packets without losing ordinary edits or offline exports", async () => {
  for (const committed of [false, true]) {
    const f = await fixture(), { archive, packet, entryId } = await withTimer(f, committed);
    const verified = await verifyPrivateWorkspaceRecoveryArchive(archive, f.secrets, f.current); assert.deepEqual(verified, archive);
    const file = await encryptPrivateWorkspaceBackup(verified, f.key, f.secrets, f.current); assert.doesNotMatch(JSON.stringify(file), /Unsent private timer|hourlyRate/);
    assert.deepEqual(await verifyPrivateWorkspaceBackup(file, f.key, f.secrets, f.current, scope), archive);
    const opened = await decryptPrivateWorkspaceBackup(file, f.recoveryKey);
    assert.equal(opened.records.find(row => row.id === entryId && row.kind === "entries")!.value.description, "Unsent private timer");
    assert.equal(opened.records.find(row => row.id === entryId && row.kind === "entryMoney")!.value.hourlyRate, 90);
    assert.equal(opened.records.find(row => row.kind === "tags" && row.id === "tag")!.value.name, "Unsent private rename");
    assert.equal(opened.records.some(row => row.kind === "favorites"), false); assert.equal(opened.confirmedRecords.some(row => row.id === entryId), false);
    assert.deepEqual(opened.accountTimer?.[committed ? "committed" : "pending"], [packet]);
  }
});
it("refuses missing timer dependencies or account history while preserving the input archive", async () => {
  const f = await fixture(), { archive } = await withTimer(f, true), before = canonicalJson(archive);
  const missing = structuredClone(archive); missing.accountTimer.committed = [];
  await assert.rejects(verifyPrivateWorkspaceRecoveryArchive(missing, f.secrets, f.current), /missing confirmed timer/);
  const gap = structuredClone(archive); gap.replica.pending.pop();
  await assert.rejects(verifyPrivateWorkspaceRecoveryArchive(gap, f.secrets, f.current), /dependencies/);
  const wrong = structuredClone(archive); wrong.accountTimer.confirmed.checkpoint.current = null;
  await assert.rejects(verifyPrivateWorkspaceRecoveryArchive(wrong, f.secrets, f.current), /checkpoint/);
  assert.equal(canonicalJson(archive), before);
});
it("does not replay already accepted timer packets over later workspace data or accept an orphan running body", async () => {
  const f = await fixture(), { archive, packet, entryId } = await withTimer(f, true);
  const body = await decryptPrivateRecord(scope.workspaceId, packet.edits[0]!.edit.records[0]!, scope.userId, f.secrets.privateKey);
  const later = await encryptPrivateRecord(scope.workspaceId, { ...body, value: { ...body.value, description: "Later retained label" } }, f.directory.signed.directory.members, 5);
  archive.replica = { ...archive.replica, revision: 5, head: encodeSecret(randomSecret()), pending: [], records: [...archive.replica.records, later, packet.edits[0]!.edit.records[1]!] };
  const file = await encryptPrivateWorkspaceBackup(archive, f.key, f.secrets, f.current), opened = await decryptPrivateWorkspaceBackup(file, f.recoveryKey);
  assert.equal(opened.records.find(row => row.id === entryId && row.kind === "entries")!.value.description, "Later retained label");
  const orphan = structuredClone(archive); orphan.accountTimer = { v: 1, confirmed: { checkpoint: emptyPrivateTimerCheckpoint(), signed: null }, pending: [], committed: [], conflict: null };
  await assert.rejects(verifyPrivateWorkspaceRecoveryArchive(orphan, f.secrets, f.current), /account checkpoint/);
  const missingMoney = structuredClone(archive); missingMoney.replica.records = missingMoney.replica.records.filter(row => row.kind !== "entryMoney");
  await assert.rejects(verifyPrivateWorkspaceRecoveryArchive(missingMoney, f.secrets, f.current), /financial snapshot/);
});
it("preserves both confirmed time and stale offline timer drafts as a flagged recovery preview", async () => {
  const f = await fixture(), { archive, packet, entryId } = await withTimer(f), remoteId = crypto.randomUUID();
  const source = await decryptPrivateRecord(scope.workspaceId, packet.edits[0]!.edit.records[0]!, scope.userId, f.secrets.privateKey);
  const remote = await encryptPrivateRecord(scope.workspaceId, { ...source, id: remoteId, value: { ...source.value, _id: remoteId, description: "Other device's confirmed timer" } }, f.directory.signed.directory.members, 2);
  const money = await encryptPrivateRecord(scope.workspaceId, { kind: "entryMoney", id: remoteId, authorId: scope.userId, value: { _id: remoteId, hourlyRate: 120 } }, f.directory.signed.directory.members, 2);
  archive.replica = { ...archive.replica, revision: 2, head: encodeSecret(randomSecret()), records: [...archive.replica.records, remote, money] };
  const original = canonicalJson(archive), verified = await verifyPrivateWorkspaceRecoveryArchive(archive, f.secrets, f.current);
  const file = await encryptPrivateWorkspaceBackup(verified, f.key, f.secrets, f.current), opened = await decryptPrivateWorkspaceBackup(file, f.recoveryKey);
  assert.equal(opened.recoveryConflict, true);
  assert.equal(opened.confirmedRecords.find(row => row.kind === "entries" && row.id === remoteId)!.value.description, "Other device's confirmed timer");
  assert.equal(opened.records.find(row => row.kind === "entries" && row.id === entryId)!.value.description, "Unsent private timer");
  assert.equal(opened.records.filter(row => row.kind === "entries" && row.value.end === null).length, 2);
  assert.deepEqual(opened.pending, archive.replica.pending); assert.deepEqual(opened.accountTimer, archive.accountTimer);
  assert.deepEqual(await verifyPrivateWorkspaceBackup(file, f.key, f.secrets, f.current, scope), archive); assert.equal(canonicalJson(archive), original);
});
it("opens a complete private device copy offline and keeps exact submitted/unsent work separate from confirmed records", async () => {
  const f = await fixture();
  assert.deepEqual(await verifyPrivateRecoveryIdentity(f.identity, f.recoveryKey, f.secrets, scope, f.current), f.identity);
  const file = await encryptPrivateWorkspaceBackup(f.archive, f.key, f.secrets, f.current), raw = JSON.stringify(file);
  assert.doesNotMatch(raw, /Original private tag|Original private favorite|Unsent private rename|signingPrivateKey/);
  for (const secret of [f.secrets.master, f.secrets.privateKey.d!, f.secrets.signingPrivateKey.d!, f.recoveryKey]) assert.equal(raw.includes(secret), false);
  assert.deepEqual(await verifyPrivateWorkspaceBackup(file, f.key, f.secrets, f.current, scope), f.archive);
  const opened = await decryptPrivateWorkspaceBackup(file, f.recoveryKey);
  assert.equal(opened.confirmedRecords.length, 2); assert.equal(opened.records.length, 2);
  assert.equal(opened.records.find((row) => row.id === "tag")!.value.name, "Unsent private rename");
  assert.equal(opened.records.some((row) => row.kind === "favorites"), false);
  assert.equal(opened.pending.length, 2); assert.equal(opened.pending[0]!.submitted === null, false); assert.equal(opened.pending[1]!.submitted, null);
  assert.equal(JSON.stringify(opened.pending), JSON.stringify(f.archive.replica.pending));
  assert.equal(opened.checkpoint.activationRoot, f.archive.replica.activationRoot);
  const exported = JSON.stringify(opened);
  for (const secret of [f.secrets.master, f.secrets.privateKey.d!, f.secrets.signingPrivateKey.d!, f.recoveryKey]) assert.equal(exported.includes(secret), false);
  assert.equal("identity" in opened, false); assert.equal("inventory" in opened, false);
  assert.ok(f.key.some((byte) => byte !== 0)); assert.ok(f.master.some((byte) => byte !== 0));
});
it("authenticates every bounded part, its position and the complete dataset", async () => {
  const f = await fixture(300_000), file = await encryptPrivateWorkspaceBackup(f.archive, f.key, f.secrets, f.current);
  assert.ok(file.parts.length > 1);
  const changed = structuredClone(file); changed.parts[0]!.data = (changed.parts[0]!.data[0] === "A" ? "B" : "A") + changed.parts[0]!.data.slice(1);
  await assert.rejects(verifyPrivateWorkspaceBackup(changed, f.key, f.secrets, f.current, scope));
  const swapped = structuredClone(file); [swapped.parts[0], swapped.parts[1]] = [swapped.parts[1]!, swapped.parts[0]!];
  await assert.rejects(verifyPrivateWorkspaceBackup(swapped, f.key, f.secrets, f.current, scope));
  const truncated = structuredClone(file); truncated.parts.pop();
  await assert.rejects(decryptPrivateWorkspaceBackup(truncated, f.recoveryKey), /incomplete/);
  const header = structuredClone(file); header.header.createdAt = new Date(0).toISOString();
  await assert.rejects(decryptPrivateWorkspaceBackup(header, f.recoveryKey));
  await assert.rejects(decryptPrivateWorkspaceBackup(file, encodeSecret(randomSecret())));
  await assert.rejects(verifyPrivateWorkspaceBackup(file, f.key, f.secrets, f.current, { ...scope, workspaceId: "other" }), /another account/);
  const oversized = structuredClone(file);
  oversized.manifest = await seal(f.key, { v: 1, bytes: PRIVATE_RECOVERY_MAX_BYTES + 1, parts: file.header.parts, digest: "A".repeat(43) }, canonicalJson({ header: file.header, part: "manifest" }));
  await assert.rejects(verifyPrivateWorkspaceBackup(oversized, f.key, f.secrets, f.current, scope));
});
it("requires setup to reopen the actual recovery envelope and match the unlocked keys", async () => {
  const f = await fixture();
  await assert.rejects(verifyPrivateRecoveryIdentity(f.identity, encodeSecret(randomSecret()), f.secrets, scope, f.current));
  const wrong = { ...f.identity, publicKey: (await createKeyPair()).publicKey };
  await assert.rejects(verifyPrivateRecoveryIdentity(wrong, f.recoveryKey, f.secrets, scope, f.current), /does not match/);
  const corrupted = structuredClone(f.identity); corrupted.recovery.data = "A".repeat(corrupted.recovery.data.length);
  await assert.rejects(verifyPrivateRecoveryIdentity(corrupted, f.recoveryKey, f.secrets, scope, f.current));
});
it("preserves an inventory conflict and all private outbox work without adopting or replaying either version", async () => {
  const f = await fixture(), peer = await createPrivateAccountInventorySync({ ...f.inventoryOptions, storage: memoryStorage() });
  await peer.enroll(f.enrollment); const incoming = (await peer.exportPending()).pending[0]!, root = await privateInventoryVersionRoot(incoming);
  await assert.rejects(f.inventory.pull({ commit: async () => { throw new Error("Must not commit"); }, versions: async () => ({ through: 1, root, next: null, versions: [incoming] }) }), PrivateInventoryConflictError);
  const archive = await f.capture(), file = await encryptPrivateWorkspaceBackup(archive, f.key, f.secrets, f.current), opened = await decryptPrivateWorkspaceBackup(file, f.recoveryKey);
  assert.equal(opened.accountInventory.conflict, true); assert.equal(opened.pending.length, 2);
  assert.deepEqual((await verifyPrivateWorkspaceBackup(file, f.key, f.secrets, f.current, scope)).inventory.conflict, incoming);
  assert.equal((await f.inventory.status()).conflict, true); assert.equal((await f.replica.read()).pending, 2);
});
it("refuses mismatched activation/directory scope, duplicate records and ciphertext for another reader", async () => {
  const f = await fixture();
  const noRoot = structuredClone(f.archive); noRoot.replica.activationRoot = null;
  await assert.rejects(verifyPrivateWorkspaceRecoveryArchive(noRoot, f.secrets, f.current), /activation checkpoint/);
  const directory = structuredClone(f.archive); directory.directory.digest = "A".repeat(43);
  await assert.rejects(verifyPrivateWorkspaceRecoveryArchive(directory, f.secrets, f.current), /directory differs/);
  const duplicate = structuredClone(f.archive); duplicate.replica.records.push(duplicate.replica.records[0]!);
  await assert.rejects(verifyPrivateWorkspaceRecoveryArchive(duplicate, f.secrets, f.current), /duplicate/);
  const foreign = structuredClone(f.archive); foreign.replica.records[0]!.grants[0]!.userId = "other";
  await assert.rejects(verifyPrivateWorkspaceRecoveryArchive(foreign, f.secrets, f.current), /unrelated/);
  assert.equal((await f.replica.read()).pending, 2);
});
it("snapshots input before async work and cancels encryption/opening after a lock or caller cancellation", async () => {
  const f = await fixture(), original = f.archive.replica.pending[1]!.records[0]!.value.name;
  const saving = encryptPrivateWorkspaceBackup(f.archive, f.key, f.secrets, f.current);
  f.archive.replica.pending[1]!.records[0]!.value.name = "Mutation after capture";
  const file = await saving, opened = await decryptPrivateWorkspaceBackup(file, f.recoveryKey);
  assert.equal(opened.pending[1]!.records[0]!.value.name, original);
  const late = encryptPrivateWorkspaceBackup(await f.capture(), f.key, f.secrets, f.current); f.state.open = false;
  await assert.rejects(late, /changed|Locked/);
  await assert.rejects(decryptPrivateWorkspaceBackup(file, f.recoveryKey, undefined, () => false), /canceled/);
  assert.equal(decodeSecret(f.secrets.master, 32).length, 32);
});

it("writes only ciphertext and keeps earlier files when readback fails or permission is revoked", async () => {
  const f = await fixture(), files = new Map<string, string>([["older.tytrecovery", "original untouched file"]]);
  let granted = true, corrupted = false, captures = 0;
  const folder = { granted: async () => granted, write: async (name: string, data: string) => { files.set(name, data); }, read: async (name: string) => corrupted ? "broken" : files.get(name)!, remove: async (name: string) => { files.delete(name); } };
  const options = { scope, key: f.key, secrets: () => f.secrets, current: f.current, folder, snapshot: async () => { captures++; return f.archive; } };
  const result = await writePrivateWorkspaceBackup(options); assert.equal(files.size, 2); assert.equal(result.createdAt, f.archive.createdAt);
  assert.doesNotMatch(files.get(result.fileName)!, /Unsent private rename|signingPrivateKey/);
  const before = new Map(files); corrupted = true;
  await assert.rejects(writePrivateWorkspaceBackup(options)); assert.deepEqual(files, before);
  granted = false; const count = captures;
  await assert.rejects(writePrivateWorkspaceBackup(options), /folder access is unavailable/); assert.equal(captures, count); assert.deepEqual(files, before);
  assert.ok(f.key.some((byte) => byte !== 0));
});

it("publishes private inventory only after the durable client routing fence succeeds and preserves existing data on refusal", async () => {
  const f = await fixture(), files = new Map<string, string>(), phases: string[] = []; let allow = false;
  const storage = { getItem: async (key: string) => files.get(key) ?? null, setItem: async (key: string, value: string) => { files.set(key, value); }, removeItem: async (key: string) => { files.delete(key); } };
  const sync = await createPrivateAccountInventorySync({ ...f.inventoryOptions, storage, beforePrivateState: async (phase, digest) => { phases.push(phase); assert.match(digest, /^[A-Za-z0-9_-]{43}$/); if (!allow) throw new Error("Routing storage denied"); } });
  await assert.rejects(sync.enroll(f.enrollment), /Routing storage denied/); assert.equal(files.size, 0); assert.deepEqual(phases, ["publish"]);
  allow = true; await sync.enroll(f.enrollment); const before = new Map(files); allow = false;
  await assert.rejects(sync.read(), /Routing storage denied/); assert.deepEqual(files, before); assert.ok(phases.includes("read"));
});

it("round-trips mixed-age backups after later stops and discards without reviving the older account timer", async () => {
  for (const discard of [false, true]) {
    const f = await fixture(), { archive, packet, entryId } = await withTimer(f, true);
    const originalBody = await decryptPrivateRecord(scope.workspaceId, packet.edits[0]!.edit.records[0]!, scope.userId, f.secrets.privateKey);
    const stopped = await encryptPrivateRecord(scope.workspaceId, { ...originalBody, value: { ...originalBody.value, end: "2026-10-29T02:00:00.000Z", durationSec: 3600 } }, f.directory.signed.directory.members, 5);
    archive.replica = { ...archive.replica, revision: 5, head: encodeSecret(randomSecret()), pending: [], records: [...archive.replica.records, ...(discard ? [] : [stopped, packet.edits[0]!.edit.records[1]!])] };
    const original = canonicalJson(archive), file = await encryptPrivateWorkspaceBackup(archive, f.key, f.secrets, f.current), opened = await decryptPrivateWorkspaceBackup(file, f.recoveryKey);
    assert.equal(opened.recoveryConflict, true); assert.deepEqual(opened.accountTimer, archive.accountTimer); assert.deepEqual(opened.pending, []);
    assert.equal(opened.records.some(row => row.kind === "entries" && row.value.end == null), false);
    assert.equal(opened.records.filter(row => row.kind === "entries" && row.id === entryId).length, discard ? 0 : 1);
    assert.deepEqual(await verifyPrivateWorkspaceBackup(file, f.key, f.secrets, f.current, scope), archive); assert.equal(canonicalJson(archive), original);
    assert.doesNotMatch(JSON.stringify(file), /Unsent private timer|hourlyRate/);
    if (!discard) {
      const missing = structuredClone(archive); missing.replica.records = missing.replica.records.filter(row => row.kind !== "entryMoney");
      await assert.rejects(verifyPrivateWorkspaceRecoveryArchive(missing, f.secrets, f.current), /financial snapshot/);
    }
  }
});

it("keeps a pending standard handoff body encrypted in the user-held backup and restores its exact retry packet", async () => {
  const f = await fixture(), { archive, packet: start, entryId } = await withTimer(f, true), revision = start.edits[0]!.edit.expectedRevision + 1, root = await privateWorkspaceChainRoot(start.edits[0]!.chain);
  const body = await decryptPrivateRecord(scope.workspaceId, start.edits[0]!.edit.records[0]!, scope.userId, f.secrets.privateKey);
  const stopped = await encryptPrivateRecord(scope.workspaceId, { ...body, value: { ...body.value, end: "2026-10-29T02:00:00.000Z", durationSec: 3600 } }, f.directory.signed.directory.members, revision + 1);
  const money = await encryptPrivateRecord(scope.workspaceId, { kind: "entryMoney", id: entryId, authorId: scope.userId, value: { _id: entryId, hourlyRate: 90 } }, f.directory.signed.directory.members, revision + 1);
  const edit = await signPrivateChainedWorkspaceEdit({ edit: { v: 1, workspaceId: scope.workspaceId, userId: scope.userId, operationId: crypto.randomUUID(), expectedRevision: revision, records: [stopped, money], remove: [] }, directory: f.directory, previousRoot: root, secrets: f.secrets, current: f.current });
  const signed = await signPrivateTimer({ ...start.signed.header, operationId: crypto.randomUUID(), revision: 2, previousRoot: await privateTimerRoot(start.signed), previous: start.signed.header.current, current: null, standardStart: { workspaceId: "standard", entryId: "a".repeat(24) }, edits: await privateTimerEditBindings([edit]) }, f.secrets.signingPrivateKey, f.current);
  const handoff = { signed, edits: [edit], standardStartInput: { description: "Standard target waiting for delivery", start: "2026-10-29T02:00:00.000Z" } };
  archive.replica = { ...archive.replica, revision, head: root, pending: [], records: [...archive.replica.records, ...start.edits[0]!.edit.records] };
  archive.accountTimer.committed = []; archive.accountTimer.pending = [handoff];
  const original = canonicalJson(archive), file = await encryptPrivateWorkspaceBackup(archive, f.key, f.secrets, f.current), opened = await decryptPrivateWorkspaceBackup(file, f.recoveryKey);
  assert.doesNotMatch(JSON.stringify(file), /Standard target waiting for delivery|Unsent private timer|hourlyRate/);
  assert.deepEqual(opened.accountTimer!.pending, [handoff]); assert.equal(opened.records.some(row => row.kind === "entries" && row.value.end == null), false);
  assert.deepEqual(await verifyPrivateWorkspaceBackup(file, f.key, f.secrets, f.current, scope), archive); assert.equal(canonicalJson(archive), original);
});
