import assert from "node:assert/strict";
import { it } from "node:test";
import { canonicalJson, createKeyPair, createSigningPair } from "../privacy/crypto.js";
import { privateMemberKeyFingerprint, signPrivateWorkspaceDirectory, verifyPrivateWorkspaceDirectory } from "../privacy/directory.js";
import { signPrivateInitialProjectionRoot, verifyPrivateInitialProjection } from "../privacy/projection-snapshot.js";
import { privateRecordDigest } from "../privacy/workspace-edits.js";
import { createPrivatePreparationReservation } from "../privacy/preparation-reservation.js";
import { privateSourceSessionBinding } from "../privacy/source-challenge.js";
async function fixture() {
  const keys = await createKeyPair(), signing = await createSigningPair(), state = { open: true }, current = () => state.open;
  const scope = { server: "https://api.example.test", workspaceId: "workspace", userId: "owner" }, secrets = { privateKey: keys.privateKey, signingPrivateKey: signing.privateKey };
  const person = { userId: "owner", role: "owner" as const, canViewOthersTime: true, canViewOthersMoney: true, publicKey: keys.publicKey, signingPublicKey: signing.publicKey };
  const signed = await signPrivateWorkspaceDirectory({ v: 1, server: scope.server, workspaceId: scope.workspaceId, ownerId: "owner", revision: 1, previousDigest: null, members: [person] }, signing.privateKey, null, new Map([["owner", await privateMemberKeyFingerprint(scope.server, person)]]));
  const directory = await verifyPrivateWorkspaceDirectory(signed, scope, { ownerId: "owner", signingPublicKey: signing.publicKey, revision: 0, digest: null });
  const root = await signPrivateInitialProjectionRoot({ directory, secrets, userId: "owner", migrationId: crypto.randomUUID(), sharedRecords: [], ownerPersonalRecords: [], personalDigests: new Map([["owner", await privateRecordDigest([])]]), current });
  const context = { ...scope, ignoredContext: "never send" };
  const snapshot = await verifyPrivateInitialProjection({ signed: root, directory, secrets, scope: context, sharedRecords: [], personalRecords: [], current });
  const options = { snapshot, directory, secrets, sessionId: "current-session", reservationId: crypto.randomUUID(), modeId: "100000000000000000000001", current };
  return { scope, options, state, signing };
}
it("signs explicit reservation intent from a complete current snapshot without leaking extra context or keys", async () => {
  const f = await fixture(), signed = await createPrivatePreparationReservation(f.options);
  assert.equal(signed.request.snapshotRoot, f.options.snapshot.root); assert.equal(signed.request.directoryDigest, f.options.directory.digest);
  assert.equal(signed.request.reservationId, f.options.reservationId); assert.equal(signed.request.modeId, f.options.modeId);
  assert.equal(signed.request.sessionBinding, await privateSourceSessionBinding({ ...f.scope, sessionId: f.options.sessionId }));
  assert.equal(signed.request.expiresAt - signed.request.issuedAt, 120_000);
  assert.doesNotMatch(JSON.stringify(signed), /ignoredContext|never send|privateKey|current-session|"d":/);
  const key = await crypto.subtle.importKey("jwk", f.signing.publicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const signature = Uint8Array.from(atob(signed.signature.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));
  assert.equal(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signature, new TextEncoder().encode(canonicalJson(signed.request))), true);
});
it("refuses an unverified projection, substituted account keys and malformed reservation identities", async () => {
  const f = await fixture();
  await assert.rejects(createPrivatePreparationReservation({ ...f.options, snapshot: JSON.parse(JSON.stringify(f.options.snapshot)) }), /current verified/);
  await assert.rejects(createPrivatePreparationReservation({ ...f.options, secrets: { ...f.options.secrets, signingPrivateKey: (await createSigningPair()).privateKey } }), /do not match/);
  await assert.rejects(createPrivatePreparationReservation({ ...f.options, modeId: "unknown-mode" }));
  await assert.rejects(createPrivatePreparationReservation({ ...f.options, reservationId: "not-a-uuid" }));
});
it("captures immutable intent before awaiting and refuses late signing after locking", async () => {
  const f = await fixture(), original = f.options.reservationId, pending = createPrivatePreparationReservation(f.options);
  f.options.reservationId = crypto.randomUUID();
  assert.equal((await pending).request.reservationId, original);
  const late = createPrivatePreparationReservation(f.options); f.state.open = false;
  await assert.rejects(late, /changed during reservation consent/);
  await assert.rejects(createPrivatePreparationReservation(f.options), /changed during reservation consent/);
});
