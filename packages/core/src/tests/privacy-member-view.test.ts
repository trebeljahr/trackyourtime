import assert from "node:assert/strict";
import { it } from "node:test";
import { createKeyPair, createSigningPair } from "../privacy/crypto.js";
import { privateMemberKeyFingerprint, signPrivateWorkspaceDirectory, verifyPrivateWorkspaceDirectory } from "../privacy/directory.js";
import { privateMemberRateEdit } from "../privacy/member-rate-edit.js";
import { privateMemberQuery } from "../privacy/member-view.js";
import type { PlainPrivateRecord } from "../privacy/records.js";
async function fixture(money = false) {
  const pair = await createKeyPair(), signing = await createSigningPair(), scope = { server: "https://api.example.test", workspaceId: "workspace", userId: "viewer" };
  const members = ["owner", "viewer", "peer"].map((userId) => ({ userId, role: userId === "owner" ? "owner" as const : userId === "viewer" ? "admin" as const : "member" as const, canViewOthersTime: true, canViewOthersMoney: money, publicKey: pair.publicKey, signingPublicKey: signing.publicKey }));
  const signed = await signPrivateWorkspaceDirectory({ v: 1, server: scope.server, workspaceId: scope.workspaceId, ownerId: "owner", revision: 1, previousDigest: null, members }, signing.privateKey, null, new Map(await Promise.all(members.map(async (m) => [m.userId, await privateMemberKeyFingerprint(scope.server, m)] as const))));
  const directory = await verifyPrivateWorkspaceDirectory(signed, scope, { ownerId: "owner", signingPublicKey: signing.publicKey, revision: 0, digest: null });
  const records: PlainPrivateRecord[] = [];
  for (const member of members) {
    records.push({ kind: "members", id: `mirror-${member.userId}`, authorId: member.userId, value: { _id: `mirror-${member.userId}`, workspaceId: "workspace", userId: member.userId, name: `Original ${member.userId}`, role: "owner", canViewOthersMoney: true, createdAt: "2026-01-01T00:00:00.000Z" } });
    if (member.userId === "viewer" || money) records.push({ kind: "memberMoney", id: `mirror-${member.userId}`, authorId: member.userId, value: { _id: `mirror-${member.userId}`, hourlyRate: member.userId === "viewer" ? 0 : 100 } });
  }
  const metadata = { ...scope, members: members.map((m) => ({ userId: m.userId, memberId: `auth-${m.userId}`, name: `Renamed ${m.userId}`, email: `${m.userId}@example.test` })) }; const { server: _server, ...display } = metadata; void _server;
  let open = true;
  return { records, rate: (input: unknown, actor = scope.userId) => privateMemberRateEdit({ scope: { ...scope, userId: actor }, directory, records, current: () => open, input }), metadata: display, read: (metadata: unknown = display, input: unknown = {}) => privateMemberQuery({ scope, directory, records, current: () => open, input, metadata }), lock: () => { open = false; } };
}
it("joins live display facts with encrypted rates and signed roles, preserving zero and withheld fields", async () => {
  const f = await fixture(), rows = f.read(); assert.deepEqual(rows.map((m) => m.userId), ["owner", "viewer", "peer"]);
  assert.equal(rows[1]!.name, "Renamed viewer"); assert.equal(rows[1]!.memberId, "mirror-viewer"); assert.equal(rows[1]!.hourlyRate, 0); assert.equal(rows[1]!.role, "admin"); assert.equal(rows[1]!.canViewOthersMoney, false); assert.equal(rows[1]!.isSelf, true); assert.equal("hourlyRate" in rows[0]!, false); assert.equal("hourlyRate" in rows[2]!, false);
  assert.equal((await fixture(true)).read()[2]!.hourlyRate, 100);
});
it("uses original names/ids offline and omits departed encrypted members", async () => {
  const f = await fixture(); f.records.push({ kind: "members", id: "old", authorId: "departed", value: { _id: "old", name: "Do not publish", userId: "departed" } });
  assert.deepEqual(f.read(null).map((m) => [m.name, m.email, m.memberId]), [["Original owner", "", "mirror-owner"], ["Original viewer", "", "mirror-viewer"], ["Original peer", "", "mirror-peer"]]);
});
it("refuses metadata authority injection, foreign scope, ambiguous/missing members and stale reads without mutation", async () => {
  const f = await fixture(), original = structuredClone(f.records);
  assert.throws(() => f.read({ ...f.metadata, workspaceId: "other" }), /another account or workspace/);
  assert.throws(() => f.read({ ...f.metadata, members: [{ ...f.metadata.members[0]!, hourlyRate: 999 }] }));
  assert.throws(() => f.read({ ...f.metadata, members: [{ ...f.metadata.members[0]!, userId: "outsider" }] }), /trusted directory/);
  assert.throws(() => f.read(undefined, { workspaceId: "other" }), /another workspace/);
  f.records.push(structuredClone(f.records[0]!)); assert.throws(() => f.read(), /Duplicate/); f.records.splice(0, f.records.length, ...structuredClone(original));
  f.records.splice(0, 1); assert.throws(() => f.read(), /incomplete/); f.records.splice(0, f.records.length, ...structuredClone(original)); f.lock(); assert.throws(() => f.read(), /changed/); assert.deepEqual(f.records, original);
});

it("uses original member identities for rates even when server display IDs are replaced", async () => {
  const f = await fixture(true), spoofed = { ...f.metadata, members: f.metadata.members.map(row => ({ ...row, memberId: `untrusted-${row.userId}` })) };
  assert.deepEqual(f.read(spoofed).map(row => row.memberId), ["mirror-owner", "mirror-viewer", "mirror-peer"]);
  assert.throws(() => f.rate({ memberId: "untrusted-peer", hourlyRate: 20 }), /not found/);
  const before = structuredClone(f.records), plan = f.rate({ memberId: "mirror-peer", hourlyRate: 0 }); assert.deepEqual(f.records, before); assert.equal(plan.result.userId, "peer"); assert.equal(plan.result.hourlyRate, 0); assert.equal(plan.result.memberId, "mirror-peer");
  assert.equal(plan.records.length, 2); assert.ok(plan.records.every(row => row.authorId === "peer")); assert.equal(plan.records.find(row => row.kind === "members")!.value.role, "owner");
  const money = f.records.find(row => row.kind === "memberMoney" && row.authorId === "peer")!; money.value.legacyPrivateNote = { keep: true };
  assert.deepEqual(f.rate({ memberId: "mirror-peer", hourlyRate: null }).records.find(row => row.kind === "memberMoney")!.value.legacyPrivateNote, { keep: true });
  assert.deepEqual(f.rate({ memberId: "mirror-viewer", hourlyRate: 0 }).records, []);
});
it("requires owner or a money-trusted admin for any rate change and refuses hidden or forged monetary state", async () => {
  const restricted = await fixture(false); assert.throws(() => restricted.rate({ memberId: "mirror-viewer", hourlyRate: 10 }), /permission-required/);
  const f = await fixture(true), original = structuredClone(f.records); assert.throws(() => f.rate({ memberId: "mirror-peer", hourlyRate: 10 }, "peer"), /permission-required/);
  assert.equal(f.rate({ memberId: "mirror-owner", hourlyRate: null }, "owner").result.hourlyRate, null);
  for (const input of [{ memberId: "mirror-peer", hourlyRate: -1 }, { memberId: "mirror-peer", hourlyRate: 1000001 }, { memberId: "mirror-peer", hourlyRate: 20, role: "owner" }, { memberId: "mirror-peer", hourlyRate: 20, workspaceId: "other" }]) assert.throws(() => f.rate(input));
  assert.deepEqual(f.records, original); const money = f.records.find(row => row.kind === "memberMoney" && row.authorId === "peer")!; money.authorId = "viewer"; assert.throws(() => f.rate({ memberId: "mirror-peer", hourlyRate: 10 }), /financial record/); money.authorId = "peer";
  f.lock(); assert.throws(() => f.rate({ memberId: "mirror-peer", hourlyRate: 10 }), /changed/);
});
