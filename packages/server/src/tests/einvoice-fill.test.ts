// The fill never overwrites a stored value, and refuses on a single cent.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_EXEMPTION_NOTES, type Invoice } from "@starter/shared";
import {
  applyFillPlan,
  fillNullLeaves,
  planEinvoiceFill,
  previewIssuesAfterFill,
  type FillSources,
} from "../services/einvoice/fill.js";
import { validateEinvoice } from "../services/einvoice/validate.js";
import {
  clientBilling,
  legacyInvoice,
  profileValues,
  readyInvoice,
} from "./support/einvoice-invoice.js";

const sources = (overrides: Partial<FillSources> = {}): FillSources => ({
  profile: profileValues(),
  client: { billing: clientBilling() },
  ...overrides,
});

const issueCodes = (issues: ReadonlyArray<{ code: string }>): string[] => issues.map((i) => i.code);

describe("legacy invoice at a positive rate", () => {
  it("fills both parties, S lines, the breakdown and BT-20, and the result is ready", () => {
    const invoice = legacyInvoice(19);
    const plan = planEinvoiceFill(invoice, sources(), {});
    assert.equal(plan.lineTax, "fixed");
    assert.deepEqual(plan.fixedTax, { category: "S", rate: 19 });
    assert.equal(plan.needsChoice, false);
    assert.equal(plan.mismatch, null);
    assert.deepEqual(plan.fields, ["issuer", "recipient", "lineItems[*].taxCategory", "taxBreakdown", "paymentTerms"]);

    const filled = applyFillPlan(invoice, plan);
    assert.equal(filled.subtotal, invoice.subtotal, "frozen amounts never move");
    assert.equal(filled.taxAmount, invoice.taxAmount);
    assert.equal(filled.total, invoice.total);
    assert.equal(filled.taxRate, 19);
    assert.deepEqual(filled.taxBreakdown?.map((r) => [r.category, r.rate, r.basisAmount, r.taxAmount]), [["S", 19, 1545, 293.55]]);
    assert.deepEqual(validateEinvoice(filled, "en16931"), []);
    assert.deepEqual(validateEinvoice(filled, "xrechnung"), []);
    assert.deepEqual(previewIssuesAfterFill(invoice, plan, "xrechnung"), []);
  });

  it("takes the snapshot from today's data but not today's payment terms days", () => {
    const plan = planEinvoiceFill(legacyInvoice(19), sources(), {});
    assert.equal(plan.set.issuer?.legalName, "Example Softwareentwicklung GmbH");
    assert.equal(plan.set.issuer?.paymentTermsDays, null);
    // The terms sentence reads frozen data: no issuer at issue time, so no days.
    assert.equal(plan.set.paymentTerms, "Payable by 2026-09-28.");
    // The client's recipient snapshot keeps the FROZEN client name.
    assert.equal(plan.set.recipient?.name, "Example Kunde");
  });

  it("refuses on one cent: the mismatch carries both figure sets", () => {
    const invoice = { ...legacyInvoice(19), taxAmount: 293.56, total: 1838.56 };
    const plan = planEinvoiceFill(invoice, sources(), {});
    assert.deepEqual(plan.mismatch, {
      stored: { subtotal: 1545, taxAmount: 293.56, total: 1838.56 },
      recomputed: { subtotal: 1545, taxAmount: 293.55, total: 1838.55 },
    });
    assert.ok(issueCodes(previewIssuesAfterFill(invoice, plan, "en16931")).includes("TOTALS_MISMATCH"));
  });

  it("offers nothing for a rate that EN 16931 cannot express", () => {
    const plan = planEinvoiceFill({ ...legacyInvoice(19), taxRate: 7.125 }, sources(), {});
    assert.equal(plan.lineTax, "inconsistent");
    assert.equal(plan.set.lineItems, undefined);
  });
});

describe("legacy invoice at 0 % or without tax", () => {
  it("asks for the category and fills nothing on the lines until given", () => {
    const invoice = legacyInvoice(null);
    const plan = planEinvoiceFill(invoice, sources(), {});
    assert.equal(plan.lineTax, "choose");
    assert.equal(plan.needsChoice, true);
    assert.equal(plan.set.lineItems, undefined);
    assert.equal(plan.set.taxBreakdown, undefined);
    assert.equal(issueCodes(previewIssuesAfterFill(invoice, plan, "en16931")).includes("LINE_TAX_MISSING"), false);
  });

  it("fills E with the small-business note in the invoice's language", () => {
    const invoice: Invoice = { ...legacyInvoice(null), locale: "de" };
    const plan = planEinvoiceFill(invoice, sources({ profile: profileValues({ smallBusiness: true, defaultTaxCategory: "E", defaultTaxRate: 0 }) }), { zeroRateCategory: "E" });
    assert.equal(plan.needsChoice, false);
    assert.equal(plan.mismatch, null);
    assert.deepEqual(plan.set.lineItems?.map((l) => [l.taxCategory, l.taxRate]), [["E", 0], ["E", 0]]);
    assert.equal(plan.set.taxBreakdown?.[0]?.exemptionReason, DEFAULT_EXEMPTION_NOTES.de.E);
    assert.equal(plan.set.paymentTerms, "Zahlbar bis zum 28.09.2026.");
    assert.deepEqual(previewIssuesAfterFill(invoice, plan, "en16931"), []);
  });

  it("leaves the E note to the user when the business is not small, and takes a typed one", () => {
    const invoice = legacyInvoice(null);
    const without = planEinvoiceFill(invoice, sources(), { zeroRateCategory: "E" });
    assert.ok(issueCodes(previewIssuesAfterFill(invoice, without, "en16931")).includes("EXEMPTION_NOTE_MISSING"));
    const typed = planEinvoiceFill(invoice, sources(), { zeroRateCategory: "E", exemptionNotes: { E: "§ 4 Nr. 21 UStG" } });
    assert.equal(typed.set.taxBreakdown?.[0]?.exemptionReason, "§ 4 Nr. 21 UStG");
  });

  it("gives AE its default note and needs both VAT IDs", () => {
    const invoice = legacyInvoice(0);
    const plan = planEinvoiceFill(invoice, sources({ client: { billing: clientBilling({ vatId: null }) } }), { zeroRateCategory: "AE" });
    assert.equal(plan.set.taxBreakdown?.[0]?.exemptionReason, DEFAULT_EXEMPTION_NOTES.en.AE);
    assert.deepEqual(issueCodes(previewIssuesAfterFill(invoice, plan, "en16931")), ["BUYER_VAT_ID_REQUIRED"]);
  });

  it("fills Z with no exemption note at all (BR-Z-10), and writes every line's category as two leaves", () => {
    const invoice = legacyInvoice(0);
    const plan = planEinvoiceFill(invoice, sources(), { zeroRateCategory: "Z", exemptionNotes: { E: "ignored" } });
    assert.deepEqual(plan.set.lineItems?.map((l) => [l.taxCategory, l.taxRate]), [["Z", 0], ["Z", 0]]);
    assert.deepEqual(
      plan.set.taxBreakdown?.map((r) => [r.category, r.taxAmount, r.exemptionReason, r.exemptionReasonCode]),
      [["Z", 0, null, null]],
    );
    assert.equal(plan.writes["lineItems.$[].taxCategory"], "Z");
    assert.equal(plan.writes["lineItems.$[].taxRate"], 0);
    assert.equal("lineItems" in plan.writes, false);
    assert.equal(plan.mismatch, null);
    assert.deepEqual(previewIssuesAfterFill(invoice, plan, "en16931"), []);
  });

  it("fills O with its default note in the invoice's language and no VAT IDs needed", () => {
    const invoice: Invoice = { ...legacyInvoice(null), locale: "de" };
    const plan = planEinvoiceFill(invoice, sources({ client: { billing: clientBilling({ country: "CH", vatId: null }) } }), { zeroRateCategory: "O" });
    assert.deepEqual(plan.set.lineItems?.map((l) => [l.taxCategory, l.taxRate]), [["O", 0], ["O", 0]]);
    assert.deepEqual(
      plan.set.taxBreakdown?.map((r) => [r.category, r.exemptionReason, r.exemptionReasonCode]),
      [["O", DEFAULT_EXEMPTION_NOTES.de.O, "VATEX-EU-O"]],
    );
    assert.deepEqual(previewIssuesAfterFill(invoice, plan, "en16931"), []);
  });
});

describe("partial snapshots", () => {
  it("fills null leaves only and never touches a stored value", () => {
    const base = readyInvoice();
    if (!base.issuer || !base.recipient) throw new Error("fixture");
    const invoice: Invoice = {
      ...base,
      issuer: { ...base.issuer, postalCode: null, city: "Potsdam", iban: null },
      recipient: { ...base.recipient, addressLines: [], reference: "PO-1" },
    };
    const plan = planEinvoiceFill(
      invoice,
      sources({
        profile: profileValues({ postalCode: "14467", city: "Berlin" }),
        client: { billing: clientBilling({ addressLines: ["Neuer Weg 9", "Hinterhaus"], reference: "PO-2" }) },
      }),
      {},
    );
    // BT-20 was frozen at create, so it is not among them.
    assert.deepEqual(plan.fields, ["issuer.postalCode", "issuer.iban", "recipient.addressLines"]);
    assert.equal(plan.set.issuer?.postalCode, "14467");
    assert.equal(plan.set.issuer?.city, "Potsdam", "a stored city is never replaced");
    assert.equal(plan.set.issuer?.iban, "DE02120300000000202051");
    assert.deepEqual(plan.set.recipient?.addressLines, ["Neuer Weg 9", "Hinterhaus"]);
    assert.equal(plan.set.recipient?.reference, "PO-1");
    assert.equal(plan.set.lineItems, undefined);
    assert.equal(plan.lineTax, "none");
  });

  it("fills a VAT ID next to a legacy tax ID, which clears SELLER_TAX_ID_UNCLASSIFIED", () => {
    const base = readyInvoice();
    if (!base.issuer) throw new Error("fixture");
    const invoice: Invoice = { ...base, issuer: { ...base.issuer, vatId: null, taxNumber: null, taxId: "DE123456789" } };
    assert.deepEqual(issueCodes(validateEinvoice(invoice, "en16931")), ["SELLER_TAX_ID_UNCLASSIFIED"]);
    const plan = planEinvoiceFill(invoice, sources(), {});
    assert.deepEqual(plan.fields, ["issuer.vatId", "issuer.taxNumber"]);
    assert.equal(plan.set.issuer?.taxId, "DE123456789");
    assert.deepEqual(previewIssuesAfterFill(invoice, plan, "en16931"), []);
  });

  it("fills the electronic address with its scheme as one leaf, and never a boolean", () => {
    const base = readyInvoice();
    if (!base.issuer) throw new Error("fixture");
    const invoice: Invoice = { ...base, issuer: { ...base.issuer, electronicAddress: null, electronicAddressScheme: null, smallBusiness: false } };
    const plan = planEinvoiceFill(invoice, sources({ profile: profileValues({ smallBusiness: true }) }), {});
    assert.deepEqual(plan.fields, ["issuer.electronicAddress"]);
    assert.equal(plan.set.issuer?.electronicAddressScheme, "EM");
    assert.equal(plan.set.issuer?.smallBusiness, false);
    // The write names the pair and nothing else of the issuer.
    assert.deepEqual(plan.writes, {
      "issuer.electronicAddress": plan.set.issuer?.electronicAddress,
      "issuer.electronicAddressScheme": "EM",
    });
  });

  it("uses the email default for a profile without an electronic address", () => {
    const base = readyInvoice();
    if (!base.issuer) throw new Error("fixture");
    const invoice: Invoice = { ...base, issuer: { ...base.issuer, electronicAddress: null, electronicAddressScheme: null } };
    const plan = planEinvoiceFill(invoice, sources({ profile: profileValues({ electronicAddress: null, electronicAddressScheme: null }) }), {});
    assert.equal(plan.set.issuer?.electronicAddress, "billing@example.com");
    assert.equal(plan.set.issuer?.electronicAddressScheme, "EM");
  });

  it("fills a null exemption reason on a stored breakdown, never its amounts", () => {
    const invoice = readyInvoice({ category: "E", rate: 0 });
    assert.equal(invoice.taxBreakdown?.[0]?.exemptionReason, null);
    const plan = planEinvoiceFill(invoice, sources(), { exemptionNotes: { E: "§ 4 Nr. 21 UStG" } });
    assert.deepEqual(plan.fields, ["taxBreakdown[0].exemptionReason"]);
    assert.deepEqual(
      plan.set.taxBreakdown?.map((r) => [r.basisAmount, r.taxAmount, r.exemptionReason]),
      [[invoice.subtotal, 0, "§ 4 Nr. 21 UStG"]],
    );
  });

  it("is idempotent: a second plan on the filled invoice has nothing to do", () => {
    const invoice = legacyInvoice(19);
    const once = applyFillPlan(invoice, planEinvoiceFill(invoice, sources(), {}));
    const again = planEinvoiceFill(once, sources(), {});
    assert.deepEqual(again.fields, []);
    assert.deepEqual(again.set, {});
  });

  it("adds no payment terms when nothing else is filled", () => {
    const { paymentTerms: _terms, ...invoice } = readyInvoice();
    const plan = planEinvoiceFill(invoice, sources(), {});
    assert.deepEqual(plan.fields, []);
  });
});

describe("sources that cannot fill", () => {
  it("a deleted client fills no recipient", () => {
    const invoice = legacyInvoice(19);
    const plan = planEinvoiceFill(invoice, sources({ client: null }), {});
    assert.equal(plan.set.recipient, undefined);
    assert.ok(issueCodes(previewIssuesAfterFill(invoice, plan, "en16931")).includes("BUYER_SNAPSHOT_MISSING"));
  });

  it("a client without billing details: the preview names each missing field", () => {
    const invoice = legacyInvoice(19);
    const plan = planEinvoiceFill(invoice, sources({ client: { billing: null } }), {});
    assert.equal(plan.set.recipient, undefined);
    const after = issueCodes(previewIssuesAfterFill(invoice, plan, "xrechnung"));
    assert.deepEqual(
      after.filter((code) => code.startsWith("BUYER_")),
      ["BUYER_STREET_MISSING", "BUYER_POSTCODE_MISSING", "BUYER_CITY_MISSING", "BUYER_COUNTRY_MISSING", "BUYER_REFERENCE_MISSING", "BUYER_ELECTRONIC_ADDRESS_MISSING"],
    );
    const issue = previewIssuesAfterFill(invoice, plan, "xrechnung").find((i) => i.code === "BUYER_CITY_MISSING");
    assert.equal(issue?.clientId, invoice.clientId);
  });

  it("an empty profile: no issuer snapshot, and the preview names the legal name", () => {
    const invoice = legacyInvoice(19);
    const plan = planEinvoiceFill(invoice, sources({ profile: profileValues({
      legalName: null, addressLines: [], postalCode: null, city: null, country: null, email: null, phone: null,
      paymentTermsDays: null, vatId: null, taxNumber: null, registrationNumber: null, contactName: null,
      electronicAddress: null, electronicAddressScheme: null, iban: null, bic: null, bankName: null, accountHolder: null,
    }) }), {});
    assert.equal(plan.set.issuer, undefined);
    const after = issueCodes(previewIssuesAfterFill(invoice, plan, "en16931"));
    assert.equal(after.includes("SELLER_SNAPSHOT_MISSING"), false);
    assert.ok(after.includes("SELLER_LEGAL_NAME_MISSING"));
    assert.ok(after.includes("SELLER_TAX_ID_MISSING"));
  });

  it("a partly categorised invoice fills no line and reports it", () => {
    const base = readyInvoice();
    const invoice: Invoice = { ...base, lineItems: base.lineItems.map((l, n) => (n === 0 ? { ...l, taxCategory: undefined, taxRate: undefined } : l)) };
    const plan = planEinvoiceFill(invoice, sources(), { zeroRateCategory: "E" });
    assert.equal(plan.lineTax, "inconsistent");
    assert.equal(plan.set.lineItems, undefined);
    assert.ok(issueCodes(previewIssuesAfterFill(invoice, plan, "en16931")).includes("LINE_TAX_MISSING"));
  });
});

describe("fillNullLeaves", () => {
  it("returns the merged value and the dotted paths, leaving the input untouched", () => {
    const snapshot = { a: null as string | null, b: "kept", list: [] as string[], flag: false, pair: null as string | null };
    const current = { a: "new", b: "other", list: ["x"], flag: true, pair: null as string | null };
    const { merged, filled } = fillNullLeaves(snapshot, current, "party", new Set(["b"]));
    assert.deepEqual(merged, { a: "new", b: "kept", list: ["x"], flag: false, pair: null });
    assert.deepEqual(filled, ["party.a", "party.list"]);
    assert.equal(snapshot.a, null);
  });
});
