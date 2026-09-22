// invoices.update, blank invoices and manual lines against a real database:
// what an edit may change on a draft, what it refuses, that the totals are
// recomputed the way create computes them, and that the write is conditional
// on the `updatedAt` the caller read.
import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { TRPCError } from "@trpc/server";
import { INVOICE_UPDATE_REFUSALS, type Invoice as InvoiceWire } from "@starter/shared";
import { Invoice } from "../models/Invoice.js";
import { TimeEntry } from "../models/TimeEntry.js";
import { invoicesRouter } from "../trpc/routers/invoices.js";
import {
  INTEGRATION_MODELS,
  OWNER,
  contextFor,
  seedWorkspace,
  type Seeded,
} from "./support/einvoice-db-fixture.js";
import {
  clearTestDatabase,
  connectTestDatabase,
  dropTestDatabase,
  skipWithoutDatabase,
} from "./support/test-database.js";

const RANGE = { from: "2026-09-01", to: "2026-09-30", groupBy: "task" as const };
const DATES = { issueDate: "2026-09-30", dueDate: "2026-10-14" };
const S19 = { category: "S" as const, rate: 19 };

const owner = () => invoicesRouter.createCaller(contextFor(OWNER));

const rejectedWith = async (
  promise: Promise<unknown>,
  code: TRPCError["code"],
  message?: string | RegExp,
): Promise<void> => {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof TRPCError, `expected a TRPCError, got ${String(error)}`);
    assert.equal(error.code, code);
    if (typeof message === "string") assert.equal(error.message, message);
    if (message instanceof RegExp) assert.match(error.message, message);
    return true;
  });
};

/** A draft over the seeded September time, at 19 %. */
const createDraft = async (seeded: Seeded): Promise<InvoiceWire> =>
  owner().create({ clientId: seeded.clientId, ...RANGE, ...DATES, tax: S19 });

describe("blank invoices and manual lines", { skip: skipWithoutDatabase }, () => {
  before(async () => {
    await connectTestDatabase("invoice-update", INTEGRATION_MODELS as never);
  });
  afterEach(clearTestDatabase);
  after(dropTestDatabase);

  it("creates a blank invoice from manual lines alone: no range, no entries claimed", async () => {
    const seeded = await seedWorkspace();
    const input = {
      clientId: seeded.clientId,
      lines: [
        { label: "Workshop", quantity: 2, unit: "day" as const, unitPrice: 800 },
        { label: "Licence", quantity: 3, unit: "piece" as const, unitPrice: 49.99, tax: { category: "S" as const, rate: 7 } },
      ],
      tax: S19,
    };
    const preview = await owner().preview(input);
    const invoice = await owner().create({ ...input, ...DATES });

    assert.equal(invoice.from, null);
    assert.equal(invoice.to, null);
    assert.deepEqual(invoice.entryIds, []);
    assert.deepEqual(
      invoice.lineItems.map((line) => [line.kind, line.label, line.quantity, line.unit, line.unitPrice, line.amount, line.taxCategory, line.taxRate, line.seconds, line.hours]),
      [
        ["manual", "Workshop", 2, "day", 800, 1600, "S", 19, 0, 0],
        ["manual", "Licence", 3, "piece", 49.99, 149.97, "S", 7, 0, 0],
      ],
    );
    assert.ok(invoice.lineItems.every((line) => /^manual:[a-z0-9]{12}$/.test(line.key)));
    // 1600 × 19 % = 304.00; 149.97 × 7 % = 10.4979 → 10.50.
    assert.equal(invoice.subtotal, 1749.97);
    assert.equal(invoice.taxAmount, 314.5);
    assert.equal(invoice.total, 2064.47);
    assert.equal(invoice.currency, "EUR");
    // The seeded time is untouched.
    const entries = await TimeEntry.find({}).lean();
    assert.ok(entries.every((entry) => entry.invoiceId == null));

    assert.equal(preview.subtotal, invoice.subtotal);
    assert.equal(preview.total, invoice.total);
    assert.deepEqual(preview.entryIds, []);
    assert.equal(preview.skippedInvoiced, 0);
    // Stored as null, not merely absent, and read back the same.
    const stored = await Invoice.findById(invoice.id).lean();
    assert.equal(stored?.from, null);
    assert.equal(stored?.to, null);
  });

  it("refuses a blank invoice with no lines, and a ranged one with nothing on it", async () => {
    const seeded = await seedWorkspace();
    await rejectedWith(
      owner().create({ clientId: seeded.clientId, ...DATES }),
      "BAD_REQUEST",
      /at least one line/,
    );
    await rejectedWith(
      owner().create({ clientId: seeded.clientId, from: "2025-01-01", to: "2025-01-31", ...DATES }),
      "BAD_REQUEST",
      /no un-invoiced billable time/,
    );
  });

  it("appends manual lines after the time lines of a ranged invoice", async () => {
    const seeded = await seedWorkspace();
    const invoice = await owner().create({
      clientId: seeded.clientId,
      ...RANGE,
      ...DATES,
      tax: S19,
      lines: [{ key: "manual:travel", label: "Travel", quantity: 1, unit: "piece", unitPrice: 120 }],
    });
    assert.deepEqual(
      invoice.lineItems.map((line) => [line.kind ?? "legacy", line.key === "manual:travel"]),
      [
        ["legacy", false],
        ["legacy", false],
        ["manual", true],
      ],
    );
    assert.equal(invoice.subtotal, 1187.5 + 120);
    assert.equal(invoice.entryIds.length, 2);
    assert.notEqual(invoice.from, null);
  });
});

describe("invoices.update", { skip: skipWithoutDatabase }, () => {
  before(async () => {
    await connectTestDatabase("invoice-update-rules", INTEGRATION_MODELS as never);
  });
  afterEach(clearTestDatabase);
  after(dropTestDatabase);

  it("relabels a time line, adds a manual line and recomputes the totals", async () => {
    const seeded = await seedWorkspace();
    const draft = await createDraft(seeded);
    const [design, review] = draft.lineItems;
    assert.ok(design && review);

    const updated = await owner().update({
      id: draft.id,
      updatedAt: draft.updatedAt,
      notes: "Thank you.",
      lines: [
        { kind: "time", key: design.key, label: "Design phase" },
        { kind: "manual", key: "manual:travel", label: "Travel", quantity: 2, unit: "piece", unitPrice: 60 },
        { kind: "time", key: review.key },
      ],
    });

    assert.deepEqual(
      updated.lineItems.map((line) => [line.key, line.label, line.amount, line.taxCategory, line.taxRate]),
      [
        [design.key, "Design phase", 950, "S", 19],
        ["manual:travel", "Travel", 120, "S", 19],
        [review.key, review.label, 237.5, "S", 19],
      ],
    );
    // A relabelled time line keeps its figures.
    assert.equal(updated.lineItems[0]?.seconds, design.seconds);
    assert.equal(updated.lineItems[0]?.hourlyRate, design.hourlyRate);
    // Totals through the create path: 1307.50 × 19 % = 248.425 → 248.43.
    assert.equal(updated.subtotal, 1307.5);
    assert.equal(updated.taxAmount, 248.43);
    assert.equal(updated.total, 1555.93);
    assert.deepEqual(
      updated.taxBreakdown?.map((row) => [row.category, row.rate, row.basisAmount, row.taxAmount]),
      [["S", 19, 1307.5, 248.43]],
    );
    assert.equal(updated.notes, "Thank you.");
    assert.equal(updated.status, "draft");
    assert.notEqual(updated.updatedAt, draft.updatedAt);
    // The entries stay claimed by the draft.
    const claimed = await TimeEntry.countDocuments({ invoiceId: draft.id });
    assert.equal(claimed, 2);
  });

  it("answers CONFLICT on a stale updatedAt and writes nothing", async () => {
    const seeded = await seedWorkspace();
    const draft = await createDraft(seeded);
    const first = await owner().update({ id: draft.id, updatedAt: draft.updatedAt, notes: "first" });

    await rejectedWith(
      owner().update({ id: draft.id, updatedAt: draft.updatedAt, notes: "second" }),
      "CONFLICT",
      /changed in another window/,
    );
    const stored = await Invoice.findById(draft.id).lean();
    assert.equal(stored?.notes, "first");
    assert.equal(stored?.updatedAt.toISOString(), first.updatedAt);

    // The fresh value the first edit returned is the one to edit against.
    const second = await owner().update({ id: draft.id, updatedAt: first.updatedAt, notes: "second" });
    assert.equal(second.notes, "second");
  });

  it("refuses anything but a draft with a stable code", async () => {
    const seeded = await seedWorkspace();
    const draft = await createDraft(seeded);
    const sent = await owner().updateStatus({ id: draft.id, status: "sent" });
    await rejectedWith(
      owner().update({ id: draft.id, updatedAt: sent.updatedAt, notes: "x" }),
      "PRECONDITION_FAILED",
      INVOICE_UPDATE_REFUSALS.notDraft,
    );
    const stored = await Invoice.findById(draft.id).lean();
    assert.equal(stored?.notes, null);
  });

  it("refuses a draft an e-invoice XML was issued from", async () => {
    const seeded = await seedWorkspace();
    const draft = await createDraft(seeded);
    // As the export stores it: without touching `updatedAt`.
    await Invoice.updateOne(
      { _id: draft.id },
      { $set: { "einvoice.issuedXml.en16931": { xml: "<x/>", generatedAt: new Date(), generator: "test" } } },
      { timestamps: false },
    );
    await rejectedWith(
      owner().update({ id: draft.id, updatedAt: draft.updatedAt, notes: "x" }),
      "PRECONDITION_FAILED",
      INVOICE_UPDATE_REFUSALS.einvoiceIssued,
    );
  });

  it("lets a time line change its label only: no removing, no adding", async () => {
    const seeded = await seedWorkspace();
    const draft = await createDraft(seeded);
    const [design, review] = draft.lineItems;
    assert.ok(design && review);

    await rejectedWith(
      owner().update({
        id: draft.id,
        updatedAt: draft.updatedAt,
        lines: [{ kind: "time", key: design.key }],
      }),
      "BAD_REQUEST",
      /cannot be removed/,
    );
    await rejectedWith(
      owner().update({
        id: draft.id,
        updatedAt: draft.updatedAt,
        lines: [
          { kind: "time", key: design.key },
          { kind: "time", key: review.key },
          { kind: "time", key: "64b7f9c2e13a4d5f6a7b9eee" },
        ],
      }),
      "BAD_REQUEST",
      /not a time line/,
    );
    const stored = await Invoice.findById(draft.id).lean();
    assert.equal(stored?.lineItems.length, 2);
    assert.equal(stored?.updatedAt.toISOString(), draft.updatedAt);
  });

  it("re-freezes the payment terms when the due date moves, and refuses a used number", async () => {
    const seeded = await seedWorkspace();
    const draft = await createDraft(seeded);
    assert.equal(draft.paymentTerms, "Payable within 14 days, by 2026-10-14.");

    // A due date moved off the snapshot's terms cannot claim them any more.
    const moved = await owner().update({
      id: draft.id,
      updatedAt: draft.updatedAt,
      dueDate: "2026-10-31",
      number: "2026-0099",
    });
    assert.equal(moved.dueDate, "2026-10-31T00:00:00.000Z");
    assert.equal(moved.paymentTerms, "Payable by 2026-10-31.");
    assert.equal(moved.number, "2026-0099");

    // Both dates moved together, still 14 days apart: the terms are named again.
    const shifted = await owner().update({
      id: draft.id,
      updatedAt: moved.updatedAt,
      issueDate: "2026-10-01",
      dueDate: "2026-10-15",
    });
    assert.equal(shifted.paymentTerms, "Payable within 14 days, by 2026-10-15.");

    const other = await owner().create({
      clientId: seeded.clientId,
      lines: [{ label: "Fee", quantity: 1, unit: "piece", unitPrice: 10 }],
      ...DATES,
    });
    await rejectedWith(
      owner().update({ id: other.id, updatedAt: other.updatedAt, number: "2026-0099" }),
      "CONFLICT",
      /already used/,
    );
  });

  it("changes the VAT of the whole draft when the edit names one", async () => {
    const seeded = await seedWorkspace();
    const draft = await createDraft(seeded);
    const updated = await owner().update({
      id: draft.id,
      updatedAt: draft.updatedAt,
      tax: { category: "AE", rate: 0 },
      exemptionNotes: { AE: "Reverse charge." },
    });
    assert.ok(updated.lineItems.every((line) => line.taxCategory === "AE" && line.taxRate === 0));
    assert.equal(updated.taxAmount, 0);
    assert.equal(updated.total, 1187.5);
    assert.equal(updated.taxBreakdown?.[0]?.exemptionReason, "Reverse charge.");
  });

  it("publishes nothing to entries: a manual line claims no time", async () => {
    const seeded = await seedWorkspace();
    const blank = await owner().create({
      clientId: seeded.clientId,
      lines: [{ label: "Fee", quantity: 1, unit: "piece", unitPrice: 10 }],
      ...DATES,
    });
    const updated = await owner().update({
      id: blank.id,
      updatedAt: blank.updatedAt,
      lines: [
        { kind: "manual", label: "Fee", quantity: 2, unit: "piece", unitPrice: 10 },
        { kind: "manual", label: "Setup", quantity: 0.5, unit: "day", unitPrice: 1000 },
      ],
    });
    assert.deepEqual(updated.lineItems.map((line) => line.amount), [20, 500]);
    assert.equal(updated.subtotal, 520);
    assert.equal(updated.from, null);
    assert.equal(await TimeEntry.countDocuments({ invoiceId: { $ne: null } }), 0);
  });
});
