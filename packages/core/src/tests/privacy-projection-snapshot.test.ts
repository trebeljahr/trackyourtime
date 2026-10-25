import assert from "node:assert/strict";
import { it } from "node:test";
import { createKeyPair, createSigningPair } from "../privacy/crypto.js";
import { privateMemberKeyFingerprint, signPrivateWorkspaceDirectory, verifyPrivateWorkspaceDirectory } from "../privacy/directory.js";
import { encryptPrivateRecord } from "../privacy/records.js";
import { privateInitialSnapshotProjection } from "../privacy/initial-snapshot.js";
import { privateRecordDigest } from "../privacy/workspace-edits.js";
import { assertPrivateProjectionSnapshot, signPrivateInitialProjectionRoot, verifyPrivateInitialProjection } from "../privacy/projection-snapshot.js";
import type { EncryptedRecord, PrivateDirectoryMember } from "@starter/shared";
const base = { server: "https://api.example.test", workspaceId: "workspace" };
async function fixture() {
  const people: PrivateDirectoryMember[] = [], secrets = new Map<string, { privateKey: Awaited<ReturnType<typeof createKeyPair>>["privateKey"]; signingPrivateKey: Awaited<ReturnType<typeof createSigningPair>>["privateKey"] }>();
  for (const userId of ["manager", "member", "owner"]) {
    const pair = await createKeyPair(), signing = await createSigningPair();
    people.push({ userId, role: userId === "owner" ? "owner" : "member", canViewOthersTime: userId !== "member", canViewOthersMoney: userId !== "member", publicKey: pair.publicKey, signingPublicKey: signing.publicKey });
    secrets.set(userId, { privateKey: pair.privateKey, signingPrivateKey: signing.privateKey });
  }
  const fingerprints = new Map(await Promise.all(people.map(async (person) => [person.userId, await privateMemberKeyFingerprint(base.server, person)] as const)));
  const signedDirectory = await signPrivateWorkspaceDirectory({ v: 1, ...base, revision: 1, previousDigest: null, ownerId: "owner", members: people }, secrets.get("owner")!.signingPrivateKey, null, fingerprints);
  const directory = await verifyPrivateWorkspaceDirectory(signedDirectory, base, { ownerId: "owner", signingPublicKey: people[2]!.signingPublicKey, revision: 0, digest: null });
  const shared = [
    await encryptPrivateRecord(base.workspaceId, { kind: "tags", id: "shared-tag", authorId: null, value: { workspaceId: base.workspaceId, name: "Shared original" } }, people, 1),
    await encryptPrivateRecord(base.workspaceId, { kind: "entries", id: "owner-entry", authorId: "owner", value: { workspaceId: base.workspaceId, authorId: "owner", description: "Restricted colleague time" } }, people, 1),
  ];
  const personal = new Map<string, EncryptedRecord[]>();
  for (const userId of ["member", "owner"]) personal.set(userId, [
    await encryptPrivateRecord(base.workspaceId, { kind: "favorites", id: `${userId}-private-favorite`, authorId: userId, value: { _id: `${userId}-private-favorite`, workspaceId: base.workspaceId, userId, description: `${userId} secret favorite` } }, people, 1),
    await encryptPrivateRecord(base.workspaceId, { kind: "integrations", id: `webhooksubscriptions:${userId}-private-hook`, authorId: userId, value: { _id: `${userId}-private-hook`, workspaceId: base.workspaceId, createdBy: userId, secret: `${userId} secret integration` } }, people, 1),
  ]);
  personal.set("manager", []);
  const personalDigests = new Map(await Promise.all([...personal].map(async ([userId, records]) => [userId, await privateRecordDigest(records)] as const)));
  const alive = { value: true }, current = () => alive.value;
  const options = { sharedRecords: shared, ownerPersonalRecords: personal.get("owner")!, personalDigests, migrationId: crypto.randomUUID(), directory, userId: "owner", secrets: secrets.get("owner")!, current };
  const signed = await signPrivateInitialProjectionRoot(options);
  const reader = (userId: string) => ({ signed, sharedRecords: privateInitialSnapshotProjection(shared, userId), personalRecords: personal.get(userId)!, scope: { ...base, userId }, directory, secrets: secrets.get(userId)!, current });
  return { options, signed, reader, shared, personal, alive, people };
}
it("verifies all reader projections using one owner-signed root without exposing another creator's personal IDs or counts", async () => {
  const f = await fixture(), roots = [];
  assert.doesNotMatch(JSON.stringify(f.signed), /member-private-favorite|member-private-hook|secret favorite|secret integration|recordCount|opaqueRecords/);
  for (const userId of ["manager", "member", "owner"]) {
    const options = f.reader(userId), snapshot = await verifyPrivateInitialProjection(options);
    assertPrivateProjectionSnapshot(snapshot, options.scope, options.directory.digest); roots.push(snapshot.root);
    assert.ok(Object.isFrozen(snapshot)); assert.ok(Object.isFrozen(snapshot.sharedRecords));
    assert.equal(snapshot.personalRecords.length, userId === "manager" ? 0 : 2);
    assert.equal(snapshot.sharedRecords.length, userId === "member" ? 1 : 2);
    if (userId === "member") assert.doesNotMatch(JSON.stringify(snapshot.sharedRecords), /owner-entry/);
  }
  assert.equal(new Set(roots).size, 1);
});
it("rejects substituted or truncated shared and personal projections even when other creators' commitments remain opaque", async () => {
  const f = await fixture(), reader = f.reader("member");
  const replacement = await encryptPrivateRecord(base.workspaceId, { kind: "tags", id: "shared-tag", authorId: null, value: { workspaceId: base.workspaceId, name: "Forged shared view" } }, f.people, 1);
  await assert.rejects(verifyPrivateInitialProjection({ ...reader, sharedRecords: privateInitialSnapshotProjection([replacement], "member") }), /incomplete or differs/);
  await assert.rejects(verifyPrivateInitialProjection({ ...reader, sharedRecords: [] }), /incomplete or differs/);
  await assert.rejects(verifyPrivateInitialProjection({ ...reader, personalRecords: [] }), /incomplete or differs/);
  await assert.rejects(verifyPrivateInitialProjection({ ...reader, personalRecords: [...reader.personalRecords, replacement] }), /namespace or key binding/);
  const root = structuredClone(f.signed); root.manifest.readers[1]!.sharedDigest = await privateRecordDigest(privateInitialSnapshotProjection([replacement], "member"));
  await assert.rejects(verifyPrivateInitialProjection({ ...reader, signed: root }), /signature/);
});
it("refuses missing recipients, unbound keys, another creator's personal records and incomplete reader commitments before signing", async () => {
  const f = await fixture(), options = f.options;
  const shared = structuredClone(f.shared); shared[0]!.grants = shared[0]!.grants.filter((grant) => grant.userId === "owner");
  await assert.rejects(signPrivateInitialProjectionRoot({ ...options, sharedRecords: shared }), /Shared recipients/);
  const { keyCommitment: _key, ...legacy } = f.shared[0]!;
  await assert.rejects(signPrivateInitialProjectionRoot({ ...options, sharedRecords: [legacy] }), /key binding/);
  await assert.rejects(signPrivateInitialProjectionRoot({ ...options, ownerPersonalRecords: f.personal.get("member")! }), /Another creator/);
  const missing = new Map(options.personalDigests); missing.delete("manager");
  await assert.rejects(signPrivateInitialProjectionRoot({ ...options, personalDigests: missing }), /Every verified reader/);
  const wrong = new Map(options.personalDigests); wrong.set("owner", "A".repeat(43));
  await assert.rejects(signPrivateInitialProjectionRoot({ ...options, personalDigests: wrong }), /Owner personal commitment/);
});
it("rejects another scope, forged provenance and unlock changes, and captures mutable signing inputs before awaiting crypto", async () => {
  const f = await fixture(), options = f.reader("owner");
  await assert.rejects(verifyPrivateInitialProjection({ ...options, scope: { ...options.scope, server: "https://other.example.test" } }), /verified workspace directory/);
  const snapshot = await verifyPrivateInitialProjection(options);
  assert.throws(() => assertPrivateProjectionSnapshot(JSON.parse(JSON.stringify(snapshot)), options.scope, options.directory.digest), /current verified/);
  const originalId = f.options.migrationId;
  const signing = signPrivateInitialProjectionRoot(f.options); f.options.migrationId = crypto.randomUUID();
  assert.equal((await signing).manifest.migrationId, originalId);
  const verification = verifyPrivateInitialProjection(options); f.alive.value = false;
  await assert.rejects(verification, /changed during/);
  assert.throws(() => assertPrivateProjectionSnapshot(snapshot, options.scope, options.directory.digest), /current verified/);
});
