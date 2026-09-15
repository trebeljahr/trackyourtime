import { describe, expect, it } from "vitest";
import {
  EINVOICE_ISSUE_CODES,
  EMPTY_CLIENT_BILLING,
  emptyBusinessProfile,
  vatIdInput,
  type BusinessProfile,
  type EinvoiceIssue,
} from "@starter/shared";

import { de, en } from "@/i18n/messages";
import {
  FILL_FIELD_LABEL_KEYS,
  IDENTIFIER_INPUT_MAX,
  checkElectronicAddress,
  checkIdentifier,
  fillFieldLabelKey,
  fillPathTarget,
  fillSourceValue,
  formatIbanForDisplay,
  groupIssues,
  issueDisplayText,
  issueHref,
  issueLineNumber,
  lineTaxToTaxChoice,
  needsExemptionNote,
  parseDeepLink,
  suggestClientTaxCategory,
  taxChoiceToLineTax,
  type TaxChoice,
} from "./billing-fields";

const issue = (overrides: Partial<EinvoiceIssue>): EinvoiceIssue => ({
  code: "SELLER_POSTCODE_MISSING",
  field: "businessProfile.postalCode",
  message: "Postal code is missing.",
  fixIn: "businessProfile",
  rule: "BR-DE-4",
  ...overrides,
});

const profile = (overrides: Partial<BusinessProfile> = {}): BusinessProfile => ({
  ...emptyBusinessProfile("ws"),
  legalName: "Example GmbH",
  addressLines: ["Musterstraße 1"],
  postalCode: "10115",
  city: "Berlin",
  country: "DE",
  vatId: "DE123456789",
  email: "billing@example.com",
  ...overrides,
});

describe("checkIdentifier", () => {
  it("normalises a VAT ID and refuses one without a country prefix", () => {
    expect(checkIdentifier("vatId", "de 123 456 789")).toEqual({ ok: true, value: "DE123456789" });
    expect(checkIdentifier("vatId", "123456789")).toEqual({ ok: false, errorKey: "vatId" });
  });

  it("gives a formatted VAT ID room in its input and still parses it", () => {
    const formatted = "NL 8594 3567 5B01 . .";
    expect(formatted.length).toBeGreaterThan(20);
    expect(formatted.length).toBeLessThanOrEqual(IDENTIFIER_INPUT_MAX.vatId);
    // The input limit never exceeds what the shared schema accepts before compaction.
    const spaced = `DE${" 1".repeat(9)}`.padEnd(IDENTIFIER_INPUT_MAX.vatId, " ");
    expect(vatIdInput.safeParse(spaced)).toMatchObject({ success: true, data: "DE111111111" });
    expect(checkIdentifier("vatId", "NL 8594 3567 5B01")).toEqual({ ok: true, value: "NL859435675B01" });
  });

  it("tells a malformed IBAN from one with wrong check digits", () => {
    expect(checkIdentifier("iban", "DE02 1203 0000 0000 2020 51")).toEqual({
      ok: true,
      value: "DE02120300000000202051",
    });
    expect(checkIdentifier("iban", "DE03 1203 0000 0000 2020 51")).toEqual({
      ok: false,
      errorKey: "ibanChecksum",
    });
    expect(checkIdentifier("iban", "not an iban")).toEqual({ ok: false, errorKey: "iban" });
  });

  it("upper-cases a BIC, refuses a short one and reads blank as a clear", () => {
    expect(checkIdentifier("bic", "byladem1001")).toEqual({ ok: true, value: "BYLADEM1001" });
    expect(checkIdentifier("bic", "BYLA")).toEqual({ ok: false, errorKey: "bic" });
    expect(checkIdentifier("bic", "  ")).toEqual({ ok: true, value: null });
  });
});

describe("checkElectronicAddress", () => {
  it("checks the value against its scheme", () => {
    expect(checkElectronicAddress("EM", "billing@example.com")).toEqual({
      ok: true,
      value: "billing@example.com",
    });
    expect(checkElectronicAddress("EM", "not-an-email").ok).toBe(false);
    expect(checkElectronicAddress("0204", "991 12345 06")).toEqual({ ok: false, errorKey: "leitwegId" });
    expect(checkElectronicAddress("0204", "991-12345-06").ok).toBe(true);
    expect(checkElectronicAddress("0088", "")).toEqual({ ok: true, value: null });
  });
});

describe("display helpers", () => {
  it("groups an IBAN in fours", () => {
    expect(formatIbanForDisplay("DE02120300000000202051")).toBe("DE02 1203 0000 0000 2020 51");
    expect(formatIbanForDisplay(null)).toBe("");
  });
});

describe("tax choices", () => {
  it("round-trips every preset through LineTax", () => {
    const cases: Array<[TaxChoice, { category: string; rate: number } | null]> = [
      [{ kind: "S19" }, { category: "S", rate: 19 }],
      [{ kind: "S7" }, { category: "S", rate: 7 }],
      [{ kind: "Scustom", rate: "16" }, { category: "S", rate: 16 }],
      [{ kind: "Z" }, { category: "Z", rate: 0 }],
      [{ kind: "E" }, { category: "E", rate: 0 }],
      [{ kind: "AE" }, { category: "AE", rate: 0 }],
      [{ kind: "O" }, { category: "O", rate: 0 }],
      [{ kind: "unset" }, null],
    ];
    for (const [choice, tax] of cases) {
      expect(taxChoiceToLineTax(choice), choice.kind).toEqual({ ok: true, tax });
      expect(lineTaxToTaxChoice(tax as Parameters<typeof lineTaxToTaxChoice>[0]), choice.kind).toEqual(choice);
    }
  });

  it("refuses a custom rate that is not above 0 with at most 2 decimals", () => {
    for (const rate of ["0", "abc", "7.125", ""]) {
      expect(taxChoiceToLineTax({ kind: "Scustom", rate }), rate).toEqual({ ok: false, errorKey: "rate" });
    }
  });

  it("needs an exemption note for E, AE and O only", () => {
    expect(needsExemptionNote("E")).toBe(true);
    expect(needsExemptionNote("AE")).toBe(true);
    expect(needsExemptionNote("O")).toBe(true);
    expect(needsExemptionNote("S")).toBe(false);
    expect(needsExemptionNote("Z")).toBe(false);
  });

  it("suggests AE inside the EU with a VAT ID and O outside it", () => {
    expect(suggestClientTaxCategory("DE", "AT", true)).toBe("AE");
    expect(suggestClientTaxCategory("de", "at", true)).toBe("AE");
    expect(suggestClientTaxCategory("DE", "AT", false)).toBeNull();
    expect(suggestClientTaxCategory("DE", "US", false)).toBe("O");
    expect(suggestClientTaxCategory("DE", "DE", true)).toBeNull();
    expect(suggestClientTaxCategory("DE", "", true)).toBeNull();
  });
});

describe("issues and deep links", () => {
  it("links profile and client issues to the input that fixes them", () => {
    expect(issueHref(issue({}), { invoiceId: "inv1" })).toBe(
      "/app/settings?tab=billing&field=postalCode&from=invoice:inv1",
    );
    expect(
      issueHref(
        issue({
          code: "BUYER_REFERENCE_MISSING",
          fixIn: "clientBilling",
          field: "clientBilling.reference",
          clientId: "c1",
        }),
        { invoiceId: "inv1" },
      ),
    ).toBe("/app/clients?billing=c1&field=reference&from=invoice:inv1");
    expect(
      issueHref(issue({ code: "NO_LINES", fixIn: "invoice", field: "invoice.lineItems" }), {
        invoiceId: "inv1",
      }),
    ).toBeNull();
  });

  it("groups in a fixed order and keeps the server order inside a group", () => {
    const groups = groupIssues([
      issue({ code: "LINE_TAX_MISSING", fixIn: "invoice", field: "invoice.lineItems" }),
      issue({ code: "BUYER_CITY_MISSING", fixIn: "clientBilling", field: "clientBilling.city" }),
      issue({ code: "SELLER_CITY_MISSING", field: "businessProfile.city" }),
      issue({}),
    ]);
    expect(groups.map((group) => group.fixIn)).toEqual(["businessProfile", "clientBilling", "invoice"]);
    expect(groups[0]?.issues.map((entry) => entry.code)).toEqual([
      "SELLER_CITY_MISSING",
      "SELLER_POSTCODE_MISSING",
    ]);
  });

  it("parses a deep link strictly", () => {
    expect(parseDeepLink("?tab=billing&field=vatId&from=invoice:abc123")).toEqual({
      field: "vatId",
      billingClientId: null,
      fromInvoiceId: "abc123",
    });
    expect(parseDeepLink('?billing=c1&field="]%20x')).toEqual({
      field: null,
      billingClientId: "c1",
      fromInvoiceId: null,
    });
  });
});

describe("issueDisplayText", () => {
  const catalog = (code: EinvoiceIssue["code"]): string => `catalog:${code}`;
  const withLine = (line: number, text: string): string => `Line ${line}: ${text}`;

  it("keeps the server's sentence in English when it names a line or quotes a value", () => {
    const line = issue({
      code: "LINE_TAX_RATE_INVALID",
      fixIn: "invoice",
      field: "invoice.lineItems[2].taxRate",
      message: 'Line 3 ("Design") has category S at 0 %.',
    });
    expect(issueLineNumber(line)).toBe(3);
    expect(issueDisplayText(line, "en", catalog, withLine)).toBe(line.message);
    expect(issueDisplayText(line, "de", catalog, withLine)).toBe("Line 3: catalog:LINE_TAX_RATE_INVALID");

    const legacy = issue({
      code: "BUYER_VAT_ID_REQUIRED",
      fixIn: "clientBilling",
      field: "clientBilling.vatId",
      message: 'A reverse-charge invoice needs the VAT ID. The stored tax ID "ATU12345678" must be entered as the VAT ID.',
    });
    expect(issueDisplayText(legacy, "en", catalog, withLine)).toBe(legacy.message);
  });

  it("uses the catalog text when the server says nothing more, and the server text for an unknown code", () => {
    expect(issueDisplayText(issue({}), "en", catalog, withLine)).toBe("catalog:SELLER_POSTCODE_MISSING");
    const unknown = issue({ code: "SOMETHING_NEW" as EinvoiceIssue["code"], message: "A newer rule." });
    expect(issueDisplayText(unknown, "de", catalog, withLine)).toBe("A newer rule.");
  });
});

describe("fill helpers", () => {
  it("maps fill paths to label keys", () => {
    expect(fillFieldLabelKey("issuer")).toBe("issuer");
    expect(fillFieldLabelKey("recipient.postalCode")).toBe("recipientPostalCode");
    expect(fillFieldLabelKey("issuer.iban")).toBe("issuerIban");
    expect(fillFieldLabelKey("lineItems[*].taxCategory")).toBe("lineTax");
    expect(fillFieldLabelKey("taxBreakdown[1].exemptionReason")).toBe("exemptionReason");
    expect(fillFieldLabelKey("paymentTerms")).toBe("paymentTerms");
    expect(fillFieldLabelKey("issuer.unknownKey")).toBeNull();
  });

  it("points each copied path at the input it came from", () => {
    expect(fillPathTarget("issuer.vatId")).toEqual({
      source: "profile",
      fixIn: "businessProfile",
      field: "vatId",
    });
    expect(fillPathTarget("recipient")).toEqual({
      source: "client",
      fixIn: "clientBilling",
      field: "legalName",
    });
    expect(fillPathTarget("taxBreakdown")).toBeNull();
  });

  it("every label key has a text in both languages", () => {
    for (const key of FILL_FIELD_LABEL_KEYS) {
      expect(en.einvoice.fill.fieldLabels, key).toHaveProperty(key);
      expect(de.einvoice.fill.fieldLabels, key).toHaveProperty(key);
    }
  });

  it("shows the value a path will copy, electronic address defaulted from the email", () => {
    const billing = { ...EMPTY_CLIENT_BILLING, postalCode: "80331", email: "ap@kunde.example" };
    expect(fillSourceValue("recipient.postalCode", profile(), billing, "Kunde AG")).toEqual({
      source: "client",
      value: "80331",
    });
    expect(fillSourceValue("recipient.electronicAddress", profile(), billing, "Kunde AG")?.value).toBe(
      "ap@kunde.example",
    );
    expect(fillSourceValue("recipient.legalName", profile(), billing, "Kunde AG")?.value).toBe("Kunde AG");
    expect(fillSourceValue("issuer", profile(), billing, "Kunde AG")?.value).toBe(
      "Example GmbH\nMusterstraße 1\n10115 Berlin\nDE\nDE123456789",
    );
    expect(fillSourceValue("recipient.city", profile(), null, "Kunde AG")).toEqual({
      source: "client",
      value: null,
    });
    expect(fillSourceValue("paymentTerms", profile(), billing, "Kunde AG")).toBeNull();
  });
});

describe("catalog coverage", () => {
  it("has a text for every issue code in both languages", () => {
    for (const code of EINVOICE_ISSUE_CODES) {
      expect(en.einvoice.issues.codes, code).toHaveProperty(code);
      expect(de.einvoice.issues.codes, code).toHaveProperty(code);
    }
  });
});
