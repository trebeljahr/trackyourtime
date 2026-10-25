import assert from "node:assert/strict";
import { before, beforeEach, after, describe, it } from "node:test";
import mongoose from "mongoose";
import { createKeyPair, createSigningPair, signPrivateChange, signPrivateSourceChallenge, type PrivateSourceScope } from "@starter/core";
import { PrivateAccount, PrivateSourceChallengeRequest, PrivateWorkspace } from "../models/PrivateData.js";
import { WorkspaceMember } from "../models/WorkspaceMember.js";
import { createPrivateSourceChallenge, readPrivateMigrationOriginals } from "../services/privacy/source-challenges.js";
import { discardPrivatePreparation } from "../services/privacy/preparation.js";
import { mongooseRowStore } from "../services/account-deletion/stores.js";
import { clearTestDatabase, connectTestDatabase, dropTestDatabase, skipWithoutDatabase } from "./support/test-database.js";
const scope: PrivateSourceScope = { server: "https://api.example.test", workspaceId: "workspace", userId: "owner", sessionId: "current-session", purpose: "workspace-originals", migrationId: null };
let owner: { privateKey: Awaited<ReturnType<typeof createKeyPair>>["privateKey"]; signingPrivateKey: Awaited<ReturnType<typeof createSigningPair>>["privateKey"] }, member: typeof owner;
async function signed(s = scope, secrets = owner) { return signPrivateSourceChallenge(await createPrivateSourceChallenge(s), s, secrets, () => true); }
async function preparation() {
  const migrationId = crypto.randomUUID();
  await PrivateWorkspace.create({ workspaceId: scope.workspaceId, ownerId: "owner", state: "migrating", migrationId, sourceRevision: "a".repeat(64), supplementRevision: "b".repeat(64), leaseUntil: new Date(Date.now() + 60_000) });
  return migrationId;
}
describe("trusted-root original-source challenges", { skip: skipWithoutDatabase }, () => {
  before(() => connectTestDatabase("privacy-source-challenges", [PrivateAccount, PrivateSourceChallengeRequest, PrivateWorkspace, WorkspaceMember] as never));
  beforeEach(async () => {
    await clearTestDatabase();
    for (const userId of ["owner", "member"]) {
      const pair = await createKeyPair(), signing = await createSigningPair();
      const secrets = { privateKey: pair.privateKey, signingPrivateKey: signing.privateKey }; if (userId === "owner") owner = secrets; else member = secrets;
      await WorkspaceMember.create({ workspaceId: scope.workspaceId, userId, role: userId === "owner" ? "owner" : "member", name: userId });
      await PrivateAccount.create({ userId, identity: { publicKey: pair.publicKey, signingPublicKey: signing.publicKey, recovery: {}, passkeys: [] } });
    }
    const db = mongoose.connection.db!;
    await db.collection<{ _id: string; name: string }>("organization").insertOne({ _id: scope.workspaceId, name: "Original organization" });
    await db.collection("favorites").insertMany([ { workspaceId: scope.workspaceId, userId: "owner", description: "Owner original pin" }, { workspaceId: scope.workspaceId, userId: "member", description: "Member original pin" } ]);
    await db.collection("webhooksubscriptions").insertMany([ { workspaceId: scope.workspaceId, createdBy: "owner", secret: "Owner original secret" }, { workspaceId: scope.workspaceId, createdBy: "member", secret: "Member original secret" } ]);
  });
  after(dropTestDatabase);
  it("requires an unlocked root and releases only owner-readable originals once under concurrent replay", async () => {
    const proof = await signed();
    assert.doesNotMatch(JSON.stringify(await PrivateSourceChallengeRequest.find().lean()), /current-session|Original organization|original secret|original pin|sourceRevision/);
    const results = await Promise.allSettled([readPrivateMigrationOriginals(scope, proof), readPrivateMigrationOriginals(scope, proof)]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const archive = (results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof readPrivateMigrationOriginals>>>).value;
    assert.equal(archive.supplement.collections.webhooksubscriptions.length, 1);
    assert.doesNotMatch(JSON.stringify(archive), /Member original/);
    assert.equal(await PrivateSourceChallengeRequest.countDocuments(), 0);
    assert.equal(await mongoose.connection.db!.collection("webhooksubscriptions").countDocuments(), 2);
  });
  it("refuses forged, cross-session, cross-account, wrong-purpose and changed challenges without consuming a valid request", async () => {
    const proof = await signed(), forged = { ...proof, signature: await signPrivateChange(member.signingPrivateKey, proof.challenge) };
    await assert.rejects(readPrivateMigrationOriginals(scope, forged), { code: "FORBIDDEN" });
    await assert.rejects(readPrivateMigrationOriginals({ ...scope, sessionId: "another-login" }, proof), { code: "NOT_FOUND" });
    await assert.rejects(readPrivateMigrationOriginals({ ...scope, userId: "member" }, proof), { code: "NOT_FOUND" });
    await assert.rejects(readPrivateMigrationOriginals({ ...scope, purpose: "personal-originals" }, proof), { code: "NOT_FOUND" });
    const changed = structuredClone(proof); changed.challenge.issuedAt--; changed.signature = await signPrivateChange(owner.signingPrivateKey, changed.challenge);
    await assert.rejects(readPrivateMigrationOriginals(scope, changed), { code: "NOT_FOUND" });
    assert.equal(await PrivateSourceChallengeRequest.countDocuments(), 1);
    await readPrivateMigrationOriginals(scope, proof);
  });
  it("invalidates expired requests and refuses changed root keys or revoked ownership", async () => {
    const proof = await signed();
    await PrivateSourceChallengeRequest.updateOne({}, { $set: { expiresAt: new Date(0) } });
    await assert.rejects(readPrivateMigrationOriginals(scope, proof), { code: "NOT_FOUND" });
    const expired = await signed();
    expired.challenge.issuedAt = Date.now() - 120_000; expired.challenge.expiresAt = Date.now() - 1;
    expired.signature = await signPrivateChange(owner.signingPrivateKey, expired.challenge);
    await PrivateSourceChallengeRequest.updateOne({ _id: expired.challenge.requestId }, { $set: { challenge: expired.challenge, expiresAt: new Date(Date.now() + 60_000) } });
    await assert.rejects(readPrivateMigrationOriginals(scope, expired), { code: "NOT_FOUND" });
    const live = await signed(), replacement = await createSigningPair();
    const original = (await PrivateAccount.findOne({ userId: "owner" }).lean())!.identity.signingPublicKey;
    await PrivateAccount.updateOne({ userId: "owner" }, { $set: { "identity.signingPublicKey": replacement.publicKey } });
    await assert.rejects(readPrivateMigrationOriginals(scope, live), { code: "FORBIDDEN" });
    await PrivateAccount.updateOne({ userId: "owner" }, { $set: { "identity.signingPublicKey": original } });
    await WorkspaceMember.collection.updateOne({ userId: "owner" }, { $set: { role: "member" } });
    await assert.rejects(readPrivateMigrationOriginals(scope, live), { code: "FORBIDDEN" });
  });
  it("bounds concurrent requests to three per account and expires them explicitly before reuse", async () => {
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => createPrivateSourceChallenge(scope)));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);
    assert.equal((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason.code, "TOO_MANY_REQUESTS");
    await PrivateSourceChallengeRequest.updateMany({}, { $set: { expiresAt: new Date(0) } });
    await createPrivateSourceChallenge(scope); assert.equal(await PrivateSourceChallengeRequest.countDocuments(), 1);
  });
  it("keeps member originals creator-only and erases challenges on preparation cancellation/account cleanup", async () => {
    const migrationId = await preparation(), personalScope = { ...scope, userId: "member", purpose: "personal-originals" as const, migrationId };
    const archive = await readPrivateMigrationOriginals(personalScope, await signed(personalScope, member));
    assert.equal(archive.supplement.collections.organization.length, 0); assert.doesNotMatch(JSON.stringify(archive), /Owner original|Original organization/);
    await signed(personalScope, member); await signed({ ...scope, migrationId });
    assert.equal(await discardPrivatePreparation(scope.workspaceId, migrationId), true);
    assert.equal(await PrivateSourceChallengeRequest.countDocuments(), 0);
    await signed(); await mongooseRowStore.deleteMany("privateSourceChallenges", { userId: "owner" });
    assert.equal(await PrivateSourceChallengeRequest.countDocuments(), 0);
    await PrivateWorkspace.create({ workspaceId: scope.workspaceId, ownerId: "owner", state: "encrypted", revision: 1, migrationId, sourceRevision: "retired", leaseUntil: new Date(0) });
    await assert.rejects(createPrivateSourceChallenge(scope), { code: "PRECONDITION_FAILED" });
  });
  it("the signer refuses operation/session/key substitution, excessive lifetime and invalidation during signing", async () => {
    const challenge = await createPrivateSourceChallenge(scope);
    await assert.rejects(signPrivateSourceChallenge(challenge, { ...scope, sessionId: "another" }, owner, () => true), /unlocked account and session/);
    await assert.rejects(signPrivateSourceChallenge(challenge, scope, member, () => true), /unlocked account and session/);
    await assert.rejects(signPrivateSourceChallenge({ ...challenge, expiresAt: challenge.issuedAt + 120_001 }, scope, owner, () => true), /another operation or has expired/);
    await assert.rejects(signPrivateSourceChallenge(challenge, { ...scope, workspaceId: "other" }, owner, () => true), /another operation or has expired/);
    let current = true; const pending = signPrivateSourceChallenge(challenge, scope, owner, () => current); current = false;
    await assert.rejects(pending, /changed during/);
  });
});
