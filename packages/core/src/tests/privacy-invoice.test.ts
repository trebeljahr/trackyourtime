import assert from "node:assert/strict";
import { it } from "node:test";
import type { WorkspaceRole } from "@starter/shared";
import { createKeyPair, createSigningPair } from "../privacy/crypto.js";
import { privateMemberKeyFingerprint, signPrivateWorkspaceDirectory, verifyPrivateWorkspaceDirectory } from "../privacy/directory.js";
import { privateInvoiceQuery, privateInvoiceFromRecord, privateInvoiceRecordValue } from "../privacy/invoice-view.js";
import { privateInvoiceEdit } from "../privacy/invoice-edit.js";
import type { PlainPrivateRecord } from "../privacy/records.js";

const scope = { server: "https://api.example.test", workspaceId: "workspace", userId: "owner" };
const at = (iso: string) => new Date(iso).toISOString();
const NOW = Date.parse("2026-11-08T12:00:00.000Z");

async function fixture(role: WorkspaceRole = "owner", money = true) {
  const pair = await createKeyPair(), signing = await createSigningPair();
  const owner = { userId: "owner", role: "owner" as const, canViewOthersTime: true, canViewOthersMoney: true, publicKey: pair.publicKey, signingPublicKey: signing.publicKey };
  const reader = role === "owner" ? owner : { ...owner, userId: "reader", role, canViewOthersTime: true, canViewOthersMoney: money };
  const members = role === "owner" ? [owner] : [owner, reader];
  const signed = await signPrivateWorkspaceDirectory({ v: 1, server: scope.server, workspaceId: scope.workspaceId, ownerId: "owner", revision: 1, previousDigest: null, members }, signing.privateKey, null, new Map(await Promise.all(members.map(async (person) => [person.userId, await privateMemberKeyFingerprint(scope.server, person)] as const))));
  const directory = await verifyPrivateWorkspaceDirectory(signed, scope, { ownerId: "owner", signingPublicKey: signing.publicKey, revision: 0, digest: null });
  const stamp = at("2026-11-01T00:00:00Z");
  let records: PlainPrivateRecord[] = [
    { kind: "settings", id: "settings", authorId: null, value: { _id: "settings", workspaceId: scope.workspaceId, currency: "EUR", weekStartsOn: 1 } },
    { kind: "settingsMoney", id: "settings", authorId: null, value: { _id: "settings", defaultHourlyRate: null } },
    { kind: "clients", id: "client", authorId: null, value: { _id: "client", workspaceId: scope.workspaceId, name: "Northwind", color: "#123456", archived: false, createdAt: stamp, updatedAt: stamp } },
    { kind: "clientMoney", id: "client", authorId: null, value: { _id: "client", billing: null } },
    { kind: "projects", id: "project", authorId: null, value: { _id: "project", workspaceId: scope.workspaceId, name: "Build", clientId: "client", color: "#654321", archived: false, billableDefault: true, createdAt: stamp, updatedAt: stamp } },
    { kind: "projectMoney", id: "project", authorId: null, value: { _id: "project", hourlyRate: 100 } },
    { kind: "entries", id: "entry", authorId: "owner", value: { _id: "entry", workspaceId: scope.workspaceId, authorId: "owner", description: "Foundations", clientId: "client", projectId: "project", taskId: null, billable: true, start: at("2026-11-05T09:00:00Z"), end: at("2026-11-05T12:00:00Z"), tagIds: [], durationSec: 10_800, currency: "EUR", source: "web", timeZone: null, runaway: null, invoiceId: null, importId: null, createdAt: stamp, updatedAt: stamp } },
    { kind: "entryMoney", id: "entry", authorId: "owner", value: { _id: "entry", hourlyRate: 100 } },
  ];
  const as = (userId: string) => ({ scope: { ...scope, userId }, directory, current: () => true, now: NOW });
  const user = role === "owner" ? "owner" : "reader";
  const apply = (plan: { records: PlainPrivateRecord[]; remove: { kind: string; id: string }[] }) => {
    const gone = new Set([...plan.records, ...plan.remove].map((row) => JSON.stringify([row.kind, row.id])));
    records = [...records.filter((row) => !gone.has(JSON.stringify([row.kind, row.id]))), ...plan.records];
  };
  return {
    get records() { return records; }, apply,
    query: (path: "invoices.list" | "invoices.get" | "invoices.preview", input: unknown) => privateInvoiceQuery({ ...as(user), records, path, input }),
    edit: (path: "invoices.create" | "invoices.updateStatus" | "invoices.remove", input: unknown) => privateInvoiceEdit({ ...as(user), records, path, input, newId: () => "11111111-1111-4111-8111-111111111111" }),
  };
}

const range = { clientId: "client", from: "2026-11-01", to: "2026-11-08", groupBy: "project" as const };

it("previews billable time with the server's rules, from the decrypted copy", async () => {
  const f = await fixture(), preview = await f.query("invoices.preview", range) as Awaited<ReturnType<typeof privateInvoiceQuery>> & { lineItems: { hours: number; amount: number }[]; total: number; entryIds: string[]; suggestedNumber: string };
  assert.equal(preview.lineItems.length, 1); assert.equal(preview.lineItems[0]!.hours, 3); assert.equal(preview.total, 300);
  assert.deepEqual(preview.entryIds, ["entry"]); assert.equal(preview.suggestedNumber, "2026-001");
});

it("creates the invoice and stamps its entries in one change, so the time bills once", async () => {
  const f = await fixture();
  const plan = await f.edit("invoices.create", { ...range, issueDate: "2026-11-08", dueDate: "2026-11-22" });
  const invoice = plan.result as { id: string; number: string; total: number; status: string; entryIds: string[] };
  assert.equal(invoice.number, "2026-001"); assert.equal(invoice.total, 300); assert.equal(invoice.status, "draft"); assert.deepEqual(invoice.entryIds, ["entry"]);
  assert.deepEqual(plan.records.map((row) => row.kind).sort(), ["entries", "invoices"]);
  assert.equal((plan.records.find((row) => row.kind === "entries")!.value as { invoiceId: string }).invoiceId, invoice.id);
  f.apply(plan);
  const again = await f.query("invoices.preview", range) as { lineItems: unknown[]; skippedInvoiced: number; suggestedNumber: string };
  assert.equal(again.lineItems.length, 0); assert.equal(again.skippedInvoiced, 1); assert.equal(again.suggestedNumber, "2026-002");
  await assert.rejects(f.edit("invoices.create", { ...range, issueDate: "2026-11-08", dueDate: "2026-11-22" }), /no un-invoiced billable time/);
  const listed = await f.query("invoices.list", {}) as { invoices: { id: string }[] };
  assert.deepEqual(listed.invoices.map((row) => row.id), [invoice.id]);
});

it("deletes only a draft, and gives its time back", async () => {
  const f = await fixture();
  const created = await f.edit("invoices.create", { ...range, issueDate: "2026-11-08", dueDate: "2026-11-22" }); f.apply(created);
  const id = (created.result as { id: string }).id;
  const removed = await f.edit("invoices.remove", { id });
  assert.deepEqual(removed.result, { deleted: true, releasedEntries: 1 });
  assert.equal((removed.records[0]!.value as { invoiceId: unknown }).invoiceId, null);
  f.apply(removed);
  assert.equal(((await f.query("invoices.preview", range)) as { lineItems: unknown[] }).lineItems.length, 1);
  const again = await f.edit("invoices.create", { ...range, issueDate: "2026-11-08", dueDate: "2026-11-22" }); f.apply(again);
  const sent = await f.edit("invoices.updateStatus", { id, status: "sent" }); f.apply(sent);
  assert.equal((sent.result as { status: string }).status, "sent");
  await assert.rejects(f.edit("invoices.remove", { id }), /record now/);
  await assert.rejects(f.edit("invoices.updateStatus", { id, status: "draft" }), /cannot go from "sent" to "draft"/);
});

it("refuses a money-blind member, and lists nothing to them", async () => {
  const f = await fixture("admin", false);
  assert.deepEqual(await f.query("invoices.list", {}), { invoices: [] });
  await assert.rejects(f.query("invoices.preview", range), /invoice-permission-required/);
});

it("keeps logo bytes off the wire and round-trips the stored record", () => {
  const value = { _id: "inv", workspaceId: "w", createdBy: "owner", number: "2026-001", clientId: "c", clientName: "N", status: "draft", issueDate: at("2026-11-08T00:00:00Z"), dueDate: at("2026-11-22T00:00:00Z"), from: null, to: null, groupBy: "project", lineItems: [], subtotal: 0, taxRate: null, taxAmount: 0, total: 0, currency: "EUR", entryIds: [], notes: null, issuer: { legalName: "Studio", logo: { mime: "image/png" } }, createdAt: at("2026-11-08T00:00:00Z"), updatedAt: at("2026-11-08T00:00:00Z") };
  const wire = privateInvoiceFromRecord(value);
  assert.equal(wire.id, "inv"); assert.equal((wire.issuer as { hasLogo?: boolean }).hasLogo, true); assert.equal("logo" in (wire.issuer as object), false);
  assert.deepEqual(privateInvoiceRecordValue(wire, { mime: "image/png" }).issuer, { legalName: "Studio", logo: { mime: "image/png" } });
});
