// Every issue code, in each profile, with the field and the place to fix it.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EINVOICE_ISSUE_CODES,
  UNFIXABLE_EINVOICE_ISSUE_CODES,
  type EinvoiceFixLocation,
  type EinvoiceIssueCode,
  type EinvoiceProfile,
  type Invoice,
} from "@starter/shared";
import { EinvoiceNotReadyError } from "../services/einvoice/errors.js";
import {
  assertEinvoiceReady,
  isEinvoiceReady,
  totalsMismatchIssue,
  validateEinvoice,
} from "../services/einvoice/validate.js";
import { readyInvoice } from "./support/einvoice-invoice.js";

const codes = (invoice: Invoice, profile: EinvoiceProfile): EinvoiceIssueCode[] =>
  validateEinvoice(invoice, profile).map((issue) => issue.code);

type Case = {
  code: EinvoiceIssueCode;
  field: string;
  fixIn: EinvoiceFixLocation;
  /** Reported in en16931 too, or only in xrechnung. */
  xrechnungOnly: boolean;
  make: () => Invoice;
};

const withIssuer = (patch: Partial<NonNullable<Invoice["issuer"]>>, base: Invoice = readyInvoice()): Invoice => {
  if (!base.issuer) throw new Error("fixture has no issuer");
  return { ...base, issuer: { ...base.issuer, ...patch } };
};
const withRecipient = (patch: Partial<NonNullable<Invoice["recipient"]>>, base: Invoice = readyInvoice()): Invoice => {
  if (!base.recipient) throw new Error("fixture has no recipient");
  return { ...base, recipient: { ...base.recipient, ...patch } };
};

const CASES: Case[] = [
  { code: "NO_LINES", field: "invoice.lineItems", fixIn: "invoice", xrechnungOnly: false, make: () => ({ ...readyInvoice(), lineItems: [], subtotal: 0, taxAmount: 0, total: 0, taxBreakdown: [] }) },
  { code: "SELLER_SNAPSHOT_MISSING", field: "invoice.issuer", fixIn: "invoice", xrechnungOnly: false, make: () => ({ ...readyInvoice(), issuer: null }) },
  { code: "SELLER_LEGAL_NAME_MISSING", field: "businessProfile.legalName", fixIn: "businessProfile", xrechnungOnly: false, make: () => withIssuer({ legalName: null }) },
  { code: "SELLER_STREET_MISSING", field: "businessProfile.addressLines", fixIn: "businessProfile", xrechnungOnly: false, make: () => withIssuer({ addressLines: [] }) },
  { code: "SELLER_POSTCODE_MISSING", field: "businessProfile.postalCode", fixIn: "businessProfile", xrechnungOnly: false, make: () => withIssuer({ postalCode: null }) },
  { code: "SELLER_CITY_MISSING", field: "businessProfile.city", fixIn: "businessProfile", xrechnungOnly: false, make: () => withIssuer({ city: null }) },
  { code: "SELLER_COUNTRY_MISSING", field: "businessProfile.country", fixIn: "businessProfile", xrechnungOnly: false, make: () => withIssuer({ country: null }) },
  { code: "SELLER_COUNTRY_INVALID", field: "businessProfile.country", fixIn: "businessProfile", xrechnungOnly: false, make: () => withIssuer({ country: "XX" }) },
  { code: "SELLER_TAX_ID_UNCLASSIFIED", field: "businessProfile.vatId", fixIn: "businessProfile", xrechnungOnly: false, make: () => withIssuer({ vatId: null, taxNumber: null, taxId: "HRB12345" }) },
  { code: "SELLER_TAX_ID_MISSING", field: "businessProfile.vatId", fixIn: "businessProfile", xrechnungOnly: false, make: () => withIssuer({ vatId: null, taxNumber: null, taxId: null }) },
  { code: "SELLER_VAT_ID_REQUIRED", field: "businessProfile.vatId", fixIn: "businessProfile", xrechnungOnly: false, make: () => withIssuer({ vatId: null }, readyInvoice({ category: "AE", rate: 0 })) },
  { code: "SELLER_IDENTIFIER_REQUIRED", field: "businessProfile.registrationNumber", fixIn: "businessProfile", xrechnungOnly: false, make: () => withIssuer({ vatId: null, registrationNumber: null, sellerIdentifier: null }) },
  { code: "SELLER_CONTACT_NAME_MISSING", field: "businessProfile.contactName", fixIn: "businessProfile", xrechnungOnly: true, make: () => withIssuer({ contactName: null }) },
  { code: "SELLER_CONTACT_PHONE_MISSING", field: "businessProfile.phone", fixIn: "businessProfile", xrechnungOnly: true, make: () => withIssuer({ phone: null }) },
  { code: "SELLER_CONTACT_EMAIL_MISSING", field: "businessProfile.email", fixIn: "businessProfile", xrechnungOnly: true, make: () => withIssuer({ email: null }) },
  { code: "SELLER_ELECTRONIC_ADDRESS_MISSING", field: "businessProfile.electronicAddress", fixIn: "businessProfile", xrechnungOnly: true, make: () => withIssuer({ electronicAddress: null, electronicAddressScheme: null }) },
  { code: "SELLER_IBAN_MISSING", field: "businessProfile.iban", fixIn: "businessProfile", xrechnungOnly: true, make: () => withIssuer({ iban: null }) },
  { code: "BUYER_SNAPSHOT_MISSING", field: "invoice.recipient", fixIn: "invoice", xrechnungOnly: false, make: () => ({ ...readyInvoice(), recipient: null }) },
  { code: "BUYER_STREET_MISSING", field: "clientBilling.addressLines", fixIn: "clientBilling", xrechnungOnly: false, make: () => withRecipient({ addressLines: [] }) },
  { code: "BUYER_POSTCODE_MISSING", field: "clientBilling.postalCode", fixIn: "clientBilling", xrechnungOnly: false, make: () => withRecipient({ postalCode: null }) },
  { code: "BUYER_CITY_MISSING", field: "clientBilling.city", fixIn: "clientBilling", xrechnungOnly: false, make: () => withRecipient({ city: null }) },
  { code: "BUYER_COUNTRY_MISSING", field: "clientBilling.country", fixIn: "clientBilling", xrechnungOnly: false, make: () => withRecipient({ country: null }) },
  { code: "BUYER_COUNTRY_INVALID", field: "clientBilling.country", fixIn: "clientBilling", xrechnungOnly: false, make: () => withRecipient({ country: "ZZ" }) },
  { code: "BUYER_VAT_ID_REQUIRED", field: "clientBilling.vatId", fixIn: "clientBilling", xrechnungOnly: false, make: () => withRecipient({ vatId: null }, readyInvoice({ category: "AE", rate: 0 })) },
  { code: "BUYER_REFERENCE_MISSING", field: "clientBilling.reference", fixIn: "clientBilling", xrechnungOnly: true, make: () => withRecipient({ reference: null }) },
  { code: "BUYER_ELECTRONIC_ADDRESS_MISSING", field: "clientBilling.electronicAddress", fixIn: "clientBilling", xrechnungOnly: true, make: () => withRecipient({ electronicAddress: null, electronicAddressScheme: null }) },
  {
    code: "LINE_TAX_MISSING", field: "invoice.lineItems", fixIn: "invoice", xrechnungOnly: false,
    make: () => { const i = readyInvoice(); return { ...i, lineItems: i.lineItems.map(({ taxCategory: _c, taxRate: _r, ...line }) => line) }; },
  },
  {
    code: "LINE_TAX_RATE_INVALID", field: "invoice.lineItems[1].taxRate", fixIn: "invoice", xrechnungOnly: false,
    make: () => { const i = readyInvoice({ category: "E", rate: 0 }); return { ...i, lineItems: i.lineItems.map((l, n) => (n === 1 ? { ...l, taxRate: 7 } : l)) }; },
  },
  {
    code: "CATEGORY_O_MIXED", field: "invoice.lineItems", fixIn: "invoice", xrechnungOnly: false,
    make: () => { const i = readyInvoice({ category: "O", rate: 0 }); return { ...i, lineItems: i.lineItems.map((l, n) => (n === 1 ? { ...l, taxCategory: "Z" as const } : l)) }; },
  },
  {
    code: "EXEMPTION_NOTE_MISSING", field: "invoice.exemptionNotes.E", fixIn: "invoice", xrechnungOnly: false,
    // E without a small-business profile gets no default note.
    make: () => readyInvoice({ category: "E", rate: 0 }),
  },
  { code: "CURRENCY_INVALID", field: "invoice.currency", fixIn: "invoice", xrechnungOnly: false, make: () => { const i = readyInvoice(); return { ...i, currency: "eu", lineItems: i.lineItems.map((l) => ({ ...l, currency: "eu" })) }; } },
  { code: "LINE_CURRENCY_MISMATCH", field: "invoice.lineItems[0].currency", fixIn: "invoice", xrechnungOnly: false, make: () => { const i = readyInvoice(); return { ...i, lineItems: i.lineItems.map((l, n) => (n === 0 ? { ...l, currency: "CHF" } : l)) }; } },
  { code: "LINE_AMOUNT_INCONSISTENT", field: "invoice.lineItems[0].amount", fixIn: "invoice", xrechnungOnly: false, make: () => { const i = readyInvoice(); return { ...i, lineItems: i.lineItems.map((l, n) => (n === 0 ? { ...l, hourlyRate: 96 } : l)) }; } },
  { code: "BREAKDOWN_MISMATCH", field: "invoice.taxBreakdown", fixIn: "invoice", xrechnungOnly: false, make: () => { const { taxBreakdown: _b, ...i } = readyInvoice(); return i; } },
  { code: "TOTALS_MISMATCH", field: "invoice.total", fixIn: "invoice", xrechnungOnly: false, make: () => { const i = readyInvoice(); return { ...i, taxAmount: i.taxAmount + 0.01, total: i.total + 0.01 }; } },
];

describe("validateEinvoice", () => {
  it("finds nothing wrong with a complete invoice in either profile", () => {
    for (const profile of ["en16931", "xrechnung"] as const) {
      assert.deepEqual(validateEinvoice(readyInvoice(), profile), []);
      assert.deepEqual(validateEinvoice(readyInvoice({ category: "AE", rate: 0 }), profile), []);
      assert.equal(isEinvoiceReady(readyInvoice(), profile), true);
    }
  });

  it("covers every issue code", () => {
    assert.deepEqual([...new Set(CASES.map((c) => c.code))].sort(), [...EINVOICE_ISSUE_CODES].sort());
  });

  for (const testCase of CASES) {
    it(`${testCase.code}: ${testCase.field} in ${testCase.fixIn}${testCase.xrechnungOnly ? ", XRechnung only" : ""}`, () => {
      const invoice = testCase.make();
      for (const profile of ["en16931", "xrechnung"] as const) {
        const issue = validateEinvoice(invoice, profile).find((i) => i.code === testCase.code);
        if (testCase.xrechnungOnly && profile === "en16931") {
          assert.equal(issue, undefined, `${testCase.code} must not be reported for en16931`);
          continue;
        }
        assert.ok(issue, `${testCase.code} missing for ${profile}: ${codes(invoice, profile).join(", ")}`);
        assert.equal(issue.field, testCase.field);
        assert.equal(issue.fixIn, testCase.fixIn);
        assert.ok(issue.message.length > 20);
        assert.equal(typeof issue.rule, "string");
        if (issue.fixIn === "clientBilling") {
          assert.equal(issue.clientId, invoice.clientId);
          assert.ok(issue.message.includes("Clients → Example Kunde → Edit → Billing details"), issue.message);
        } else {
          assert.equal("clientId" in issue, false);
        }
        if (issue.fixIn === "businessProfile") {
          assert.ok(issue.message.includes("Settings → Billing → Business profile"), issue.message);
        }
        if (UNFIXABLE_EINVOICE_ISSUE_CODES.has(issue.code)) {
          assert.match(issue.message, /plain PDF/);
        }
      }
    });
  }

  it("reports only the snapshot issue for a missing party", () => {
    const invoice = { ...readyInvoice(), issuer: null, recipient: null };
    assert.deepEqual(codes(invoice, "xrechnung"), ["SELLER_SNAPSHOT_MISSING", "BUYER_SNAPSHOT_MISSING"]);
  });

  it("reports a legacy invoice deterministically, in table order", () => {
    const base = readyInvoice();
    const legacy: Invoice = {
      ...base,
      issuer: null,
      recipient: null,
      lineItems: base.lineItems.map(({ taxCategory: _c, taxRate: _r, ...line }) => line),
    };
    delete legacy.taxBreakdown;
    const first = codes(legacy, "en16931");
    assert.deepEqual(first, ["SELLER_SNAPSHOT_MISSING", "BUYER_SNAPSHOT_MISSING", "LINE_TAX_MISSING"]);
    assert.deepEqual(codes(legacy, "en16931"), first);
  });

  it("names a legacy tax ID in the unclassified message", () => {
    const [issue] = validateEinvoice(withIssuer({ vatId: null, taxNumber: null, taxId: "HRB12345" }), "en16931");
    assert.equal(issue?.code, "SELLER_TAX_ID_UNCLASSIFIED");
    assert.match(issue?.message ?? "", /HRB12345/);
  });

  it("accepts a tax number instead of a VAT ID, but then needs a registration number", () => {
    assert.deepEqual(codes(withIssuer({ vatId: null }), "en16931"), []);
    assert.deepEqual(codes(withIssuer({ vatId: null, registrationNumber: null }), "en16931"), ["SELLER_IDENTIFIER_REQUIRED"]);
  });

  it("needs another seller identifier on O lines, where no VAT ID is emitted (BR-O-02)", () => {
    const invoice = withIssuer({ registrationNumber: null, sellerIdentifier: null }, readyInvoice({ category: "O", rate: 0 }));
    assert.ok(codes(invoice, "en16931").includes("SELLER_IDENTIFIER_REQUIRED"));
  });

  it("reports one LINE_TAX_MISSING for a partly categorised invoice", () => {
    const base = readyInvoice();
    const invoice = { ...base, lineItems: base.lineItems.map((l, n) => (n === 0 ? { ...l, taxCategory: undefined, taxRate: undefined } : l)) };
    const issues = validateEinvoice(invoice, "en16931").filter((i) => i.code === "LINE_TAX_MISSING");
    assert.equal(issues.length, 1);
    assert.match(issues[0]?.message ?? "", /1 of 2 lines/);
  });

  it("puts both figure sets into TOTALS_MISMATCH", () => {
    const issue = totalsMismatchIssue(
      { stored: { subtotal: 1545, taxAmount: 293.56, total: 1838.56 }, recomputed: { subtotal: 1545, taxAmount: 293.55, total: 1838.55 } },
      "EUR",
    );
    assert.match(issue.message, /tax 293\.56 EUR, total 1838\.56 EUR/);
    assert.match(issue.message, /tax 293\.55 EUR, total 1838\.55 EUR/);
  });
});

describe("assertEinvoiceReady", () => {
  it("returns the invoice narrowed", () => {
    const ready = assertEinvoiceReady(readyInvoice(), "xrechnung");
    assert.equal(ready.issuer.legalName, "Example Softwareentwicklung GmbH");
    assert.equal(ready.lineItems[0]?.taxCategory, "S");
  });

  it("throws EinvoiceNotReadyError carrying every issue", () => {
    assert.throws(
      () => assertEinvoiceReady({ ...readyInvoice(), issuer: null }, "en16931"),
      (error: unknown) =>
        error instanceof EinvoiceNotReadyError && error.issues.length === 1 && error.issues[0]?.code === "SELLER_SNAPSHOT_MISSING",
    );
  });
});
