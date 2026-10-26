import assert from "node:assert/strict";
import { it } from "node:test";
import { createKeyPair, createSigningPair } from "../privacy/crypto.js";
import { privateMemberKeyFingerprint, signPrivateWorkspaceDirectory, verifyPrivateWorkspaceDirectory } from "../privacy/directory.js";
import { privateEntryQuery, type PrivateEntryQueryPath } from "../privacy/entry-view.js";
import type { PlainPrivateRecord } from "../privacy/records.js";
const scope = { server: "https://api.example.test", workspaceId: "workspace", userId: "owner" }, now = Date.parse("2026-10-27T00:00:00.000Z"), stamp = new Date(now - 3600000).toISOString();
async function fixture(othersTime = true, othersMoney = true, owner = true) {
 const pair = await createKeyPair(), signing = await createSigningPair();
 const member = { userId: scope.userId, role: owner ? "owner" as const : "member" as const, canViewOthersTime: othersTime, canViewOthersMoney: othersMoney, publicKey: pair.publicKey, signingPublicKey: signing.publicKey };
 const members = owner ? [member] : [{ ...member, userId: "admin", role: "owner" as const }, member];
 const directoryOwner = owner ? "owner" : "admin";
 const signed = await signPrivateWorkspaceDirectory({ v: 1, server: scope.server, workspaceId: scope.workspaceId, ownerId: directoryOwner, revision: 1, previousDigest: null, members }, signing.privateKey, null, new Map(await Promise.all(members.map(async (p) => [p.userId, await privateMemberKeyFingerprint(scope.server, p)] as const))));
 const directory = await verifyPrivateWorkspaceDirectory(signed, scope, { ownerId: directoryOwner, signingPublicKey: signing.publicKey, revision: 0, digest: null });
 const records: PlainPrivateRecord[] = [];
 const add = (kind: PlainPrivateRecord["kind"], id: string, value: Record<string, unknown>, authorId: string | null = null) => records.push({ kind, id, authorId, value: { _id: id, workspaceId: scope.workspaceId, ...value } });
 add("clients", "client", { name: "Original client" }); add("clients", "other-client", { name: "Moved client" });
 add("projects", "project", { name: "Archived project", color: "#112233", clientId: "client", archived: true }); add("tasks", "task", { name: "Task" });
 const entry = (id: string, authorId = "owner", changes: Record<string, unknown> = {}, rate: number | null = 100) => {
  add("entries", id, { authorId, description: "Design [draft]", projectId: "project", taskId: "task", tagIds: ["tag"], billable: true, start: { $date: stamp }, end: new Date(now - 1800000).toISOString(), durationSec: { $numberInt: "1800" }, currency: "EUR", source: "web", createdAt: stamp, updatedAt: stamp, reminderSentAt: "Never expose this field", ...changes }, authorId);
  if (authorId === "owner" || othersMoney || owner) add("entryMoney", id, { hourlyRate: rate }, authorId);
 };
 entry("a"); entry("b", "owner", { clientId: null }); if (othersTime || owner) entry("c", "peer", { clientId: "other-client" }, 50);
 let active = true;
 const read = (path: PrivateEntryQueryPath, input: unknown = {}) => privateEntryQuery({ path, input, scope, directory, records, current: () => active, now }) as any;
 const list = (input: Record<string, unknown> = {}) => read("entries.list", { from: "2026-10-26", to: "2026-10-28", ...input });
 return { records, read, list, entry, lock: () => { active = false; } };
}
it("preserves original BSON entry facts, joins, legacy defaults and historical money while stripping server-only fields", async () => {
 const f = await fixture(), rows = f.list().entries;
 assert.deepEqual(rows.map((row: any) => row.id), ["c", "b", "a"]);
 assert.equal(rows[0].clientName, "Moved client"); assert.equal(rows[1].clientName, null); assert.equal(rows[2].clientName, "Original client");
 const own = f.read("entries.get", { id: "a", workspaceId: scope.workspaceId }); assert.equal(own.hourlyRate, 100); assert.equal(own.start, stamp); assert.equal(own.timeZone, null); assert.equal(own.importId, null); assert.equal(own.runaway, null); assert.equal("reminderSentAt" in own, false); assert.equal("clientId" in own, false);
 assert.equal(rows[2].amount, 50); assert.equal(rows[2].projectName, "Archived project"); assert.equal(rows[2].taskName, "Task");
});
it("withholds peer money, rejects unexpected ungranted time and requires matching financial records only where visible", async () => {
 const f = await fixture(true, false, false), peer = f.list().entries[0]; assert.equal(peer.authorId, "peer"); assert.equal(peer.hourlyRate, null); assert.equal(peer.amount, null); assert.equal(f.read("entries.get", { id: "c" }).hourlyRate, null);
 f.records.splice(f.records.findIndex((row) => row.kind === "entryMoney" && row.id === "a"), 1); assert.throws(() => f.read("entries.get", { id: "a" }), /financial record/);
 const own = await fixture(false, false, false); assert.equal(own.list().entries.length, 2); own.entry("ungranted", "peer"); assert.throws(() => own.list(), /ungranted time/);
});
it("matches overlap boundaries, literal search and combined catalog/tag/billable filters", async () => {
 const f = await fixture(); assert.equal(f.list({ clientIds: ["client"] }).entries.length, 1); assert.equal(f.list({ clientIds: [] }).entries.length, 3); assert.equal(f.list({ projectIds: [] }).entries.length, 0); assert.equal(f.list({ taskIds: [] }).entries.length, 0);
 assert.equal(f.list({ search: " [draft] ", tagIds: ["tag"], billable: true, projectIds: ["project"], taskIds: ["task"] }).entries.length, 3); assert.equal(f.list({ search: ".*" }).entries.length, 0); assert.equal(f.list({ tagIds: [] }).entries.length, 3);
 assert.equal(f.list({ from: new Date(now - 1800000).toISOString() }).entries.length, 0); assert.equal(f.list({ to: stamp }).entries.length, 0);
 f.entry("running", "owner", { end: null, start: "2025-01-01T00:00:00.000Z", durationSec: 0 }, null); assert.equal(f.list().entries.at(-1).id, "running");
});
it("paginates equal start times and retains old ID-only cursors without dropping or repeating entries", async () => {
 const f = await fixture(), first = f.list({ limit: 1 }); assert.equal(first.entries[0].id, "c"); assert.equal(first.nextCursor, `${stamp}|c`);
 const second = f.list({ limit: 1, cursor: first.nextCursor }); assert.equal(second.entries[0].id, "b"); assert.equal(f.list({ cursor: second.nextCursor }).entries[0].id, "a"); assert.equal(f.list({ cursor: "b" }).entries[0].id, "a"); assert.deepEqual(f.list({ cursor: "invalid" }), { entries: [] });
});
it("keeps recents/description suggestions author-scoped and respects explicit unfiled filters and archived labels", async () => {
 const f = await fixture(); f.entry("new", "owner", { description: "DESIGN [DRAFT]", start: new Date(now - 900000).toISOString(), projectId: null, taskId: null, tagIds: ["new-tag"] }); f.entry("running", "owner", { end: null, description: "Never suggest a running task" });
 const recent = f.read("entries.recent"); assert.equal(recent.length, 3); assert.equal(recent[0].description, "DESIGN [DRAFT]"); assert.equal(recent[1].projectArchived, true); assert.equal(recent.some((row: any) => row.lastEntryId === "c"), false);
 const descriptions = f.read("entries.descriptions"); assert.equal(descriptions.length, 1); assert.equal(descriptions[0].description, "DESIGN [DRAFT]"); assert.equal(descriptions[0].count, 3); assert.deepEqual(descriptions[0].tagIds, ["new-tag"]);
 assert.equal(f.read("entries.descriptions", { projectId: null }).length, 1); assert.equal(f.read("entries.descriptions", { taskId: "missing" }).length, 0); assert.equal(f.read("entries.descriptions", { search: ".*" }).length, 0);
});
it("limits quick-start scans after filtering and does not require money fields for text suggestions", async () => {
 const f = await fixture(); f.records.splice(0, f.records.length, ...f.records.filter((row) => row.kind !== "entries" && row.kind !== "entryMoney"));
 for (let i = 0; i < 405; i++) f.entry(`entry-${String(i).padStart(4, "0")}`, "owner", { description: i === 0 ? "oldest" : "current", start: new Date(now - (406 - i) * 1000).toISOString() });
 for (const row of f.records) if (row.kind === "entryMoney") row.value.hourlyRate = "invalid";
 const recent = f.read("entries.recent"); assert.equal(recent.length, 1); assert.equal(recent[0].count, 400);
 assert.equal(f.read("entries.descriptions", { search: "oldest" })[0].description, "oldest");
});
it("refuses foreign scopes, forged authors, invalid fields, unknown filters and stale reads without mutating originals", async () => {
 const f = await fixture(), original = structuredClone(f.records);
 assert.throws(() => f.list({ workspaceId: "other" }), /filter belongs/); assert.throws(() => f.list({ extra: "private" })); assert.throws(() => f.read("entries.get", { id: "missing" }), /not found/);
 const row = f.records.find((row) => row.kind === "entries")!; row.value.authorId = "forged"; assert.throws(() => f.list(), /ungranted/); row.value.authorId = row.authorId;
 row.value.currency = "invalid"; assert.throws(() => f.list()); f.records.splice(0, f.records.length, ...structuredClone(original)); f.lock(); assert.throws(() => f.list(), /changed/); assert.deepEqual(f.records, original);
});

it("retains legacy running entries whose stored end field is absent", async () => {
 const f = await fixture(); const raw = f.records.find((row) => row.kind === "entries" && row.id === "a")!; delete raw.value.end;
 assert.equal(f.read("entries.get", { id: "a" }).end, null); assert.equal(f.list().entries.find((row: any) => row.id === "a").end, null);
 assert.equal(f.read("entries.recent").some((row: any) => row.lastEntryId === "a"), false);
});
