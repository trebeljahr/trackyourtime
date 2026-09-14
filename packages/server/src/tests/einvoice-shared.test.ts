// Shared e-invoice field rules (packages/shared has no test runner of its own).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import {
  COUNTRY_CODES,
  EINVOICE_ISSUE_CODES,
  EU_COUNTRY_CODES,
  UNFIXABLE_EINVOICE_ISSUE_CODES,
  attachEinvoiceDataSchema,
  bicInput,
  businessProfileProblems,
  clientBillingSchema,
  createClientSchema,
  createInvoiceSchema,
  exemptionNotesSchema,
  ibanInput,
  invoicePreviewSchema,
  isCountryCode,
  isValidElectronicAddress,
  isValidIban,
  lineTaxSchema,
  stripSpacesUpper,
  updateBusinessProfileSchema,
  vatIdInput,
  vatRateSchema,
} from "@starter/shared";

const TEST_IBAN = "DE02120300000000202051";

describe("identifier formats", () => {
  it("checks IBANs with mod 97", () => {
    assert.equal(isValidIban(TEST_IBAN), true);
    assert.equal(isValidIban("GB82WEST12345698765432"), true);
    assert.equal(isValidIban("DE02120300000000202052"), false);
    assert.equal(isValidIban("DE02 1203 0000 0000 2020 51"), false, "expects the compact form");
  });

  it("accepts a spaced, lower-case IBAN and stores it compact", () => {
    assert.equal(ibanInput.parse("de02 1203 0000 0000 2020 51"), TEST_IBAN);
    assert.equal(ibanInput.parse(""), null);
    assert.equal(ibanInput.parse("   "), null);
    assert.equal(ibanInput.parse(null), null);
    assert.equal(ibanInput.parse(undefined), undefined);
    assert.equal(ibanInput.safeParse("DE00120300000000202051").success, false);
  });

  it("checks VAT IDs by prefix and length", () => {
    assert.equal(vatIdInput.parse("de 123 456 789"), "DE123456789");
    assert.equal(vatIdInput.parse(""), null);
    assert.equal(vatIdInput.safeParse("123456789").success, false);
    assert.equal(vatIdInput.safeParse("DE1").success, false);
    assert.equal(vatIdInput.safeParse("DE1234567890123").success, false);
  });

  it("checks BICs of 8 or 11 characters", () => {
    assert.equal(bicInput.parse("byladem1001"), "BYLADEM1001");
    assert.equal(bicInput.parse("BYLADEM1"), "BYLADEM1");
    assert.equal(bicInput.safeParse("BYLADEM10").success, false);
  });

  it("strips all whitespace and upper-cases", () => {
    assert.equal(stripSpacesUpper(" de\t12 3\n"), "DE123");
  });

  it("checks electronic addresses per scheme", () => {
    assert.equal(isValidElectronicAddress("EM", "ap@buyer.example"), true);
    assert.equal(isValidElectronicAddress("EM", "not an email"), false);
    assert.equal(isValidElectronicAddress("0204", "991-12345-06"), true);
    assert.equal(isValidElectronicAddress("0204", "991 12345"), false);
    assert.equal(isValidElectronicAddress("9930", "DE123456789"), true);
    assert.equal(isValidElectronicAddress("9930", "123456789"), false);
    assert.equal(isValidElectronicAddress("0088", "4012345000009"), true);
    assert.equal(isValidElectronicAddress("0088", "401234500000"), false);
  });

  it("lists every ISO country once, and the EU inside it", () => {
    assert.equal(COUNTRY_CODES.length, 249);
    assert.equal(new Set(COUNTRY_CODES).size, 249);
    assert.equal(EU_COUNTRY_CODES.length, 27);
    assert.ok(EU_COUNTRY_CODES.every(isCountryCode));
    assert.equal(isCountryCode("DE"), true);
    assert.equal(isCountryCode("EL"), false);
    assert.equal(isCountryCode("de"), false);
  });
});

describe("tax inputs", () => {
  it("allows at most 2 decimals on a rate", () => {
    assert.equal(vatRateSchema.safeParse(7.5).success, true);
    assert.equal(vatRateSchema.safeParse(19.99).success, true);
    assert.equal(vatRateSchema.safeParse(7.125).success, false);
    assert.equal(vatRateSchema.safeParse(-1).success, false);
  });

  it("requires a positive rate for S and 0 for every other category", () => {
    assert.equal(lineTaxSchema.safeParse({ category: "S", rate: 19 }).success, true);
    assert.equal(lineTaxSchema.safeParse({ category: "S", rate: 0 }).success, false);
    for (const category of ["Z", "E", "AE", "O"]) {
      assert.equal(lineTaxSchema.safeParse({ category, rate: 0 }).success, true);
      assert.equal(lineTaxSchema.safeParse({ category, rate: 7 }).success, false);
    }
  });

  it("stores a blank exemption note as null", () => {
    assert.deepEqual(exemptionNotesSchema.parse({ E: "  ", AE: " Reverse charge " }), { E: null, AE: "Reverse charge" });
  });

  it("refuses a taxRate that disagrees with tax.rate, on preview and create", () => {
    const base = { clientId: "c1", from: "2026-09-01", to: "2026-10-01" };
    assert.equal(invoicePreviewSchema.safeParse({ ...base, tax: { category: "S", rate: 19 }, taxRate: 19 }).success, true);
    assert.equal(invoicePreviewSchema.safeParse({ ...base, tax: { category: "S", rate: 19 }, taxRate: 7 }).success, false);
    const create = { ...base, issueDate: "2026-10-01", dueDate: "2026-10-15" };
    assert.equal(createInvoiceSchema.safeParse({ ...create, tax: { category: "E", rate: 0 } }).success, true);
    assert.equal(createInvoiceSchema.safeParse({ ...create, tax: { category: "E", rate: 0 }, taxRate: 19 }).success, false);
    assert.equal(
      createInvoiceSchema.safeParse({ ...create, lineTax: [{ key: "p1", category: "AE", rate: 0 }] }).success,
      true,
    );
    assert.equal(createInvoiceSchema.safeParse(create).success, true, "an old client sending nothing new still validates");
  });

  it("attach requires an explicit confirmation and takes only a zero-rate category", () => {
    assert.equal(attachEinvoiceDataSchema.safeParse({ id: "i1", confirm: true }).success, true);
    assert.equal(attachEinvoiceDataSchema.safeParse({ id: "i1", confirm: false }).success, false);
    assert.equal(attachEinvoiceDataSchema.safeParse({ id: "i1", confirm: true, zeroRateCategory: "S" }).success, false);
    assert.equal(attachEinvoiceDataSchema.safeParse({ id: "i1", confirm: true, zeroRateCategory: "AE" }).success, true);
  });
});

describe("identity schemas", () => {
  it("pairs an electronic address with a matching scheme on client billing", () => {
    assert.equal(clientBillingSchema.safeParse({ electronicAddress: "ap@buyer.example", electronicAddressScheme: "EM" }).success, true);
    assert.equal(clientBillingSchema.safeParse({ electronicAddress: "ap@buyer.example", electronicAddressScheme: null }).success, false);
    const wrong = clientBillingSchema.safeParse({ electronicAddress: "ap@buyer.example", electronicAddressScheme: "0088" });
    assert.equal(wrong.success, false);
    assert.deepEqual(wrong.error?.issues[0]?.path, ["electronicAddress"]);
    // Only one half present: the merged row is checked on save instead.
    assert.equal(clientBillingSchema.safeParse({ electronicAddress: "ap@buyer.example" }).success, true);
  });

  it("accepts the new client billing keys and still validates a legacy payload", () => {
    const parsed = clientBillingSchema.parse({
      vatId: "at u12345678",
      preferredFormat: "xrechnung",
      defaultTaxCategory: "AE",
    });
    assert.equal(parsed.vatId, "ATU12345678");
    assert.equal(createClientSchema.safeParse({ name: "Example GmbH", billing: { city: "Berlin" } }).success, true);
    assert.equal(clientBillingSchema.safeParse({ preferredFormat: "docx" }).success, false);
  });

  it("applies the profile's cross-field rules to the fields sent together", () => {
    const ok = (input: Record<string, unknown>): boolean => updateBusinessProfileSchema.safeParse(input).success;
    assert.equal(ok({ defaultTaxCategory: "S", defaultTaxRate: 19 }), true);
    assert.equal(ok({ defaultTaxCategory: "S", defaultTaxRate: 0 }), false);
    assert.equal(ok({ defaultTaxCategory: "S", defaultTaxRate: null }), false);
    assert.equal(ok({ defaultTaxCategory: "AE", defaultTaxRate: 19 }), false);
    assert.equal(ok({ defaultTaxCategory: "AE", defaultTaxRate: null }), true);
    assert.equal(ok({ smallBusiness: true, defaultTaxCategory: "S", defaultTaxRate: 19 }), false);
    assert.equal(ok({ smallBusiness: true, defaultTaxCategory: "E", defaultTaxRate: 0 }), true);
    assert.equal(ok({ iban: "DE02 1203 0000 0000 2020 51", bic: "BYLADEM1001" }), true);
    assert.equal(ok({ iban: "DE02120300000000202052" }), false);
    // A partial update carrying one side only passes the schema.
    assert.equal(ok({ defaultTaxCategory: "S" }), true);
  });

  it("checks the merged profile strictly", () => {
    assert.deepEqual(
      businessProfileProblems({ defaultTaxCategory: "S", defaultTaxRate: null, smallBusiness: false }, false).map((p) => p.path),
      ["defaultTaxRate"],
    );
    assert.deepEqual(
      businessProfileProblems({ electronicAddress: "x@example.com", electronicAddressScheme: null }, false).map((p) => p.path),
      ["electronicAddressScheme"],
    );
    assert.deepEqual(businessProfileProblems({ defaultTaxCategory: "S" }, true), []);
  });

  it("emits a JSON schema for the REST inputs that carry the new fields", () => {
    for (const io of ["input", "output"] as const) {
      assert.doesNotThrow(() => z.toJSONSchema(createClientSchema, { target: "draft-2020-12", io }));
    }
  });
});

describe("issue codes", () => {
  it("are unique, and every unfixable one is a known code", () => {
    assert.equal(new Set(EINVOICE_ISSUE_CODES).size, EINVOICE_ISSUE_CODES.length);
    for (const code of UNFIXABLE_EINVOICE_ISSUE_CODES) {
      assert.ok((EINVOICE_ISSUE_CODES as readonly string[]).includes(code), code);
    }
    assert.ok(!(EINVOICE_ISSUE_CODES as readonly string[]).includes("BUYER_LEGAL_NAME_MISSING"));
  });
});
