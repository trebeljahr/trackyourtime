// invoices.preview and invoices.create with per-line VAT, against a real
// database: what is stamped on the lines, the breakdown, the frozen parties,
// the document language and the payment terms — and that an invoice nothing
// chooses a category for is written exactly as before e-invoicing.
import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { TRPCError } from "@trpc/server";
import { DEFAULT_EXEMPTION_NOTES } from "@starter/shared";
import { Invoice } from "../models/Invoice.js";
import { TimeEntry } from "../models/TimeEntry.js";
import { invoicesRouter } from "../trpc/routers/invoices.js";
import {
  INTEGRATION_MODELS,
  OWNER,
  WORKSPACE,
  contextFor,
  insertLegacyInvoice,
  seedWorkspace,
} from "./support/einvoice-db-fixture.js";
import { CLIENT_BILLING_FIELDS } from "./support/einvoice-invoice.js";
import {
  clearTestDatabase,
  connectTestDatabase,
  dropTestDatabase,
  skipWithoutDatabase,
} from "./support/test-database.js";

const RANGE = { from: "2026-09-01", to: "2026-09-30", groupBy: "task" as const };
const DATES = { issueDate: "2026-09-30", dueDate: "2026-10-14" };

const owner = () => invoicesRouter.createCaller(contextFor(OWNER));

describe("invoice create with per-line VAT", { skip: skipWithoutDatabase }, () => {
  before(async () => {
    await connectTestDatabase("invoice-create-tax", INTEGRATION_MODELS as never);
  });
  afterEach(clearTestDatabase);
  after(dropTestDatabase);

  it("stamps each line's category, stores the breakdown and totals the EN 16931 way", async () => {
    const seeded = await seedWorkspace();
    const input = {
      clientId: seeded.clientId,
      ...RANGE,
      tax: { category: "S" as const, rate: 19 },
      lineTax: [{ key: seeded.taskKeys.review, category: "S" as const, rate: 7 }],
    };

    const preview = await owner().preview(input);
    const invoice = await owner().create({ ...input, ...DATES });

    const byKey = new Map(invoice.lineItems.map((line) => [line.key, line]));
    assert.deepEqual(
      [byKey.get(seeded.taskKeys.design)?.taxCategory, byKey.get(seeded.taskKeys.design)?.taxRate],
      ["S", 19],
    );
    assert.deepEqual(
      [byKey.get(seeded.taskKeys.review)?.taxCategory, byKey.get(seeded.taskKeys.review)?.taxRate],
      ["S", 7],
    );
    // 950.00 × 19 % = 180.50; 237.50 × 7 % = 16.625 → 16.63 (half away from zero).
    assert.deepEqual(
      invoice.taxBreakdown?.map((row) => [row.category, row.rate, row.basisAmount, row.taxAmount]),
      [
        ["S", 19, 950, 180.5],
        ["S", 7, 237.5, 16.63],
      ],
    );
    assert.equal(invoice.subtotal, 1187.5);
    assert.equal(invoice.taxAmount, 197.13);
    assert.equal(invoice.total, 1384.63);
    // Two rates: no single invoice-wide rate to state.
    assert.equal(invoice.taxRate, null);

    // The preview is the same dry run.
    assert.deepEqual(preview.taxBreakdown, invoice.taxBreakdown);
    assert.equal(preview.total, invoice.total);
    assert.deepEqual(
      preview.resolvedTax?.lines.map((line) => [line.key, line.category, line.rate]).sort(),
      [
        [seeded.taskKeys.design, "S", 19],
        [seeded.taskKeys.review, "S", 7],
      ].sort(),
    );
    assert.deepEqual(preview.exemptionNotes, {});
  });

  it("freezes the extended issuer and recipient, the language and the BT-20 sentence", async () => {
    const seeded = await seedWorkspace();
    const invoice = await owner().create({
      clientId: seeded.clientId,
      ...RANGE,
      ...DATES,
      tax: { category: "S", rate: 19 },
    });

    assert.equal(invoice.issuer?.vatId, "DE123456789");
    assert.equal(invoice.issuer?.iban, "DE02120300000000202051");
    assert.equal(invoice.issuer?.contactName, "Erika Mustermann");
    assert.equal(invoice.issuer?.electronicAddress, "invoices@example.com");
    assert.equal(invoice.recipient?.vatId, "DE987654321");
    assert.equal(invoice.recipient?.electronicAddressScheme, "0204");
    assert.equal(invoice.recipient?.reference, "991-12345-06");
    // No override, no client language, a "system" preference: English.
    assert.equal(invoice.locale, "en");
    assert.equal(invoice.paymentTerms, "Payable within 14 days, by 2026-10-14.");
    assert.equal(invoice.taxRate, 19);

    // Persisted as returned; the stored XML is not on any read.
    const stored = await Invoice.findById(invoice.id).lean();
    assert.equal(stored?.paymentTerms, invoice.paymentTerms);
    assert.equal(stored?.einvoice, undefined);
  });

  it("writes a small business's E lines with the § 19 note and no tax", async () => {
    const seeded = await seedWorkspace({
      profile: {
        legalName: "Example Einzelunternehmen",
        city: "Leipzig",
        smallBusiness: true,
        defaultTaxCategory: "E",
        defaultTaxRate: 0,
      },
      invoiceLocale: "de",
    });
    const invoice = await owner().create({ clientId: seeded.clientId, ...RANGE, ...DATES });

    assert.ok(invoice.lineItems.every((line) => line.taxCategory === "E" && line.taxRate === 0));
    assert.equal(invoice.taxAmount, 0);
    assert.equal(invoice.taxBreakdown?.length, 1);
    // The default § 19 text in the invoice's language; E carries no VATEX code.
    assert.equal(invoice.taxBreakdown?.[0]?.exemptionReason, DEFAULT_EXEMPTION_NOTES.de.E);
    assert.equal(invoice.taxBreakdown?.[0]?.exemptionReasonCode, null);
    // The client's language wins over the issuer's preference.
    assert.equal(invoice.locale, "de");
    // Dated the way the German PDF prints its due-date row.
    assert.equal(invoice.paymentTerms, "Zahlbar bis zum 14.10.2026.");
  });

  it("writes zero-rated Z lines with no exemption reason and a common rate of 0", async () => {
    const seeded = await seedWorkspace();
    const invoice = await owner().create({
      clientId: seeded.clientId,
      ...RANGE,
      ...DATES,
      tax: { category: "Z", rate: 0 },
    });
    assert.ok(invoice.lineItems.every((line) => line.taxCategory === "Z" && line.taxRate === 0));
    assert.deepEqual(
      invoice.taxBreakdown?.map((row) => [row.category, row.rate, row.taxAmount, row.exemptionReason, row.exemptionReasonCode]),
      [["Z", 0, 0, null, null]],
    );
    assert.equal(invoice.taxRate, 0);
    assert.equal(invoice.total, invoice.subtotal);
    assert.deepEqual((await owner().einvoiceCheck({ id: invoice.id, profile: "en16931" })).issues, []);
  });

  it("takes reverse charge from the client's default, with the default note, VATEX-EU-AE and the buyer's VAT ID", async () => {
    const seeded = await seedWorkspace({
      billing: { ...CLIENT_BILLING_FIELDS, country: "AT", vatId: "ATU12345678", defaultTaxCategory: "AE" },
    });
    const preview = await owner().preview({ clientId: seeded.clientId, ...RANGE });
    const invoice = await owner().create({ clientId: seeded.clientId, ...RANGE, ...DATES });

    assert.ok(invoice.lineItems.every((line) => line.taxCategory === "AE" && line.taxRate === 0));
    assert.equal(invoice.taxRate, 0);
    assert.equal(invoice.taxAmount, 0);
    assert.equal(invoice.taxBreakdown?.[0]?.exemptionReason, DEFAULT_EXEMPTION_NOTES.en.AE);
    assert.equal(invoice.taxBreakdown?.[0]?.exemptionReasonCode, "VATEX-EU-AE");
    assert.equal(preview.exemptionNotes.AE, DEFAULT_EXEMPTION_NOTES.en.AE);
    assert.equal(invoice.recipient?.vatId, "ATU12345678");
    const codes = (await owner().einvoiceCheck({ id: invoice.id, profile: "en16931" })).issues.map((i) => i.code);
    assert.equal(codes.includes("BUYER_VAT_ID_REQUIRED"), false);
  });

  it("stamps reverse charge without a buyer VAT ID, and the check names the missing VAT ID (BR-AE-02)", async () => {
    const seeded = await seedWorkspace({
      billing: { ...CLIENT_BILLING_FIELDS, country: "AT", vatId: null, defaultTaxCategory: "AE" },
    });
    const invoice = await owner().create({ clientId: seeded.clientId, ...RANGE, ...DATES });
    assert.ok(invoice.lineItems.every((line) => line.taxCategory === "AE"));
    const issue = (await owner().einvoiceCheck({ id: invoice.id, profile: "en16931" })).issues.find(
      (candidate) => candidate.code === "BUYER_VAT_ID_REQUIRED",
    );
    assert.equal(issue?.fixIn, "clientBilling");
    assert.equal(issue?.clientId, seeded.clientId);
  });

  it("writes not-subject O lines with the default note, and the check refuses O mixed with S", async () => {
    const seeded = await seedWorkspace({
      billing: { ...CLIENT_BILLING_FIELDS, country: "CH", vatId: null },
    });
    const invoice = await owner().create({
      clientId: seeded.clientId,
      ...RANGE,
      ...DATES,
      tax: { category: "O", rate: 0 },
    });
    assert.ok(invoice.lineItems.every((line) => line.taxCategory === "O" && line.taxRate === 0));
    assert.equal(invoice.taxRate, 0);
    assert.deepEqual(
      invoice.taxBreakdown?.map((row) => [row.category, row.exemptionReason, row.exemptionReasonCode]),
      [["O", DEFAULT_EXEMPTION_NOTES.en.O, "VATEX-EU-O"]],
    );
    assert.equal(
      (await owner().einvoiceCheck({ id: invoice.id, profile: "en16931" })).issues.some((i) => i.code === "CATEGORY_O_MIXED"),
      false,
    );

    // Create never refuses for an e-invoice reason; the check does (BR-O-11).
    await Invoice.deleteMany({ workspaceId: WORKSPACE });
    await TimeEntry.updateMany({ workspaceId: WORKSPACE }, { $set: { invoiceId: null } });
    const mixed = await owner().create({
      clientId: seeded.clientId,
      ...RANGE,
      ...DATES,
      tax: { category: "O", rate: 0 },
      lineTax: [{ key: seeded.taskKeys.review, category: "S", rate: 19 }],
    });
    assert.equal(mixed.taxRate, null);
    const codes = (await owner().einvoiceCheck({ id: mixed.id, profile: "en16931" })).issues.map((i) => i.code);
    assert.ok(codes.includes("CATEGORY_O_MIXED"), JSON.stringify(codes));
  });

  it("dates BT-20 from the stored due date, not the request's offset", async () => {
    const seeded = await seedWorkspace();
    const invoice = await owner().create({
      clientId: seeded.clientId,
      ...RANGE,
      issueDate: "2026-09-30",
      dueDate: "2026-10-13T23:30:00-02:00",
      tax: { category: "S", rate: 19 },
    });
    assert.equal(invoice.dueDate, "2026-10-14T01:30:00.000Z");
    // The due date is 14 calendar days after issue in UTC, so the terms stay.
    assert.equal(invoice.paymentTerms, "Payable within 14 days, by 2026-10-14.");
  });

  it("does not freeze a term its own due date contradicts", async () => {
    const seeded = await seedWorkspace();
    const invoice = await owner().create({
      clientId: seeded.clientId,
      ...RANGE,
      issueDate: "2026-09-30",
      dueDate: "2026-10-21",
      tax: { category: "S", rate: 19 },
    });
    assert.equal(invoice.paymentTerms, "Payable by 2026-10-21.");
  });

  it("an invoice nothing chooses a category for is written exactly as before", async () => {
    const seeded = await seedWorkspace({ profile: null, billing: null });
    const preview = await owner().preview({ clientId: seeded.clientId, ...RANGE, taxRate: null });
    const invoice = await owner().create({ clientId: seeded.clientId, ...RANGE, ...DATES, taxRate: null });

    assert.equal(preview.resolvedTax, null);
    assert.equal(preview.taxBreakdown, null);
    assert.ok(invoice.lineItems.every((line) => !("taxCategory" in line) && !("taxRate" in line)));
    assert.equal("taxBreakdown" in invoice, false);
    assert.equal(invoice.taxRate, null);
    assert.equal(invoice.taxAmount, 0);
    assert.equal(invoice.total, invoice.subtotal);
    assert.equal(invoice.issuer, null);
    assert.equal(invoice.recipient, null);
    // Create never refuses for an e-invoice reason: a plain PDF is always possible.
    const pdf = await owner().exportPdf({ id: invoice.id });
    assert.equal(pdf.mimeType, "application/pdf");
  });

  it("a 0 % rate without a category stays unresolved rather than guessing one", async () => {
    const seeded = await seedWorkspace({ profile: null, billing: null });
    const invoice = await owner().create({ clientId: seeded.clientId, ...RANGE, ...DATES, taxRate: 0 });
    assert.equal("taxBreakdown" in invoice, false);
    assert.equal(invoice.taxRate, 0);
    assert.equal(invoice.taxAmount, 0);
  });

  it("refuses a line key that matches no gathered line, and writes nothing", async () => {
    const seeded = await seedWorkspace();
    await assert.rejects(
      owner().create({
        clientId: seeded.clientId,
        ...RANGE,
        ...DATES,
        tax: { category: "S", rate: 19 },
        lineTax: [{ key: "no-such-line", category: "S", rate: 7 }],
      }),
      (error: unknown) =>
        error instanceof TRPCError && error.code === "BAD_REQUEST" && /no-such-line/.test(error.message),
    );
    assert.equal(await Invoice.countDocuments({ workspaceId: WORKSPACE }), 0);
    assert.equal(await TimeEntry.countDocuments({ workspaceId: WORKSPACE, invoiceId: { $ne: null } }), 0);
  });

  it("an invoice from before e-invoicing still reads and renders its plain PDF unchanged", async () => {
    const seeded = await seedWorkspace();
    const id = await insertLegacyInvoice(seeded);

    const invoice = await owner().get({ id });
    for (const key of ["taxBreakdown", "paymentTerms", "einvoiceFills", "locale"]) {
      assert.equal(key in invoice, false, `${key} appeared on a legacy invoice`);
    }
    assert.ok(invoice.lineItems.every((line) => !("taxCategory" in line)));
    assert.equal(invoice.taxAmount, 225.63);

    const pdf = await owner().exportPdf({ id });
    assert.equal(pdf.mimeType, "application/pdf");
    assert.ok(Buffer.from(pdf.base64, "base64").subarray(0, 5).toString("latin1").startsWith("%PDF"));
  });
});
