import assert from "node:assert/strict";
import { it } from "node:test";
import { createKeyPair, createSigningPair } from "../privacy/crypto.js";
import { privateMemberKeyFingerprint, signPrivateWorkspaceDirectory, verifyPrivateWorkspaceDirectory } from "../privacy/directory.js";
import { privateFavoriteQuery } from "../privacy/favorite-view.js";
import type { PlainPrivateRecord } from "../privacy/records.js";
const scope = { server: "https://api.example.test", workspaceId: "workspace", userId: "owner" }, stamp = "2026-10-27T00:00:00.000Z";
async function fixture() {
 const pair = await createKeyPair(), signing = await createSigningPair(), person = { userId: scope.userId, role: "owner" as const, canViewOthersTime: true, canViewOthersMoney: true, publicKey: pair.publicKey, signingPublicKey: signing.publicKey };
 const signed = await signPrivateWorkspaceDirectory({ v: 1, server: scope.server, workspaceId: scope.workspaceId, ownerId: scope.userId, revision: 1, previousDigest: null, members: [person] }, signing.privateKey, null, new Map([[scope.userId, await privateMemberKeyFingerprint(scope.server, person)]]));
 const directory = await verifyPrivateWorkspaceDirectory(signed, scope, { ownerId: scope.userId, signingPublicKey: signing.publicKey, revision: 0, digest: null });
 const records: PlainPrivateRecord[] = [], add = (kind: PlainPrivateRecord["kind"], id: string, value: Record<string, unknown>, authorId: string | null = null) => records.push({ kind, id, authorId, value: { _id: id, workspaceId: scope.workspaceId, ...value } });
 add("clients", "client", { name: "Client" }); add("projects", "project", { name: "Archived project", color: "#112233", clientId: "client", archived: true }); add("tasks", "task", { name: "Task" });
 const pin = (id: string, order: number, extras: Record<string, unknown> = {}) => add("favorites", id, { userId: scope.userId, description: "Private pin", projectId: "project", taskId: "task", billable: true, order, createdAt: { $date: stamp }, updatedAt: stamp, ...extras }, scope.userId);
 pin("second", 1); pin("first", 0); let active = true;
 return { records, pin, read: (input: unknown = {}) => privateFavoriteQuery({ scope, directory, records, current: () => active, input }), lock: () => { active = false; } };
}
it("reads personal pins in original order with archived labels and preserved legacy versus explicit client snapshots", async () => {
 const f = await fixture(), rows = f.read(); assert.deepEqual(rows.map((row) => row.id), ["first", "second"]); assert.equal(rows[0]!.projectArchived, true); assert.equal(rows[0]!.clientName, "Client"); assert.equal(rows[0]!.taskName, "Task"); assert.equal(rows[0]!.createdAt, stamp); assert.equal("clientId" in rows[0]!, false);
 f.pin("unfiled", 2, { clientId: null }); const last = f.read().at(-1)!; assert.equal(last.clientName, null); assert.equal(last.clientId, null);
});
it("retains missing-reference labels and does not require unrelated entry or financial records", async () => {
 const f = await fixture(); f.pin("gone", 2, { projectId: "gone", taskId: "gone" }); const row = f.read().at(-1)!; assert.equal(row.projectMissing, true); assert.equal(row.taskMissing, true); assert.equal(row.projectName, null);
 f.records.push({ kind: "entryMoney", id: "unrelated", authorId: "owner", value: { invalid: "No money needed to read a pin" } }); assert.equal(f.read().length, 3);
});
it("refuses peer pins even for an owner, malformed rows, mismatched filters and stale sessions without editing originals", async () => {
 const f = await fixture(), original = structuredClone(f.records), row = f.records.find((r) => r.kind === "favorites")!;
 row.authorId = "peer"; assert.throws(() => f.read(), /another person's/); row.authorId = "owner"; row.value.userId = "peer"; assert.throws(() => f.read(), /another person's/); row.value.userId = "owner";
 assert.throws(() => f.read({ workspaceId: "elsewhere" }), /filter belongs/); assert.throws(() => f.read({ userId: "peer" })); row.value.order = -1; assert.throws(() => f.read());
 f.records.splice(0, f.records.length, ...structuredClone(original)); f.lock(); assert.throws(() => f.read(), /changed/); assert.deepEqual(f.records, original);
});
