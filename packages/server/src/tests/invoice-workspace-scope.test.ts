// Invoice reads must be scoped by the WORKSPACE, never by the caller.
//
// `invoices.get` and `invoices.exportPdf` both filtered on
// `workspaceId: ctx.user.id` while every sibling resolver in the same router
// used `ctx.workspaceId`. Today those two values coincide — a personal
// workspace is the only kind there is — so the bug was invisible: the query
// matched, the invoice came back, and no test noticed. The moment a workspace
// id differs from the caller's user id, both resolvers answer NOT_FOUND for
// invoices that plainly exist.
//
// THE FIXTURE THEREFORE MAKES THEM DIFFER ON PURPOSE. `WORKSPACE` is not
// `ALICE`, and that inequality is the entire test: make them equal and every
// assertion below passes with the bug still in place. Anyone tempted to
// "simplify" the ids into one constant is deleting the test while keeping it
// green.
//
// The router is driven through its real caller — the resolvers are not
// exported, and it is the CALL SITE that was wrong, so a test of an extracted
// filter helper would prove nothing about which value gets passed to it. Both
// models are stubbed at the model handle rather than the module (an ESM
// namespace cannot be reassigned), the same trick api-token-visibility.test.ts
// uses, so this needs no database.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import mongoose from "mongoose";
import { Invoice, type InvoiceDocLike } from "../models/Invoice.js";
import {
  WorkspaceMember,
  type WorkspaceMemberDocLike,
} from "../models/WorkspaceMember.js";
import { invoicesRouter } from "../trpc/routers/invoices.js";
import type { Context } from "../trpc/context.js";

// No database in the unit suite. Buffering off makes any query these tests
// forgot to stub fail at once rather than park for the default ten seconds.
mongoose.set("bufferCommands", false);

/** The caller. */
const ALICE = "user_alice";

/**
 * The workspace the invoice lives in — DELIBERATELY not `ALICE`.
 *
 * This is the single line that gives the test its teeth.
 */
const WORKSPACE = "ws_acme";

assert.notEqual(
  WORKSPACE,
  ALICE,
  "the workspace id and the caller's user id must differ, or this file " +
    "passes with the scoping bug still present",
);

const INVOICE_ID = "64b7f9c2e13a4d5f6a7b8c9d";

const membership: WorkspaceMemberDocLike = {
  workspaceId: WORKSPACE,
  userId: ALICE,
  role: "owner",
  name: "Alice",
  hourlyRate: null,
  canViewOthersTime: true,
  canViewOthersMoney: true,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

/** One invoice, filed under the workspace — not under Alice. */
const invoiceDoc: InvoiceDocLike = {
  _id: INVOICE_ID,
  workspaceId: WORKSPACE,
  createdBy: ALICE,
  number: "2026-001",
  clientId: "64b7f9c2e13a4d5f6a7b8c90",
  clientName: "Acme GmbH",
  status: "draft",
  issueDate: new Date("2026-09-01T00:00:00.000Z"),
  dueDate: new Date("2026-09-15T00:00:00.000Z"),
  from: new Date("2026-08-01T00:00:00.000Z"),
  to: new Date("2026-08-31T00:00:00.000Z"),
  groupBy: "project",
  lineItems: [
    {
      key: "p1",
      label: "Website",
      projectId: "64b7f9c2e13a4d5f6a7b8c92",
      taskId: null,
      seconds: 3600,
      hours: 1,
      hourlyRate: 100,
      currency: "EUR",
      amount: 100,
    },
  ],
  subtotal: 100,
  taxRate: null,
  taxAmount: 0,
  total: 100,
  currency: "EUR",
  entryIds: ["64b7f9c2e13a4d5f6a7b8c91"],
  notes: null,
  createdAt: new Date("2026-09-01T00:00:00.000Z"),
  updatedAt: new Date("2026-09-01T00:00:00.000Z"),
};

/** Every filter these two resolvers build is a flat equality match. */
const matchesFilter = (
  doc: InvoiceDocLike,
  filter: Record<string, unknown>,
): boolean => {
  const fields: Record<string, unknown> = { ...doc, _id: String(doc._id) };
  return Object.entries(filter).every(([key, value]) => fields[key] === value);
};

type LeanQuery<T> = { lean: () => Promise<T>; select: (projection: string) => LeanQuery<T> };

// mongoose's `findOne` is overloaded a dozen ways and not one of those
// overloads describes a stub, so each model is reached through `unknown`.
// Nothing about the production types is relaxed — this is only the handle the
// test holds them by.
const stubbableInvoice = Invoice as unknown as {
  findOne: (
    filter: Record<string, unknown>,
  ) => LeanQuery<InvoiceDocLike | null>;
};
const realInvoiceFindOne = stubbableInvoice.findOne;

const stubbableMember = WorkspaceMember as unknown as {
  findOne: (
    filter: Record<string, unknown>,
  ) => LeanQuery<WorkspaceMemberDocLike | null>;
};
const realMemberFindOne = stubbableMember.findOne;

/** The filters the router actually queried invoices with, newest last. */
let queried: Record<string, unknown>[] = [];

/** A lean query whose projection is ignored: nothing here reads a projected-out field. */
const leanQuery = <T>(run: () => Promise<T>): LeanQuery<T> => {
  const query: LeanQuery<T> = { lean: run, select: () => query };
  return query;
};

stubbableInvoice.findOne = (filter) =>
  leanQuery(async () => {
    queried.push(filter);
    return matchesFilter(invoiceDoc, filter) ? invoiceDoc : null;
  });

stubbableMember.findOne = (filter) =>
  leanQuery(async () =>
    filter.workspaceId === WORKSPACE && filter.userId === ALICE
      ? membership
      : null,
  );

after(() => {
  stubbableInvoice.findOne = realInvoiceFindOne;
  stubbableMember.findOne = realMemberFindOne;
});

/**
 * A signed-in Alice whose active workspace is `WORKSPACE`.
 *
 * `req`/`res` are express handles the invoice reads never touch, so the
 * context is built structurally rather than by standing up a request.
 */
const caller = invoicesRouter.createCaller({
  req: undefined,
  res: undefined,
  session: { session: { activeOrganizationId: WORKSPACE }, user: { id: ALICE } },
  user: { id: ALICE },
  authMethod: "cookie",
  activeWorkspaceId: WORKSPACE,
} as unknown as Context);

/** The filter of the most recent invoice lookup. */
const lastFilter = (): Record<string, unknown> => {
  const filter = queried[queried.length - 1];
  assert.ok(filter, "the resolver never queried for an invoice");
  return filter;
};

describe("invoices are scoped by workspace, not by the caller's user id", () => {
  it("get reads the invoice out of the caller's WORKSPACE", async () => {
    queried = [];
    const invoice = await caller.get({ id: INVOICE_ID });

    assert.equal(invoice.id, INVOICE_ID);
    assert.equal(
      lastFilter().workspaceId,
      WORKSPACE,
      "get scoped its query by something other than the workspace",
    );
    assert.notEqual(
      lastFilter().workspaceId,
      ALICE,
      "get scoped its query by the caller's user id",
    );
  });

  it("exportPdf reads the invoice out of the caller's WORKSPACE", async () => {
    queried = [];
    const pdf = await caller.exportPdf({ id: INVOICE_ID });

    assert.equal(pdf.mimeType, "application/pdf");
    assert.ok(pdf.base64.length > 0);
    assert.equal(
      lastFilter().workspaceId,
      WORKSPACE,
      "exportPdf scoped its query by something other than the workspace",
    );
    assert.notEqual(
      lastFilter().workspaceId,
      ALICE,
      "exportPdf scoped its query by the caller's user id",
    );
  });
});
