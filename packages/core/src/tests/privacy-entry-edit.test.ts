import assert from "node:assert/strict";
import { it } from "node:test";
import { createKeyPair, createSigningPair } from "../privacy/crypto.js";
import { privateMemberKeyFingerprint, signPrivateWorkspaceDirectory, verifyPrivateWorkspaceDirectory } from "../privacy/directory.js";
import { privateEntryEdit, type PrivateEntryEditPath } from "../privacy/entry-edit.js";
import type { PlainPrivateRecord } from "../privacy/records.js";
import type { TimeEntry } from "@starter/shared";
const scope = { server: "https://api.example.test", workspaceId: "workspace", userId: "author" }, stamp = "2026-10-27T00:00:00.000Z";
const span = { start: "2026-10-26T10:00:00.000Z", end: "2026-10-26T11:00:00.000Z" };
async function fixture() {
  const pair = await createKeyPair(), signing = await createSigningPair(), ownerPair = await createKeyPair();
  const author = { userId: scope.userId, role: "member" as const, canViewOthersTime: true, canViewOthersMoney: true, publicKey: pair.publicKey, signingPublicKey: signing.publicKey }, owner = { ...author, userId: "owner", role: "owner" as const, publicKey: ownerPair.publicKey };
  const signed = await signPrivateWorkspaceDirectory({ v: 1, server: scope.server, workspaceId: scope.workspaceId, ownerId: "owner", revision: 1, previousDigest: null, members: [owner, author] }, signing.privateKey, null, new Map(await Promise.all([owner, author].map(async (row) => [row.userId, await privateMemberKeyFingerprint(scope.server, row)] as const))));
  const directory = await verifyPrivateWorkspaceDirectory(signed, scope, { ownerId: "owner", signingPublicKey: signing.publicKey, revision: 0, digest: null });
  const records: PlainPrivateRecord[] = [];
  const add = (kind: PlainPrivateRecord["kind"], id: string, fields: Record<string, unknown>, authorId: string | null = null) => { const row = { kind, id, authorId, value: { _id: id, workspaceId: scope.workspaceId, ...fields } }; records.push(row); return row; };
  add("settings", "settings", { currency: "EUR" }); add("settingsMoney", "settings", { defaultHourlyRate: 80 });
  add("members", "member", { userId: scope.userId }, scope.userId); add("memberMoney", "member", { hourlyRate: 60 }, scope.userId);
  add("clients", "client", {}); add("clients", "other-client", {}); add("tasks", "task", {}); add("tags", "tag", {});
  add("projects", "project", { clientId: "client", billableDefault: true }); add("projectMoney", "project", { hourlyRate: null });
  let open = true;
  const plan = (path: PrivateEntryEditPath, input: unknown) => privateEntryEdit({ scope, directory, records, path, input, current: () => open, now: Date.parse(stamp) });
  const edit = (path: PrivateEntryEditPath, input: unknown) => { const result = plan(path, input), changed = new Set([...result.records, ...result.remove].map((row) => `${row.kind}:${row.id}`)); records.splice(0, records.length, ...records.filter((row) => !changed.has(`${row.kind}:${row.id}`)), ...result.records); return result.result as TimeEntry; };
  const create = (fields: Record<string, unknown> = {}) => edit("entries.create", { ...span, projectId: "project", taskId: "task", tagIds: ["tag", "tag"], ...fields });
  return { records, add, plan, edit, create, lock: () => { open = false; } };
}
it("creates author-owned completed time with separate rate snapshots, member defaults and explicit client attribution", async () => {
  const f = await fixture(), entry = f.create({ description: "Private manual time", source: "desktop", timeZone: "Europe/Berlin" });
  assert.equal(entry.authorId, scope.userId); assert.equal(entry.hourlyRate, 60); assert.equal(entry.currency, "EUR"); assert.equal(entry.durationSec, 3600); assert.equal(entry.clientId, "client"); assert.equal(entry.billable, true); assert.deepEqual(entry.tagIds, ["tag"]); assert.equal(entry.source, "desktop");
  const raw = f.records.find((row) => row.kind === "entries")!; assert.equal("hourlyRate" in raw.value, false); assert.equal(raw.authorId, scope.userId);
  assert.equal(f.create({ clientId: null }).clientId, null);
  f.records.find((row) => row.kind === "memberMoney")!.value.hourlyRate = 0;
  const zero = f.create(); assert.equal(zero.billable, false); assert.equal(zero.hourlyRate, null);
  f.records.find((row) => row.kind === "projectMoney")!.value.hourlyRate = 90;
  assert.equal(f.create().hourlyRate, 90);
});
it("retains original historical money and unknown fields on description, tag and time edits", async () => {
  const f = await fixture(), entry = f.create(), raw = f.records.find((row) => row.kind === "entries" && row.id === entry.id)!, money = f.records.find((row) => row.kind === "entryMoney" && row.id === entry.id)!;
  raw.value.unknown = { original: true }; money.value.unknownFinancial = { original: true };
  const before = structuredClone(money); f.records.find((row) => row.kind === "settings")!.value.currency = "USD"; f.records.find((row) => row.kind === "projectMoney")!.value.hourlyRate = 150;
  const plan = f.plan("entries.update", { id: entry.id, description: "Renamed" }); assert.equal(plan.records.length, 1); assert.deepEqual(money, before);
  const updated = f.edit("entries.update", { id: entry.id, description: "Renamed", end: "2026-10-26T12:00:00.000Z" }); assert.equal(updated.hourlyRate, 60); assert.equal(updated.currency, "EUR"); assert.equal(updated.durationSec, 7200); assert.deepEqual(updated.tagIds, ["tag"]);
  assert.deepEqual(f.records.find((row) => row.kind === "entries" && row.id === entry.id)!.value.unknown, { original: true });
  assert.deepEqual(f.edit("entries.update", { id: entry.id, tagIds: [] }).tagIds, []);
  const repriced = f.edit("entries.update", { id: entry.id, billable: false }); assert.equal(repriced.hourlyRate, null); assert.equal(repriced.currency, "USD");
  assert.deepEqual(f.records.find((row) => row.kind === "entryMoney" && row.id === entry.id)!.value.unknownFinancial, { original: true });
});
it("preserves legacy client attribution when moving projects and respects explicit no-client", async () => {
  const f = await fixture(), entry = f.create(), raw = f.records.find((row) => row.kind === "entries" && row.id === entry.id)!; delete raw.value.clientId;
  f.add("projects", "other-project", { clientId: "other-client", billableDefault: true }); f.add("projectMoney", "other-project", { hourlyRate: 120 });
  const moved = f.edit("entries.update", { id: entry.id, projectId: "other-project" }); assert.equal(moved.clientId, "client"); assert.equal(moved.taskId, "task"); assert.equal(moved.hourlyRate, 120);
  assert.equal(f.edit("entries.update", { id: entry.id, clientId: null }).clientId, null);
});
it("honors invoice locks while allowing relabelling and retagging", async () => {
  const f = await fixture(), entry = f.create(), raw = f.records.find((row) => row.kind === "entries")!; raw.value.invoiceId = "invoice";
  assert.equal(f.edit("entries.update", { id: entry.id, description: "Safe", tagIds: [] }).description, "Safe");
  assert.throws(() => f.plan("entries.update", { id: entry.id, billable: entry.billable }), /Invoiced/);
  assert.throws(() => f.plan("entries.remove", { id: entry.id }), /Invoiced/);
});
it("checks both original and proposed approval intervals atomically, including future unknown locked statuses", async () => {
  const f = await fixture(), entry = f.create();
  f.add("approvals", "approval", { authorId: scope.userId, start: "2026-10-26T11:00:00.000Z", end: "2026-10-26T12:00:00.000Z", status: "approved" }, scope.userId);
  assert.equal(f.edit("entries.update", { id: entry.id, description: "Adjacent is allowed" }).description, "Adjacent is allowed");
  assert.throws(() => f.plan("entries.update", { id: entry.id, end: "2026-10-26T11:00:01.000Z" }), /approved/);
  const approval = f.records.find((row) => row.kind === "approvals")!; approval.value.start = "2026-10-26T10:30:00.000Z"; approval.value.status = "future-lock";
  assert.throws(() => f.plan("entries.update", { id: entry.id, ...span, start: "2026-10-25T10:00:00.000Z", end: "2026-10-25T11:00:00.000Z" }), /approved/);
  assert.throws(() => f.plan("entries.remove", { id: entry.id }), /approved/); assert.throws(() => f.create(), /approved/);
  approval.value.status = "rejected"; assert.equal(f.create().durationSec, 3600);
});
it("cannot edit another author's time or silently touch running timers", async () => {
  const f = await fixture(), entry = f.create(), raw = f.records.find((row) => row.kind === "entries")!, money = f.records.find((row) => row.kind === "entryMoney")!;
  raw.authorId = "owner"; raw.value.authorId = "owner"; money.authorId = "owner";
  assert.throws(() => f.plan("entries.update", { id: entry.id, description: "Forbidden" }), /not found/); assert.throws(() => f.plan("entries.remove", { id: entry.id }), /not found/);
  raw.authorId = scope.userId; raw.value.authorId = scope.userId; money.authorId = scope.userId;
  assert.throws(() => f.plan("entries.update", { id: entry.id, end: null }), /coordination/);
  delete raw.value.end; assert.throws(() => f.plan("entries.remove", { id: entry.id }), /coordination/);
});
it("removes both entry and money together without mutating source records while planning", async () => {
  const f = await fixture(), entry = f.create(), before = structuredClone(f.records), plan = f.plan("entries.remove", { id: entry.id });
  assert.equal(plan.remove.length, 2); assert.deepEqual(plan.result, { success: true, id: entry.id }); assert.deepEqual(f.records, before);
});
it("refuses invalid references, forged scopes/authors, unknown fields and standard replay identities", async () => {
  const f = await fixture(), entry = f.create(), before = structuredClone(f.records);
  for (const input of [{ projectId: "foreign" }, { taskId: "foreign" }, { clientId: "foreign" }, { tagIds: ["foreign"] }, { workspaceId: "foreign" }, { authorId: "owner" }, { operationId: crypto.randomUUID() }]) assert.throws(() => f.plan("entries.create", { ...span, ...input }));
  assert.throws(() => f.plan("entries.update", { id: entry.id, end: span.start })); assert.deepEqual(f.records, before);
  const approval = f.add("approvals", "bad", { authorId: "owner", ...span, status: "draft" }, scope.userId); assert.throws(() => f.create(), /author/); f.records.splice(f.records.indexOf(approval), 1);
  f.lock(); assert.throws(() => f.create(), /changed/);
});
