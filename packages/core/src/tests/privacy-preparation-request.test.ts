import assert from "node:assert/strict";
import { it } from "node:test";
import { PRIVATE_PREPARATION_REQUEST_TTL_MS } from "@starter/shared";
import { createKeyPair, createSigningPair, canonicalJson, decodeSecret } from "../privacy/crypto.js";
import { createPrivateOriginalStageRequest } from "../privacy/original-stage-request.js";
import { createPrivatePreparationRequest } from "../privacy/preparation-request.js";
import { privateMemberKeyFingerprint, signPrivateWorkspaceDirectory, verifyPrivateWorkspaceDirectory } from "../privacy/directory.js";
import { emptyRecoveryCollections, recoveryDigest } from "../privacy/recovery.js";
import { emptyRecoverySupplementCollections, recoverySupplementDigest } from "../privacy/recovery-supplement.js";
import { privateSourceSessionBinding } from "../privacy/source-challenge.js";
const scope = { server: "https://api.example.test", workspaceId: "workspace", userId: "owner", sessionId: "current-session" };
async function fixture() {
  const keys = await createKeyPair(), signing = await createSigningPair(), secrets = { privateKey: keys.privateKey, signingPrivateKey: signing.privateKey };
  const person = { userId: "owner", role: "owner" as const, canViewOthersTime: true, canViewOthersMoney: true, publicKey: keys.publicKey, signingPublicKey: signing.publicKey };
  const signed = await signPrivateWorkspaceDirectory({ v: 1, server: scope.server, workspaceId: scope.workspaceId, ownerId: scope.userId, revision: 1, previousDigest: null, members: [person] }, signing.privateKey, null, new Map([["owner", await privateMemberKeyFingerprint(scope.server, person)]]));
  const directory = await verifyPrivateWorkspaceDirectory(signed, scope, { ownerId: "owner", signingPublicKey: signing.publicKey, revision: 0, digest: null });
  const collections = emptyRecoveryCollections(), supplement = emptyRecoverySupplementCollections(), createdAt = new Date().toISOString();
  supplement.organization.push({ _id: scope.workspaceId, kind: "personal", name: "Private original name" });
  const archive = { format: "trackyourtime-workspace-recovery-v2" as const, server: scope.server, ownerId: scope.userId, snapshot: { v: 1 as const, workspaceId: scope.workspaceId, createdAt, collections, sourceRevision: await recoveryDigest(collections) }, supplement: { v: 1 as const, workspaceId: scope.workspaceId, createdAt, collections: supplement, sourceRevision: await recoverySupplementDigest(supplement) } };
  return { options: { archive, directory, userId: scope.userId, sessionId: scope.sessionId, migrationId: crypto.randomUUID(), secrets, current: () => true }, signing };
}
it("signs a distinct explicit preparation intent bound to own originals, directory, login session and expiry", async () => {
  const f = await fixture(), { request, signature } = await createPrivatePreparationRequest(f.options);
  assert.equal(request.protocol, "trackyourtime-private-preparation-v2"); assert.equal(request.sourceRevision, f.options.archive.snapshot.sourceRevision);
  assert.equal(request.supplementRevision, f.options.archive.supplement.sourceRevision); assert.equal(request.sessionBinding, await privateSourceSessionBinding(scope));
  assert.equal(request.directoryDigest, f.options.directory.digest); assert.equal(request.migrationId, f.options.migrationId);
  assert.equal(request.expiresAt - request.issuedAt, PRIVATE_PREPARATION_REQUEST_TTL_MS);
  assert.doesNotMatch(JSON.stringify(request), /Private original name|current-session|"d":/);
  const key = await crypto.subtle.importKey("jwk", f.signing.publicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  assert.ok(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, decodeSecret(signature, 64), new TextEncoder().encode(canonicalJson(request))));
});
it("captures mutable source/intent before awaiting and rejects changed unlock generation", async () => {
  const f = await fixture(), original = structuredClone(f.options.archive), migrationId = f.options.migrationId;
  const pending = createPrivatePreparationRequest(f.options); f.options.archive.supplement.collections.organization[0]!.name = "Changed caller name"; f.options.migrationId = crypto.randomUUID();
  const signed = await pending; assert.equal(signed.request.supplementRevision, original.supplement.sourceRevision); assert.equal(signed.request.migrationId, migrationId);
  let current = true;
  const locked = createPrivatePreparationRequest({ ...f.options, archive: original, current: () => current }); current = false;
  await assert.rejects(locked, /changed during preparation/);
});
it("rejects substituted roots, unverified directory provenance and another account's originals", async () => {
  const f = await fixture(), stranger = await createKeyPair();
  await assert.rejects(createPrivatePreparationRequest({ ...f.options, secrets: { ...f.options.secrets, privateKey: stranger.privateKey } }), /do not match/);
  await assert.rejects(createPrivatePreparationRequest({ ...f.options, directory: JSON.parse(JSON.stringify(f.options.directory)) }), /Verify.*directory/);
  const archive = { ...f.options.archive, ownerId: "another" };
  await assert.rejects(createPrivatePreparationRequest({ ...f.options, archive }), /another server or account|another account|scope/);
});

it("authorizes only exact existing-source conversion without accepting replacement data or leaking originals", async () => {
  const f = await fixture(), signed = await createPrivateOriginalStageRequest(f.options);
  assert.equal(signed.request.protocol, "trackyourtime-private-original-stage-v1");
  assert.equal(signed.request.directoryDigest, f.options.directory.digest); assert.equal(signed.request.sessionBinding, await privateSourceSessionBinding(scope));
  assert.equal(signed.request.migrationId, f.options.migrationId);
  assert.doesNotMatch(JSON.stringify(signed), /sourceRevision|supplementRevision|Private original|current-session|records|"d":/);
  const key = await crypto.subtle.importKey("jwk", f.signing.publicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  assert.ok(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, decodeSecret(signed.signature, 64), new TextEncoder().encode(canonicalJson(signed.request))));
  let current = true; const pending = createPrivateOriginalStageRequest({ ...f.options, current: () => current }); current = false;
  await assert.rejects(pending, /changed during original staging/);
});
