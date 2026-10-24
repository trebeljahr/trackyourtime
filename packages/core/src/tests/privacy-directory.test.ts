import assert from "node:assert/strict";
import { it } from "node:test";
import { createKeyPair, createSigningPair, randomSecret, signPrivateChange } from "../privacy/crypto.js";
import { createPrivateDirectoryStore, privateMemberKeyFingerprint, privateReplicaIdentityFromDirectory, signPrivateWorkspaceDirectory, verifyPrivateWorkspaceDirectory } from "../privacy/directory.js";
import { memoryStorage } from "../storage.js";
import { PrivateStorageLockedError } from "../privacy/storage.js";
import type { PrivateDirectoryMember, PrivateWorkspaceDirectory } from "@starter/shared";
const scope = { server: "https://api.example.test", workspaceId: "workspace", userId: "owner" };
async function fixture() {
  const owner = await createSigningPair(), member = await createSigningPair();
  const encryption = await createKeyPair();
  const people: PrivateDirectoryMember[] = [
    { userId: "member", role: "member", canViewOthersTime: false, canViewOthersMoney: false, publicKey: (await createKeyPair()).publicKey, signingPublicKey: member.publicKey },
    { userId: "owner", role: "owner", canViewOthersTime: true, canViewOthersMoney: true, publicKey: encryption.publicKey, signingPublicKey: owner.publicKey },
  ];
  const directory: PrivateWorkspaceDirectory = { v: 1, server: scope.server, workspaceId: scope.workspaceId, revision: 1, previousDigest: null, ownerId: "owner", members: people };
  const confirmed = new Map(await Promise.all(people.map(async (person) => [person.userId, await privateMemberKeyFingerprint(scope.server, person)] as const)));
  const trust = { ownerId: "owner", signingPublicKey: owner.publicKey, revision: 0, digest: null };
  const signed = await signPrivateWorkspaceDirectory(directory, owner.privateKey, null, confirmed);
  return { owner, member, encryption, directory, confirmed, trust, signed, verified: await verifyPrivateWorkspaceDirectory(signed, scope, trust) };
}
it("pins the owner's key and refuses server substitutions, scope changes, revision gaps and rollbacks", async () => {
  const f = await fixture();
  assert.equal(f.verified.trust.revision, 1); assert.ok(Object.isFrozen(f.verified.signed.directory.members[0]!.publicKey));
  const changed = structuredClone(f.signed); changed.directory.members[0]!.publicKey = (await createKeyPair()).publicKey;
  await assert.rejects(verifyPrivateWorkspaceDirectory(changed, scope, f.trust), /signature/);
  await assert.rejects(verifyPrivateWorkspaceDirectory(f.signed, scope, { ...f.trust, signingPublicKey: f.member.publicKey }), /signature/);
  await assert.rejects(verifyPrivateWorkspaceDirectory(f.signed, { ...scope, server: "https://other.example.test" }, f.trust), /another server/);
  await assert.rejects(verifyPrivateWorkspaceDirectory(f.signed, scope, f.verified.trust), /rolled back/);
  await assert.rejects(signPrivateWorkspaceDirectory({ ...f.directory, revision: 3, previousDigest: f.verified.digest }, f.owner.privateKey, f.verified, new Map()), /skipped a revision/);
});
it("requires independent fingerprints for initial, new and changed member keys, while preserving verified unchanged keys", async () => {
  const f = await fixture();
  await assert.rejects(signPrivateWorkspaceDirectory(f.directory, f.owner.privateKey, null, new Map()), /Verify new/);
  const next = { ...structuredClone(f.directory), revision: 2, previousDigest: f.verified.digest };
  next.members[0]!.canViewOthersTime = true;
  const updated = await signPrivateWorkspaceDirectory(next, f.owner.privateKey, f.verified, new Map());
  assert.equal((await verifyPrivateWorkspaceDirectory(updated, scope, f.verified.trust)).trust.revision, 2);
  next.members[0]!.publicKey = (await createKeyPair()).publicKey;
  await assert.rejects(signPrivateWorkspaceDirectory(next, f.owner.privateKey, f.verified, f.confirmed), /Verify new/);
  const confirmed = new Map([["member", await privateMemberKeyFingerprint(scope.server, next.members[0]!)]]);
  await signPrivateWorkspaceDirectory(next, f.owner.privateKey, f.verified, confirmed);
});
it("accepts an ownership transfer only when signed by the previously trusted owner", async () => {
  const f = await fixture(), next = { ...structuredClone(f.directory), revision: 2, previousDigest: f.verified.digest, ownerId: "member" };
  next.members[0]!.role = "owner"; next.members[1]!.role = "member";
  await assert.rejects(signPrivateWorkspaceDirectory(next, f.member.privateKey, f.verified, new Map()), /signature/);
  const transferred = await signPrivateWorkspaceDirectory(next, f.owner.privateKey, f.verified, new Map());
  const current = await verifyPrivateWorkspaceDirectory(transferred, scope, f.verified.trust);
  assert.equal(current.trust.ownerId, "member");
  const third = { ...next, revision: 3, previousDigest: current.digest };
  await signPrivateWorkspaceDirectory(third, f.member.privateKey, current, new Map());
  await assert.rejects(signPrivateWorkspaceDirectory(third, f.owner.privateKey, current, new Map()), /signature/);
});
it("rejects duplicate members, private keys, multiple owners and invalid elliptic-curve points", async () => {
  const f = await fixture();
  await assert.rejects(signPrivateWorkspaceDirectory({ ...f.directory, members: [...f.directory.members, f.directory.members[0]!] }, f.owner.privateKey, null, f.confirmed), /unique/);
  const bad = structuredClone(f.directory); bad.members[0]!.role = "owner";
  await assert.rejects(signPrivateWorkspaceDirectory(bad, f.owner.privateKey, null, f.confirmed), /exactly one owner/);
  const malformed = structuredClone(f.signed); malformed.directory.members[0]!.publicKey.x = "A".repeat(43); malformed.directory.members[0]!.publicKey.y = "A".repeat(43);
  malformed.signature = await signPrivateChange(f.owner.privateKey, { protocol: "trackyourtime-workspace-directory-v1", directory: malformed.directory, signerId: malformed.signerId });
  await assert.rejects(verifyPrivateWorkspaceDirectory(malformed, scope, f.trust));
  await assert.rejects(verifyPrivateWorkspaceDirectory({ ...f.signed, directory: { ...f.directory, members: [{ ...f.directory.members[0], publicKey: (await createKeyPair()).privateKey }, f.directory.members[1]] } }, scope, f.trust), /Unrecognized key/);
});
it("persists authenticated checkpoints, refuses a changed trust anchor, and keeps newer checkpoints after a rollback attempt", async () => {
  const f = await fixture(), backing = memoryStorage(), key = randomSecret();
  let open = true;
  const options = { storage: backing, scope, initialOwner: { ownerId: "owner", signingPublicKey: f.owner.publicKey }, resolveStorageKey: () => open ? { key, current: () => open } : null, capture: () => () => { if (!open) throw new PrivateStorageLockedError(); }, exclusive: <T>(task: () => Promise<T>) => task() };
  const store = await createPrivateDirectoryStore(options); await store.accept(f.signed);
  assert.equal((await store.read())!.digest, f.verified.digest);
  await store.accept(f.signed);
  const second = await signPrivateWorkspaceDirectory({ ...f.directory, revision: 2, previousDigest: f.verified.digest }, f.owner.privateKey, f.verified, new Map());
  await store.accept(second);
  await assert.rejects(store.accept(f.signed), /rolled back/); assert.equal((await store.read())!.trust.revision, 2);
  const changed = await createPrivateDirectoryStore({ ...options, initialOwner: { ownerId: "owner", signingPublicKey: f.member.publicKey } });
  await assert.rejects(changed.read(), /trust anchor changed/);
  open = false; await assert.rejects(store.read(), PrivateStorageLockedError);
});

it("supplies replica recipients only from a verified directory matching the unlocked account keys", async () => {
  const f = await fixture();
  const secrets = { privateKey: f.encryption.privateKey, signingPrivateKey: f.owner.privateKey };
  const access = privateReplicaIdentityFromDirectory(f.verified, "owner", secrets, () => true);
  assert.equal(access.recipients.length, 2); assert.deepEqual(access.signingKey("member"), f.member.publicKey); assert.equal(access.signingKey("unknown"), null);
  assert.throws(() => privateReplicaIdentityFromDirectory(f.verified, "absent", secrets, () => true), /do not match/);
  assert.throws(() => privateReplicaIdentityFromDirectory(f.verified, "owner", { ...secrets, signingPrivateKey: f.member.privateKey }, () => true), /do not match/);
});
