import assert from "node:assert/strict";
import { it } from "node:test";
import { createKeyPair, createSigningPair } from "../privacy/crypto.js";
import { privateMemberKeyFingerprint, signPrivateWorkspaceDirectory, verifyPrivateWorkspaceDirectory } from "../privacy/directory.js";
import { privateWorkspaceSummary } from "../privacy/workspace-view.js";
import type { PlainPrivateRecord } from "../privacy/records.js";
async function fixture() {
  const pair = await createKeyPair(), signing = await createSigningPair(), scope = { server: "https://api.example.test", workspaceId: "workspace", userId: "viewer" };
  const members = ["owner", "viewer"].map((userId) => ({ userId, role: userId === "owner" ? "owner" as const : "member" as const, canViewOthersTime: true, canViewOthersMoney: false, publicKey: pair.publicKey, signingPublicKey: signing.publicKey }));
  const signed = await signPrivateWorkspaceDirectory({ v: 1, server: scope.server, workspaceId: scope.workspaceId, ownerId: "owner", revision: 1, previousDigest: null, members }, signing.privateKey, null, new Map(await Promise.all(members.map(async (m) => [m.userId, await privateMemberKeyFingerprint(scope.server, m)] as const))));
  const directory = await verifyPrivateWorkspaceDirectory(signed, scope, { ownerId: "owner", signingPublicKey: signing.publicKey, revision: 0, digest: null });
  const row: PlainPrivateRecord = { kind: "workspaceIdentity", id: "organization", authorId: null, value: { workspaceId: "workspace", organization: { _id: "workspace", name: "Original studio", kind: "personal" } } };
  let open = true;
  return { row, scope, read: (records = [row], override = scope) => privateWorkspaceSummary({ scope: override, directory, records, current: () => open, isDefault: true }), lock: () => { open = false; } };
}
it("derives the original name/kind and signed membership authority without mutating originals", async () => {
  const f = await fixture(), original = structuredClone(f.row), result = f.read();
  assert.equal(result.name, "Original studio"); assert.equal(result.kind, "personal"); assert.equal(result.role, "member"); assert.equal(result.memberCount, 2); assert.equal(result.isDefault, true);
  assert.equal(result.permissions.viewOthersTime, true); assert.equal(result.permissions.viewOthersMoney, false); assert.equal(result.permissions.inviteMembers, false);
  assert.deepEqual(f.row, original);
  delete (f.row.value.organization as Record<string, unknown>).kind; assert.equal(f.read().kind, "team");
});
it("refuses missing, duplicate, foreign or wrongly addressed identities and stale views", async () => {
  const f = await fixture(); assert.throws(() => f.read([]), /original organization/); assert.throws(() => f.read([f.row, f.row]), /Duplicate/);
  assert.throws(() => f.read([{ ...f.row, authorId: "viewer" }]), /Invalid encrypted/);
  assert.throws(() => f.read([{ ...f.row, id: "other" }]), /Invalid encrypted/);
  assert.throws(() => f.read([{ ...f.row, value: { ...f.row.value, organization: { _id: "other", name: "Injected" } } }]), /another workspace/);
  assert.throws(() => f.read([{ ...f.row, value: { ...f.row.value, organization: { _id: "workspace", kind: "unknown" } } }]), /Unknown workspace kind/);
  assert.throws(() => f.read(undefined, { ...f.scope, server: "https://foreign.test" }), /another workspace/);
  f.lock(); assert.throws(() => f.read(), /changed/);
});
