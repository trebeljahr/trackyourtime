// The e-invoice procedures against a real database: the check, the legacy
// fill, the structured refusal, the stored issued XML and the invoice gate.
//
// A real database because the rules under test ARE the database's behaviour:
// a fill guarded on `updatedAt`, an issued XML written by a conditional update
// that must match an absent field and nothing else, a projection that keeps
// the stored bytes off every read.
import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { TRPCError } from "@trpc/server";
import { getErrorShape } from "@trpc/server/unstable-core-do-not-import";
import type { EinvoiceIssue } from "@starter/shared";
import { saveBusinessProfile } from "../models/BusinessProfile.js";
import { Types } from "mongoose";
import { Invoice } from "../models/Invoice.js";
import { EINVOICE_GENERATOR } from "../services/einvoice/constants.js";
import { invoicesRouter } from "../trpc/routers/invoices.js";
import {
  ADMIN_NO_MONEY,
  INTEGRATION_MODELS,
  OWNER,
  WORKSPACE,
  contextFor,
  insertLegacyInvoice,
  seedWorkspace,
  type Seeded,
} from "./support/einvoice-db-fixture.js";
import { PROFILE_FIELDS } from "./support/einvoice-invoice.js";
import {
  clearTestDatabase,
  connectTestDatabase,
  dropTestDatabase,
  skipWithoutDatabase,
} from "./support/test-database.js";

const RANGE = { from: "2026-09-01", to: "2026-09-30", groupBy: "task" as const };
const DATES = { issueDate: "2026-09-30", dueDate: "2026-10-14" };

const owner = () => invoicesRouter.createCaller(contextFor(OWNER));
const adminWithoutMoney = () => invoicesRouter.createCaller(contextFor(ADMIN_NO_MONEY));

/** A new invoice at 19 %, marked sent. */
const sentInvoice = async (seeded: Seeded): Promise<string> => {
  const created = await owner().create({
    clientId: seeded.clientId,
    ...RANGE,
    ...DATES,
    tax: { category: "S", rate: 19 },
  });
  await owner().updateStatus({ id: created.id, status: "sent" });
  return created.id;
};

/** The TRPCError a call rejected with. */
const rejection = async (promise: Promise<unknown>): Promise<TRPCError> => {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof TRPCError, `expected a TRPCError, got ${String(error)}`);
    return error;
  }
  assert.fail("the call succeeded");
};

/** The error as a client receives it, through the router's errorFormatter. */
const shapeOf = (error: TRPCError) =>
  getErrorShape({
    config: invoicesRouter._def._config,
    error,
    type: "query",
    path: "invoices.exportXrechnung",
    input: undefined,
    ctx: undefined,
  }) as {
    data: { code: string; einvoiceIssues: EinvoiceIssue[] | null; einvoiceFillRefusal: string | null };
  };

const rawInvoice = (id: string) => Invoice.findById(id).lean();

describe("e-invoice procedures", { skip: skipWithoutDatabase }, () => {
  before(async () => {
    await connectTestDatabase("invoice-einvoice", INTEGRATION_MODELS as never);
  });
  afterEach(clearTestDatabase);
  after(dropTestDatabase);

  it("a new invoice with complete data is ready in both profiles and exports", async () => {
    const seeded = await seedWorkspace();
    const id = await sentInvoice(seeded);

    for (const profile of ["en16931", "xrechnung"] as const) {
      const check = await owner().einvoiceCheck({ id, profile });
      assert.deepEqual(check.issues, [], `${profile}: ${JSON.stringify(check.issues)}`);
      assert.equal(check.ready, true);
      assert.equal(check.fill, null);
      assert.equal(check.preferredFormat, "xrechnung");
      assert.equal(check.hasIssuedXml, false);
    }

    const xml = await owner().exportXrechnung({ id });
    assert.equal(xml.mimeType, "application/xml");
    assert.match(Buffer.from(xml.base64, "base64").toString("utf8"), /xrechnung_3\.0/);

    const pdf = await owner().exportZugferd({ id });
    assert.equal(pdf.mimeType, "application/pdf");
    assert.equal(Buffer.from(pdf.base64, "base64").subarray(0, 4).toString("latin1"), "%PDF");
  });

  it("a refusal names each missing field and where to fix it, in error.data.einvoiceIssues", async () => {
    // A profile without postcode, IBAN or contact name; a client without reference.
    const seeded = await seedWorkspace({
      profile: { legalName: "Example GmbH", addressLines: ["Musterstraße 1"], city: "Berlin", country: "DE", vatId: "DE123456789", email: "billing@example.com", phone: "+49 30 1234567" },
      billing: { legalName: "Example Kunde GmbH", addressLines: ["Beispielweg 7"], postalCode: "80331", city: "München", country: "DE", email: "ap@kunde.example" },
    });
    const id = await sentInvoice(seeded);

    const error = await rejection(owner().exportXrechnung({ id }));
    assert.equal(error.code, "PRECONDITION_FAILED");
    const shape = shapeOf(error);
    assert.equal(shape.data.code, "PRECONDITION_FAILED");
    const issues = shape.data.einvoiceIssues;
    assert.ok(issues);
    const byCode = new Map(issues.map((issue) => [issue.code, issue]));

    const postcode = byCode.get("SELLER_POSTCODE_MISSING");
    assert.equal(postcode?.field, "businessProfile.postalCode");
    assert.equal(postcode?.fixIn, "businessProfile");
    assert.ok(byCode.has("SELLER_IBAN_MISSING"));
    assert.ok(byCode.has("SELLER_CONTACT_NAME_MISSING"));
    const reference = byCode.get("BUYER_REFERENCE_MISSING");
    assert.equal(reference?.field, "clientBilling.reference");
    assert.equal(reference?.fixIn, "clientBilling");
    assert.equal(reference?.clientId, seeded.clientId);
    for (const issue of issues) {
      assert.equal(typeof issue.message, "string");
      assert.ok(issue.message.length > 0);
    }

    // Every other error carries a null, never a missing key.
    const other = await rejection(owner().get({ id: "64b7f9c2e13a4d5f6a7b9fff" }));
    assert.equal(shapeOf(other).data.einvoiceIssues, null);

    // Nothing was stored for a refused export.
    assert.equal((await rawInvoice(id))?.einvoice, undefined);
  });

  it("fills a legacy invoice from today's data without changing an amount", async () => {
    const seeded = await seedWorkspace();
    const id = await insertLegacyInvoice(seeded);
    const before = await rawInvoice(id);
    assert.ok(before);

    const check = await owner().einvoiceCheck({ id, profile: "en16931" });
    assert.equal(check.ready, false);
    assert.ok(check.issues.some((issue) => issue.code === "SELLER_SNAPSHOT_MISSING"));
    assert.equal(check.fill?.lineTax, "fixed");
    assert.deepEqual(check.fill?.fixedTax, { category: "S", rate: 19 });
    assert.equal(check.fill?.mismatch, null);
    assert.deepEqual(check.issuesAfterFill, []);
    for (const field of ["issuer", "recipient", "lineItems[*].taxCategory", "taxBreakdown", "paymentTerms"]) {
      assert.ok(check.fill?.fields.includes(field), `fill would not write ${field}`);
    }

    const filled = await owner().attachEinvoiceData({ id, confirm: true });

    // Amounts: identical, line by line and in total.
    assert.equal(filled.subtotal, before.subtotal);
    assert.equal(filled.taxAmount, before.taxAmount);
    assert.equal(filled.total, before.total);
    assert.equal(filled.taxRate, before.taxRate);
    assert.deepEqual(
      filled.lineItems.map((line) => [line.key, line.seconds, line.hours, line.hourlyRate, line.amount]),
      before.lineItems.map((line) => [line.key, line.seconds, line.hours, line.hourlyRate, line.amount]),
    );
    assert.ok(filled.lineItems.every((line) => line.taxCategory === "S" && line.taxRate === 19));
    assert.equal(filled.issuer?.vatId, "DE123456789");
    assert.equal(filled.recipient?.name, "Example Kunde");
    assert.deepEqual(filled.einvoiceFills?.[0]?.by, OWNER);
    assert.deepEqual(filled.einvoiceFills?.[0]?.fields, check.fill?.fields);

    assert.equal((await owner().einvoiceCheck({ id, profile: "en16931" })).ready, true);

    // A retried confirm writes nothing and logs no second fill.
    const again = await owner().attachEinvoiceData({ id, confirm: true });
    assert.equal(again.einvoiceFills?.length, 1);
    assert.equal(again.updatedAt, filled.updatedAt);
  });

  it("never replaces a stored value: a later profile change fills only what was null", async () => {
    const seeded = await seedWorkspace({
      profile: { legalName: "Example GmbH", addressLines: ["Altstraße 2"], city: "Berlin", country: "DE", vatId: "DE123456789", paymentTermsDays: 14 },
    });
    const id = await sentInvoice(seeded);
    assert.equal((await owner().get({ id })).issuer?.postalCode, null);

    await saveBusinessProfile("ws_einvoice_example", {
      addressLines: ["Neustraße 9"],
      postalCode: "10115",
      city: "Hamburg",
    });
    const check = await owner().einvoiceCheck({ id, profile: "en16931" });
    assert.deepEqual(check.fill?.fields, ["issuer.postalCode"]);

    const filled = await owner().attachEinvoiceData({ id, confirm: true });
    assert.equal(filled.issuer?.postalCode, "10115");
    assert.deepEqual(filled.issuer?.addressLines, ["Altstraße 2"]);
    assert.equal(filled.issuer?.city, "Berlin");
  });

  it("a fill writes only the leaves it lists: an issuer snapshot from before e-invoicing gains no new keys", async () => {
    const seeded = await seedWorkspace();
    const id = await insertLegacyInvoice(seeded);
    // Main's issuer snapshot, written past mongoose so no schema default can
    // add a key: no smallBusiness, no vatId, no bank fields, and no postcode.
    const mainIssuer = {
      legalName: "Example Softwareentwicklung GmbH",
      addressLines: ["Musterstraße 1"],
      postalCode: null,
      city: "Berlin",
      country: "DE",
      taxId: "30/123/45678",
      email: "billing@example.com",
      phone: null,
      website: null,
      paymentDetails: "IBAN DE02120300000000202051",
      paymentTermsDays: 14,
      invoiceFooter: null,
    };
    await Invoice.collection.updateOne({ _id: new Types.ObjectId(id) }, { $set: { issuer: mainIssuer } });

    const check = await owner().einvoiceCheck({ id, profile: "en16931" });
    const issuerFields = (check.fill?.fields ?? []).filter((field) => field.startsWith("issuer."));
    assert.ok(issuerFields.includes("issuer.postalCode"));
    await owner().attachEinvoiceData({ id, confirm: true });

    const stored = (await Invoice.collection.findOne({ _id: new Types.ObjectId(id) })) as {
      issuer: Record<string, unknown>;
    } | null;
    assert.ok(stored);
    assert.equal(Object.hasOwn(stored.issuer, "smallBusiness"), false);
    assert.equal(stored.issuer.postalCode, "10115");
    // Every key that changed is one the fill listed, and nothing listed is missing.
    const changed = Object.keys(stored.issuer).filter(
      (key) => JSON.stringify(stored.issuer[key]) !== JSON.stringify((mainIssuer as Record<string, unknown>)[key]),
    );
    const listed = new Set(issuerFields.map((field) => field.slice("issuer.".length)));
    for (const key of changed) {
      assert.ok(listed.has(key) || key === "electronicAddressScheme", `issuer.${key} was written but not listed`);
    }
    for (const key of listed) assert.ok(changed.includes(key), `issuer.${key} was listed but not written`);
    // A stored value stays, the legacy tax ID included.
    assert.equal(stored.issuer.taxId, "30/123/45678");
    assert.equal(stored.issuer.city, "Berlin");
  });

  it("a legacy invoice at 0 % needs the category chosen, then records it with its note", async () => {
    const seeded = await seedWorkspace();
    const id = await insertLegacyInvoice(seeded, { taxRate: null });

    const check = await owner().einvoiceCheck({ id, profile: "en16931" });
    assert.equal(check.fill?.lineTax, "choose");

    const refused = await rejection(owner().attachEinvoiceData({ id, confirm: true }));
    assert.equal(refused.code, "BAD_REQUEST");
    assert.equal((await rawInvoice(id))?.einvoice, undefined);

    const filled = await owner().attachEinvoiceData({
      id,
      confirm: true,
      zeroRateCategory: "AE",
    });
    assert.ok(filled.lineItems.every((line) => line.taxCategory === "AE" && line.taxRate === 0));
    assert.equal(filled.taxBreakdown?.[0]?.exemptionReasonCode, "VATEX-EU-AE");
    assert.equal(filled.taxAmount, 0);
    assert.equal(filled.total, 1187.5);
  });

  it("a fill that lost a race with another window answers CONFLICT and writes nothing", async () => {
    const seeded = await seedWorkspace();
    const id = await insertLegacyInvoice(seeded);

    // Another window edits the invoice between the fill's read and its write.
    const handle = Invoice as unknown as { findOneAndUpdate: (...args: unknown[]) => unknown };
    const original = handle.findOneAndUpdate;
    let raced = false;
    handle.findOneAndUpdate = function (this: unknown, ...args: unknown[]) {
      if (!raced) {
        raced = true;
        const later = new Date(Date.now() + 60_000);
        const bump = Invoice.updateOne({ _id: id }, { $set: { notes: "edited elsewhere", updatedAt: later } }, { timestamps: false });
        const query = original.apply(this, args) as { lean: () => Promise<unknown> };
        return { lean: async () => { await bump; return query.lean(); } };
      }
      return original.apply(this, args);
    };
    try {
      const error = await rejection(owner().attachEinvoiceData({ id, confirm: true }));
      assert.equal(error.code, "CONFLICT");
    } finally {
      handle.findOneAndUpdate = original;
    }
    const stored = await rawInvoice(id);
    assert.equal(stored?.notes, "edited elsewhere");
    assert.equal(stored?.einvoice, undefined);
    assert.equal(stored?.issuer, undefined);
    assert.ok(stored?.lineItems.every((line) => line.taxCategory === undefined));
  });

  it("a category choice on an invoice issued with tax is refused", async () => {
    const seeded = await seedWorkspace();
    const id = await insertLegacyInvoice(seeded);
    const refused = await rejection(
      owner().attachEinvoiceData({ id, confirm: true, zeroRateCategory: "E" }),
    );
    assert.equal(refused.code, "BAD_REQUEST");
    assert.equal((await rawInvoice(id))?.einvoice, undefined);
  });

  it("totals a cent off the EN 16931 result refuse the fill with TOTALS_MISMATCH and write nothing", async () => {
    const seeded = await seedWorkspace();
    // 1187.50 × 19 % = 225.625, which EN 16931 rounds to 225.63.
    const id = await insertLegacyInvoice(seeded, { taxAmount: 225.62, total: 1413.12 });
    const before = await rawInvoice(id);

    const check = await owner().einvoiceCheck({ id, profile: "en16931" });
    assert.deepEqual(check.fill?.mismatch?.recomputed, { subtotal: 1187.5, taxAmount: 225.63, total: 1413.13 });

    const error = await rejection(owner().attachEinvoiceData({ id, confirm: true }));
    assert.equal(error.code, "PRECONDITION_FAILED");
    assert.deepEqual(
      shapeOf(error).data.einvoiceIssues?.map((issue) => issue.code),
      ["TOTALS_MISMATCH"],
    );
    assert.deepEqual(await rawInvoice(id), before);
  });

  it("a sent invoice's XML is stored at the first export and served ever after", async () => {
    const seeded = await seedWorkspace();
    const id = await sentInvoice(seeded);
    const beforeExport = await rawInvoice(id);

    const first = await owner().exportXrechnung({ id });
    const stored = await rawInvoice(id);
    assert.equal(stored?.einvoice?.issuedXml?.xrechnung?.xml, Buffer.from(first.base64, "base64").toString("utf8"));
    assert.equal(stored?.einvoice?.issuedXml?.xrechnung?.generator, EINVOICE_GENERATOR);
    // Storing the issued file is not an edit.
    assert.equal(stored?.updatedAt.getTime(), beforeExport?.updatedAt.getTime());
    // The en16931 file is stored separately, on its own first export.
    assert.equal(stored?.einvoice?.issuedXml?.en16931, undefined);

    // Change what a fresh XML would say, and walk the status back: the stored bytes still win.
    await Invoice.updateOne({ _id: id }, { $set: { clientName: "Renamed Kunde", notes: "later" } });
    await owner().updateStatus({ id, status: "draft" });
    const later = await owner().exportXrechnung({ id });
    assert.equal(later.base64, first.base64);

    // No read carries it.
    const wire = await owner().get({ id });
    assert.equal(JSON.stringify(wire).includes("issuedXml"), false);
    const listed = await owner().list({});
    assert.equal(JSON.stringify(listed).includes("CrossIndustryInvoice"), false);
    assert.equal((await owner().einvoiceCheck({ id, profile: "xrechnung" })).hasIssuedXml, true);
  });

  it("an issued XML in either profile locks the fill: the PDF page cannot drift from the stored XML", async () => {
    // EN 16931 does not need an IBAN, XRechnung does: the ZUGFeRD export issues
    // an XML without bank details that XRechnung would then ask to fill.
    const seeded = await seedWorkspace({ profile: { ...PROFILE_FIELDS, iban: null, bic: null } });
    const id = await sentInvoice(seeded);
    await owner().exportZugferd({ id });
    await saveBusinessProfile(WORKSPACE, { iban: "DE02120300000000202051" });
    const before = await rawInvoice(id);

    const check = await owner().einvoiceCheck({ id, profile: "xrechnung" });
    assert.equal(check.hasIssuedXml, false);
    assert.equal(check.fillLocked, true);
    assert.equal(check.fill, null);
    assert.ok(check.issues.some((issue) => issue.code === "SELLER_IBAN_MISSING"));
    assert.deepEqual(check.issuesAfterFill, check.issues);

    const error = await rejection(owner().attachEinvoiceData({ id, confirm: true }));
    assert.equal(error.code, "BAD_REQUEST");
    assert.equal(
      shapeOf(error).data.einvoiceFillRefusal,
      "FILL_LOCKED_BY_ISSUED_XML",
    );
    assert.deepEqual(await rawInvoice(id), before);
  });

  it("a draft's XML is generated fresh and never stored", async () => {
    const seeded = await seedWorkspace();
    const created = await owner().create({
      clientId: seeded.clientId,
      ...RANGE,
      ...DATES,
      tax: { category: "S", rate: 19 },
    });
    await owner().exportXrechnung({ id: created.id });
    assert.equal((await rawInvoice(created.id))?.einvoice, undefined);
  });

  it("two exports racing on a sent invoice store one file and serve identical bytes", async () => {
    const seeded = await seedWorkspace();
    const id = await sentInvoice(seeded);
    const results = await Promise.all([
      owner().exportXrechnung({ id }),
      owner().exportXrechnung({ id }),
      owner().exportXrechnung({ id }),
    ]);
    const stored = (await rawInvoice(id))?.einvoice?.issuedXml?.xrechnung?.xml;
    for (const result of results) {
      assert.equal(Buffer.from(result.base64, "base64").toString("utf8"), stored);
    }
  });

  it("an admin without money visibility reads NOT_FOUND on every e-invoice procedure, and nothing is written", async () => {
    const seeded = await seedWorkspace();
    const id = await insertLegacyInvoice(seeded, { status: "sent" });
    const before = await rawInvoice(id);

    const calls: Array<[string, () => Promise<unknown>]> = [
      ["einvoiceCheck", () => adminWithoutMoney().einvoiceCheck({ id, profile: "xrechnung" })],
      ["attachEinvoiceData", () => adminWithoutMoney().attachEinvoiceData({ id, confirm: true })],
      ["exportZugferd", () => adminWithoutMoney().exportZugferd({ id })],
      ["exportXrechnung", () => adminWithoutMoney().exportXrechnung({ id })],
    ];
    for (const [name, call] of calls) {
      const error = await rejection(call());
      assert.equal(error.code, "NOT_FOUND", name);
      assert.equal(shapeOf(error).data.einvoiceIssues, null, name);
    }
    assert.deepEqual(await rawInvoice(id), before);
  });
});
