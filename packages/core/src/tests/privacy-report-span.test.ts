import assert from "node:assert/strict";
import { it } from "node:test";
import { createKeyPair, createSigningPair } from "../privacy/crypto.js";
import { privateMemberKeyFingerprint, signPrivateWorkspaceDirectory, verifyPrivateWorkspaceDirectory } from "../privacy/directory.js";
import { privateReportTrackedSpan } from "../privacy/report-span.js";
import type { PlainPrivateRecord } from "../privacy/records.js";
const scope = { server: "https://api.example.test", workspaceId: "workspace", userId: "viewer" }, now = Date.parse("2026-10-27T00:00:00.000Z");
async function fixture(time = true) {
 const pair = await createKeyPair(), signing = await createSigningPair(), person = { userId: scope.userId, role: "member" as const, canViewOthersTime: time, canViewOthersMoney: false, publicKey: pair.publicKey, signingPublicKey: signing.publicKey };
 const members = [{ ...person, userId: "owner", role: "owner" as const, canViewOthersTime: true, canViewOthersMoney: true }, person];
 const signed = await signPrivateWorkspaceDirectory({ v: 1, server: scope.server, workspaceId: scope.workspaceId, ownerId: "owner", revision: 1, previousDigest: null, members }, signing.privateKey, null, new Map(await Promise.all(members.map(async (p) => [p.userId, await privateMemberKeyFingerprint(scope.server, p)] as const))));
 const directory = await verifyPrivateWorkspaceDirectory(signed, scope, { ownerId: "owner", signingPublicKey: signing.publicKey, revision: 0, digest: null });
 const records: PlainPrivateRecord[] = [], add = (id: string, start: string, end: string | null | undefined, authorId = "viewer") => { records.push({ kind: "entries", id, authorId, value: { _id: id, workspaceId: scope.workspaceId, authorId, start: { $date: start }, ...(end === undefined ? {} : { end }), description: { invalid: "Not needed for bounds" } } }); };
 let active = true; return { records, add, read: (input: unknown = {}) => privateReportTrackedSpan({ scope, directory, records, current: () => active, input, now }), lock: () => { active = false; } };
}
it("keeps first/last day bounds, today and future/running entries in the selected timezone", async () => {
 const f = await fixture(); assert.deepEqual(f.read(), { from: null, to: null });
 f.add("first", "2026-08-21T23:30:00.000Z", "2026-08-22T00:30:00.000Z"); assert.deepEqual(f.read({ timeZone: "Europe/Berlin" }), { from: "2026-08-22", to: "2026-10-27" });
 f.add("future", "2026-12-01T23:30:00.000Z", null); assert.deepEqual(f.read({ timeZone: "Europe/Berlin" }), { from: "2026-08-22", to: "2026-12-02" });
 f.add("later-end", "2026-11-01T00:00:00.000Z", "2026-12-09T23:30:00.000Z"); assert.equal(f.read({ timeZone: "Europe/Berlin" }).to, "2026-12-10");
});
it("intersects requested members with verified visibility and requires no financial records", async () => {
 const f = await fixture(false); f.add("own", "2026-10-01T00:00:00.000Z", null); assert.deepEqual(f.read({ memberIds: ["peer"] }), { from: null, to: null }); assert.equal(f.read({ memberIds: [] }).from, "2026-10-01");
 f.add("ungranted", "2025-01-01T00:00:00.000Z", null, "peer"); assert.throws(() => f.read(), /ungranted time/);
 const shared = await fixture(); shared.add("own", "2026-10-01T00:00:00.000Z", null); shared.add("peer", "2025-01-01T00:00:00.000Z", null, "peer"); assert.equal(shared.read({ memberIds: ["viewer"] }).from, "2026-10-01"); assert.equal(shared.read({ memberIds: ["peer"] }).from, "2025-01-01");
});
it("accepts legacy absent end fields while refusing foreign scopes, forged authors and stale reads without mutation", async () => {
 const f = await fixture(); f.add("legacy", "2026-10-01T00:00:00.000Z", undefined); const original = structuredClone(f.records); assert.equal(f.read().from, "2026-10-01"); assert.deepEqual(f.records, original);
 assert.throws(() => f.read({ workspaceId: "other" }), /filter belongs/); assert.throws(() => f.read({ search: "Never send" })); f.records[0]!.value.authorId = "wrong"; assert.throws(() => f.read(), /ungranted/); f.records.splice(0, f.records.length, ...original); f.lock(); assert.throws(() => f.read(), /changed/);
});
