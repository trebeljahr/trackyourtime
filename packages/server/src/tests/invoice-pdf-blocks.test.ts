import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Invoice, TaxBreakdownRow } from "@starter/shared";
import { serverT } from "../i18n/index.js";
import { buildCiiXml } from "../services/einvoice/cii.js";
import { assertEinvoiceReady } from "../services/einvoice/validate.js";
import {
  bankLines,
  breakdownTotalRows,
  exemptionReasons,
  groupIban,
  omitsVatIds,
  taxIdentityLines,
} from "../services/invoice-pdf-blocks.js";
import { renderInvoicePdf } from "../services/invoice-pdf.js";
import { pdfFormat } from "../services/pdf-format.js";
import {
  EINVOICE_CASES,
  einvoiceCase,
  FIXTURE_NOTES,
  issuerFixture,
  legacyInvoiceFixture,
} from "./fixtures/einvoice/cases.js";
import { pageTexts } from "./support/pdf-bytes.js";

const META = { generatedAt: "2026-10-01T10:00:00.000Z" };
const en = serverT("en", "invoice");
const de = serverT("de", "invoice");
const fen = pdfFormat("en");
const fde = pdfFormat("de");

const text = async (bytes: Promise<Buffer>): Promise<string> => pageTexts(await bytes).join("\n");

const row = (category: TaxBreakdownRow["category"], rate: number, basisAmount: number, taxAmount = 0): TaxBreakdownRow => ({
  category,
  rate,
  basisAmount,
  taxAmount,
  exemptionReason: null,
  exemptionReasonCode: null,
});

describe("omitsVatIds", () => {
  it("is true exactly when a line is not subject to VAT, the condition cii.ts drops BT-31 and BT-48 on (BR-O-02)", () => {
    assert.equal(omitsVatIds(einvoiceCase("not-subject-o").invoice()), true);
    assert.equal(omitsVatIds(einvoiceCase("standard-19").invoice()), false);
    assert.equal(omitsVatIds(legacyInvoiceFixture()), false);
  });
});

describe("taxIdentityLines", () => {
  it("prints the VAT id and the tax number instead of the legacy tax id", () => {
    assert.deepEqual(
      taxIdentityLines({ taxId: "DE123456789", vatId: "DE123456789", taxNumber: "30/123/45678" }, en, { omitVatId: false }),
      ["VAT ID: DE123456789", "Tax number: 30/123/45678"],
    );
  });

  it("keeps a legacy tax id that repeats neither new field: a fill never takes a line off a sent PDF", () => {
    // The legacy value was a tax number; the fill added only a VAT id.
    assert.deepEqual(
      taxIdentityLines({ taxId: "30/123/45678", vatId: "DE123456789", taxNumber: null }, en, { omitVatId: false }),
      ["VAT ID: DE123456789", "Tax ID: 30/123/45678"],
    );
    // Separators do not make a repeat look different.
    assert.deepEqual(
      taxIdentityLines({ taxId: "DE 123 456 789", vatId: "DE123456789", taxNumber: null }, en, { omitVatId: false }),
      ["VAT ID: DE123456789"],
    );
  });

  it("prints the legacy tax id exactly as before when neither new field is set", () => {
    assert.deepEqual(taxIdentityLines({ taxId: "DE555", vatId: null, taxNumber: null }, en, { omitVatId: false }), [
      "Tax ID: DE555",
    ]);
    // A snapshot written before e-invoicing has no such keys at all.
    assert.deepEqual(taxIdentityLines({ taxId: "DE555" }, de, { omitVatId: false }), ["Steuernummer: DE555"]);
    assert.deepEqual(taxIdentityLines({ taxId: null }, en, { omitVatId: false }), []);
  });

  it("leaves the VAT id off a not-subject invoice, and the legacy tax id with it", () => {
    assert.deepEqual(
      taxIdentityLines({ taxId: "CHE123456789", vatId: "CHE123456789", taxNumber: null }, en, { omitVatId: true }),
      [],
    );
    assert.deepEqual(
      taxIdentityLines({ taxId: null, vatId: "DE123456789", taxNumber: "30/123/45678" }, de, { omitVatId: true }),
      ["Steuernummer: 30/123/45678"],
    );
  });
});

describe("breakdownTotalRows", () => {
  it("gives one row per stored breakdown row, with its basis and the stored tax amount", () => {
    const invoice = einvoiceCase("mixed-19-7").invoice();
    assert.deepEqual(breakdownTotalRows(invoice, en, fen), [
      { label: "VAT 19% on 1,234.50", value: "234.56", strong: false },
      { label: "VAT 7% on 333.50", value: "23.35", strong: false },
    ]);
    assert.deepEqual(
      breakdownTotalRows(invoice, de, fde).map((item) => item.label),
      ["USt. 19 % auf 1.234,50", "USt. 7 % auf 333,50"],
    );
  });

  it("names every zero-rate category with its taxable amount, in both languages", () => {
    const cases = [
      ["zero-rated", "Zero-rated (0%) on ", "Nullsatz (0 %) auf "],
      ["small-business-e", "VAT exempt on ", "Steuerfrei auf "],
      ["reverse-charge-ae", "Reverse charge on ", "Reverse Charge auf "],
      ["not-subject-o", "Not subject to VAT on ", "Nicht steuerbar auf "],
    ] as const;
    for (const [name, enPrefix, dePrefix] of cases) {
      const invoice = einvoiceCase(name).invoice();
      const first = invoice.taxBreakdown?.[0];
      assert.ok(first, name);
      const enLabel = `${enPrefix}${fen.amount(first.basisAmount)}`;
      const deLabel = `${dePrefix}${fde.amount(first.basisAmount)}`;
      assert.equal(breakdownTotalRows(invoice, en, fen)[0]?.label, enLabel, name);
      assert.equal(breakdownTotalRows(invoice, de, fde)[0]?.label, deLabel, name);
    }
  });

  it("prints the basis of every row on an invoice mixing 19 % with reverse charge", () => {
    const invoice: Pick<Invoice, "taxBreakdown"> = {
      taxBreakdown: [row("S", 19, 1000, 190), row("AE", 0, 500), row("O", 0, 250)],
    };
    assert.deepEqual(
      breakdownTotalRows(invoice, en, fen).map((item) => item.label),
      ["VAT 19% on 1,000.00", "Reverse charge on 500.00", "Not subject to VAT on 250.00"],
    );
  });

  it("is empty for a legacy invoice", () => {
    assert.deepEqual(breakdownTotalRows(legacyInvoiceFixture(), en, fen), []);
  });
});

describe("exemptionReasons", () => {
  it("lists each stored reason once, in stored order", () => {
    assert.deepEqual(exemptionReasons(einvoiceCase("small-business-e").invoice()), [FIXTURE_NOTES.smallBusinessDe]);
    assert.deepEqual(
      exemptionReasons({
        taxBreakdown: [
          { ...row("AE", 0, 1), exemptionReason: "Reverse charge." },
          { ...row("E", 0, 1), exemptionReason: "Reverse charge." },
          { ...row("O", 0, 1), exemptionReason: "  " },
        ],
      }),
      ["Reverse charge."],
    );
  });

  it("is empty for a legacy invoice and for a breakdown without reasons", () => {
    assert.deepEqual(exemptionReasons(legacyInvoiceFixture()), []);
    assert.deepEqual(exemptionReasons(einvoiceCase("standard-19").invoice()), []);
  });
});

describe("bankLines", () => {
  it("prints the grouped IBAN, BIC, bank and account holder through the catalog", () => {
    assert.deepEqual(bankLines(issuerFixture(), en), [
      "IBAN: DE02 1203 0000 0000 2020 51",
      "BIC: BYLADEM1001",
      "Bank: Beispielbank",
      "Account holder: Erika Mustermann",
    ]);
    assert.equal(bankLines(issuerFixture(), de)[3], "Kontoinhaber: Erika Mustermann");
  });

  it("is empty for a snapshot without bank fields", () => {
    assert.deepEqual(bankLines({ iban: null, bic: null, bankName: null, accountHolder: null }, en), []);
  });

  it("groups an IBAN in fours for print only", () => {
    assert.equal(groupIban("de02120300000000202051"), "DE02 1203 0000 0000 2020 51");
  });
});

describe("invoice PDF with e-invoice data", () => {
  it("draws the tax identity, the per-category tax rows, the exemption note and the bank lines", async () => {
    const page = await text(renderInvoicePdf(einvoiceCase("reverse-charge-ae").invoice(), META));
    for (const expected of [
      "Musterstraße 1",
      "Beispielgasse 3",
      "VAT ID: DE123456789",
      "Tax number: 30/123/45678",
      "VAT ID: ATU12345678",
      "Erika Mustermann · erika@seller.example · +49 30 1234567",
      "Reverse charge on 1,187.50",
      "VAT note",
      FIXTURE_NOTES.reverseChargeEn,
      "IBAN: DE02 1203 0000 0000 2020 51",
      "Account holder: Erika Mustermann",
    ]) {
      assert.ok(page.includes(expected), `PDF is missing "${expected}"`);
    }
    assert.ok(!page.includes("Tax ID:"), "the legacy tax id line is replaced");
  });

  it("draws the same blocks in German for a German invoice", async () => {
    const page = await text(renderInvoicePdf(einvoiceCase("small-business-e").invoice(), META));
    for (const expected of [
      "Rechnung 2026-0046",
      "Steuerfrei auf 300,00",
      "Hinweis zur Umsatzsteuer",
      FIXTURE_NOTES.smallBusinessDe,
      "Steuernummer: 30/123/45678",
      "Zahlbar innerhalb von 14 Tagen, bis zum 15.10.2026.",
      "IBAN: DE02 1203 0000 0000 2020 51",
      "Kontoinhaber: Erika Mustermann",
    ]) {
      assert.ok(page.includes(expected), `German PDF is missing "${expected}"`);
    }
  });

  it("draws one tax row per rate for a mixed invoice, and no flat-rate row beside them", async () => {
    const page = await text(renderInvoicePdf(einvoiceCase("mixed-19-7").invoice(), META));
    assert.ok(page.includes("VAT 19% on 1,234.50"));
    assert.ok(page.includes("VAT 7% on 333.50"));
    assert.ok(!page.includes("Tax ("), "no legacy flat-rate row next to the breakdown");
  });

  it("prints a VAT id exactly when the embedded XML carries one, for every case", async () => {
    for (const c of EINVOICE_CASES.filter((item) => item.name !== "long-500")) {
      const invoice = c.invoice();
      const page = await text(renderInvoicePdf(invoice, META));
      const xml = buildCiiXml(assertEinvoiceReady(invoice, "en16931"), "en16931");
      const printsVatId = page.includes("VAT ID:") || page.includes("USt-IdNr.:");
      assert.equal(printsVatId, xml.includes('schemeID="VA"'), c.name);
    }
  });

  it("prints the frozen payment terms (BT-20) rather than recomputing them", async () => {
    const page = await text(renderInvoicePdf(einvoiceCase("escaping").invoice(), META));
    assert.ok(page.includes("Payable within 14 days."));
    assert.ok(!page.includes("Payable within 14 days, by"), "a stored sentence is never rebuilt");
  });

  it("leaves a legacy invoice as it was, period included", async () => {
    const legacy = legacyInvoiceFixture();
    const page = await text(renderInvoicePdf(legacy, META));
    assert.ok(page.includes("Tax (19%)"));
    for (const absent of ["From", "VAT note", "VAT ID", "IBAN", "Musterstraße"]) {
      assert.ok(!page.includes(absent), `legacy PDF must not print ${absent}`);
    }
    assert.ok(
      page.includes(`${fen.date(legacy.from)} to ${fen.date(legacy.to)}`),
      "a legacy invoice keeps the exclusive end it was sent with",
    );
  });
});
