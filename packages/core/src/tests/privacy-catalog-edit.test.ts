import assert from "node:assert/strict";
import { it } from "node:test";
import { createKeyPair, createSigningPair } from "../privacy/crypto.js";
import { privateMemberKeyFingerprint, signPrivateWorkspaceDirectory, verifyPrivateWorkspaceDirectory } from "../privacy/directory.js";
import { privateCatalogEdit, type PrivateCatalogEditPath } from "../privacy/catalog-edit.js";
import type { PlainPrivateRecord } from "../privacy/records.js";
const scope = { server: "https://api.example.test", workspaceId: "workspace", userId: "viewer" }, stamp = "2026-10-27T00:00:00.000Z";
async function fixture(role: "owner" | "admin" | "member" = "owner") {
  const pair = await createKeyPair(), signing = await createSigningPair();
  const viewer = { userId: "viewer", role, canViewOthersTime: true, canViewOthersMoney: true, publicKey: pair.publicKey, signingPublicKey: signing.publicKey };
  const owner = { ...viewer, userId: "owner", role: "owner" as const };
  const members = role === "owner" ? [viewer] : [owner, viewer];
  const signed = await signPrivateWorkspaceDirectory({ v: 1, server: scope.server, workspaceId: scope.workspaceId, ownerId: role === "owner" ? "viewer" : "owner", revision: 1, previousDigest: null, members }, signing.privateKey, null, new Map(await Promise.all(members.map(async (row) => [row.userId, await privateMemberKeyFingerprint(scope.server, row)] as const))));
  const directory = await verifyPrivateWorkspaceDirectory(signed, scope, { ownerId: signed.directory.ownerId, signingPublicKey: signing.publicKey, revision: 0, digest: null });
  const records: PlainPrivateRecord[] = [ { kind: "settings", id: "settings", authorId: null, value: { _id: "settings", workspaceId: "workspace", currency: "EUR", weekStartsOn: 1 } }, { kind: "settingsMoney", id: "settings", authorId: null, value: { _id: "settings", workspaceId: "workspace", defaultHourlyRate: 80 } } ];
  let open = true;
  const plan = (path: PrivateCatalogEditPath, input: unknown) => privateCatalogEdit({ path, input, scope, directory, records, current: () => open, now: Date.parse(stamp) });
  const edit = (path: PrivateCatalogEditPath, input: unknown) => { const result = plan(path, input), changed = new Set(result.records.map((row) => `${row.kind}:${row.id}`)); const kept = records.filter((row) => !changed.has(`${row.kind}:${row.id}`)); records.splice(0, records.length, ...kept, ...result.records); return result.result; };
  return { records, directory, plan, edit, lock: () => { open = false; } };
}
it("creates shared catalog identities with private financial counterparts and matching palette defaults", async () => {
  const f = await fixture(), client = f.edit("clients.create", { name: " Studio ", billing: { legalName: " Legal Studio ", country: "de" } });
  assert.equal(client.name, "Studio"); assert.equal((client.billing as { country: string }).country, "DE"); assert.equal("entryCount" in client, false);
  const money = f.records.find((row) => row.kind === "clientMoney")!; assert.equal(money.id, client.id); assert.equal("billing" in f.records.find((row) => row.kind === "clients")!.value, false);
  const project = f.edit("projects.create", { name: "Project", clientId: client.id, budgetAmount: 0, estimatedHours: 0 });
  assert.equal(project.budgetAmount, 0); assert.equal(project.budgetCurrency, "EUR"); assert.equal(project.estimatedHours, 0); assert.equal(project.billableDefault, true);
  assert.equal("budgetAmount" in f.records.find((row) => row.kind === "projects")!.value, false); assert.equal("hourlyRate" in f.records.find((row) => row.kind === "projects")!.value, false);
  const task = f.edit("tasks.create", { name: "Draft" }), tag = f.edit("tags.create", { name: "Focused", hidden: true });
  assert.equal(task.archived, false); assert.equal(tag.hidden, true); assert.match(String(tag.color), /^#[a-f0-9]{6}$/i); assert.equal("entryCount" in tag, false);
  for (const row of f.records.filter((row) => ["clients", "clientMoney", "projects", "projectMoney", "tasks", "tags"].includes(row.kind))) assert.equal(row.authorId, null);
});
it("keeps monetary snapshots and unknown original fields on metadata-only edits and archives", async () => {
  const f = await fixture(), client = f.edit("clients.create", { name: "Client", billing: { legalName: "Original", email: "old@example.test" } });
  const base = f.records.find((row) => row.kind === "clients")!, money = f.records.find((row) => row.kind === "clientMoney")!; base.value.unknown = { keep: "base" }; money.value.unknownMoney = { keep: "financial" };
  const originalMoney = structuredClone(money), renamed = f.plan("clients.update", { id: client.id, name: "Renamed" }); assert.equal(renamed.records.length, 1); f.edit("clients.update", { id: client.id, name: "Renamed" }); assert.deepEqual(money, originalMoney);
  const billed = f.edit("clients.update", { id: client.id, billing: { email: "new@example.test" } }); assert.equal((billed.billing as { legalName: string }).legalName, "Original");
  assert.deepEqual(f.records.find((row) => row.kind === "clients")!.value.unknown, { keep: "base" }); assert.deepEqual(f.records.find((row) => row.kind === "clientMoney")!.value.unknownMoney, { keep: "financial" });
  assert.equal(f.edit("clients.archive", { id: client.id }).archived, true); assert.equal(f.edit("clients.archive", { id: client.id, archived: false }).archived, false);
  assert.equal(f.edit("clients.update", { id: client.id, billing: null }).billing, null);
});
it("pins budget currency across later workspace changes and never reprices prior time", async () => {
  const f = await fixture(), project = f.edit("projects.create", { name: "Project", budgetAmount: 100, hourlyRate: 90 });
  const original: PlainPrivateRecord = { kind: "entryMoney", id: "entry", authorId: "peer", value: { _id: "entry", workspaceId: "workspace", hourlyRate: 30 } }; f.records.push(original); const before = structuredClone(original);
  f.records.find((row) => row.kind === "settings")!.value.currency = "USD";
  const updated = f.edit("projects.update", { id: project.id, budgetAmount: 200, hourlyRate: 0, applyToEntries: false }); assert.equal(updated.budgetCurrency, "EUR"); assert.equal(updated.billableDefault, false); assert.equal(updated.entriesRewritten, null); assert.deepEqual(original, before);
  assert.equal(f.edit("projects.update", { id: project.id, budgetAmount: null }).budgetCurrency, null);
  assert.equal(f.edit("projects.update", { id: project.id, budgetAmount: 20 }).budgetCurrency, "USD");
});
it("rejects duplicate names literally and case-insensitively under the current workspace catalog", async () => {
  const f = await fixture(), first = f.edit("tags.create", { name: "(a+)+$" }); assert.throws(() => f.edit("tags.create", { name: "(A+)+$" }), /already exists/); f.edit("tags.create", { name: "aaaaaaaaaa" });
  f.edit("tasks.create", { name: "Café" }); assert.throws(() => f.edit("tasks.create", { name: "Café" }), /already exists/); f.edit("tasks.create", { name: "Cafe" });
  assert.equal(f.edit("tags.update", { id: first.id, name: "(A+)+$", archived: true }).name, "(A+)+$"); assert.throws(() => f.edit("tags.create", { name: "(a+)+$" }), /already exists/);
});
it("refuses foreign scopes, blank names, invalid billing and historical transitions without changing any original", async () => {
  const f = await fixture(), first = f.edit("clients.create", { name: "First" }), second = f.edit("clients.create", { name: "Second" }), project = f.edit("projects.create", { name: "Project", clientId: first.id });
  const before = structuredClone(f.records);
  for (const [path, input] of [ ["projects.update", { id: project.id, clientId: second.id }], ["projects.update", { id: project.id, applyToEntries: true, hourlyRate: 100 }], ["projects.create", { name: "Foreign", clientId: "foreign" }], ["tags.create", { name: " " }], ["tags.create", { name: "X", workspaceId: "foreign" }], ["tasks.create", { name: "X", authorId: "peer" }], ["clients.update", { id: first.id, billing: { electronicAddress: "mail@example.test" } }] ] as const) assert.throws(() => f.plan(path, input));
  assert.deepEqual(f.records, before); assert.equal(f.edit("projects.update", { id: project.id, clientId: first.id }).clientId, first.id);
});
it("requires verified owner/admin authority and an unchanged unlocked scope", async () => {
  const member = await fixture("member"); assert.throws(() => member.edit("tasks.create", { name: "Forbidden" }), /permissions/); assert.equal(member.records.length, 2);
  const admin = await fixture("admin"); assert.equal(admin.edit("tasks.create", { name: "Allowed" }).name, "Allowed"); admin.lock(); assert.throws(() => admin.edit("tasks.create", { name: "Locked" }), /changed/);
});

it("keeps malformed original billing intact instead of dropping it during a partial edit", async () => {
  const f = await fixture(), client = f.edit("clients.create", { name: "Client" });
  f.records.find((row) => row.kind === "clientMoney")!.value.billing = { legalName: "Original", email: { privateNote: "Keep this original until reviewed" } };
  const before = structuredClone(f.records); assert.throws(() => f.plan("clients.update", { id: client.id, billing: { legalName: "Later" } })); assert.deepEqual(f.records, before);
});
