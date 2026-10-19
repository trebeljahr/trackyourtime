// `overdueCandidateFilter` narrows the overdue invoice list in the database.
// It may keep invoices that are not overdue (`invoiceBalance` decides those),
// but it must never drop one that is. Checked over every combination of
// status, ledger, credit, due date and zone, evaluated by MongoDB itself.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import mongoose from "mongoose";
import { invoiceBalance } from "@starter/shared";
import { Invoice, toClientInvoice, type InvoiceDocLike } from "../models/Invoice.js";
import { overdueCandidateFilter } from "../services/invoice-follow-through.js";
import { connectTestDatabase, dropTestDatabase, skipWithoutDatabase } from "./support/test-database.js";

const WORKSPACE = "overdue-filter";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const payment = (amountMinor: number) => ({
  requestId: randomUUID(),
  kind: "payment",
  amountMinor,
  at: "2026-01-01T00:00:00.000Z",
  recordedAt: "2026-01-01T00:00:00.000Z",
  by: "someone",
  note: "",
});
// No `number`: credit numbers are unique per workspace, and only the
// credit's presence matters here.
const credit = {
  requestId: randomUUID(),
  originalNumber: "1",
  reason: "Synthetic",
  at: "2026-01-01T00:00:00.000Z",
  by: "someone",
  snapshot: {},
};

/** `undefined` leaves the field out of the stored document. */
const STATUSES = ["draft", "sent", "paid", "void", undefined];
const LEDGERS: Record<string, unknown>[] = [
  {},
  { followThrough: {} },
  { followThrough: { payments: [] } },
  { followThrough: { payments: null } },
  { followThrough: { payments: [payment(4_000)] } },
  { followThrough: { payments: [payment(10_000)] } },
  { followThrough: { legacySettledMinor: 10_000 } },
  { followThrough: { legacySettledMinor: 6_000 } },
  { followThrough: { legacySettledMinor: null } },
  { followThrough: { credit } },
  { followThrough: { credit: null, payments: [payment(4_000)] } },
];
const TIMEZONES = [undefined, "Pacific/Kiritimati", "Pacific/Pago_Pago", "America/Los_Angeles"];

describe("overdue invoice prefilter", { skip: skipWithoutDatabase }, () => {
  before(async () => connectTestDatabase("invoice-overdue-filter", [Invoice] as never));
  after(dropTestDatabase);

  // Fixed instants, passed to both the filter and `invoiceBalance`, so the
  // zones a day ahead of or behind UTC are on another date in some of them.
  for (const [run, iso] of ["2026-10-19T03:00:00Z", "2026-10-19T12:00:00Z", "2026-10-19T23:30:00Z"].entries()) {
    it(`keeps every overdue invoice and drops the ones that cannot be, at ${iso}`, async () => {
      const now = new Date(iso);
      const workspaceId = `${WORKSPACE}-${run}`;
      const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
      const dueDates = [
        ...[-30 * DAY, -DAY - HOUR, -HOUR, HOUR, 11 * HOUR, 23 * HOUR, 25 * HOUR, 30 * DAY].map((offset) => now.getTime() + offset),
        ...[-DAY, 0, DAY, 2 * DAY].map((offset) => midnight + offset),
      ];
      const docs: Record<string, unknown>[] = [];
      for (const status of STATUSES) {
        for (const ledger of LEDGERS) {
          for (const due of dueDates) {
            for (const timezone of TIMEZONES) {
              const at = new Date(due - 14 * DAY);
              docs.push({
                _id: new mongoose.Types.ObjectId(),
                workspaceId,
                createdBy: "someone",
                number: `O-${docs.length}`,
                clientId: "client",
                clientName: "Client",
                ...(status === undefined ? {} : { status }),
                ...(timezone === undefined ? {} : { timezone }),
                issueDate: at,
                dueDate: new Date(due),
                groupBy: "project",
                lineItems: [],
                subtotal: 100,
                taxRate: null,
                taxAmount: 0,
                total: 100,
                currency: "EUR",
                entryIds: [],
                notes: null,
                createdAt: at,
                updatedAt: at,
                ...structuredClone(ledger),
              });
            }
          }
        }
      }
      // A due date that is not a date: kept, never decided in the database.
      docs.push({ ...docs.find((doc) => doc.status === "sent")!, _id: new mongoose.Types.ObjectId(), number: "O-odd", dueDate: "2020-01-01" });
      await Invoice.collection.insertMany(docs);

      const candidates = new Set(
        (await Invoice.collection.find({ workspaceId, ...overdueCandidateFilter(now) }, { projection: { _id: 1 } }).toArray())
          .map((doc) => String(doc._id)),
      );
      const stored = await Invoice.collection.find({ workspaceId, dueDate: { $type: "date" } }).toArray();
      const overdue = stored.filter(
        (doc) => invoiceBalance(toClientInvoice(doc as unknown as InvoiceDocLike), now).overdueDays > 0,
      );

      assert.ok(overdue.length > 100, "the grid must hold overdue invoices");
      const missed = overdue.filter((doc) => !candidates.has(String(doc._id)));
      assert.deepEqual(missed.map((doc) => ({ status: doc.status, followThrough: doc.followThrough, dueDate: doc.dueDate, timezone: doc.timezone })), []);

      assert.ok(candidates.has(String(docs.at(-1)!._id)));
      const kept = (predicate: (doc: Record<string, unknown>) => boolean) =>
        stored.filter((doc) => predicate(doc)).filter((doc) => candidates.has(String(doc._id))).length;
      assert.equal(kept((doc) => doc.status === "draft"), 0);
      assert.equal(kept((doc) => doc.status === "paid" && (doc.followThrough === undefined || Object.keys(doc.followThrough as object).length === 0)), 0);
      assert.equal(kept((doc) => Boolean((doc.followThrough as { credit?: unknown } | undefined)?.credit)), 0);
      assert.equal(kept((doc) => (doc.dueDate as Date).getTime() >= now.getTime() + DAY), 0);
    });
  }
});
