// The invoice PDF's language: which one a document is drawn in, and that the
// answer never moves once the invoice exists.
//
// The English golden below is the page text of an invoice with no `locale` —
// one issued before localisation — as the English catalog prints it. Its
// customer holds that page, so it is compared whole, not sampled: a relabelled
// column or a date written differently fails here. (Status and grouping read
// "Draft" / "Project" since the catalog took over the masthead in 4fd4742.)
import assert from "node:assert/strict";
import { describe, it } from "node:test";
// Type-only import from the package root; see duration.test.ts for why runtime
// imports use subpaths in this suite.
import type { Invoice } from "@starter/shared";
import { resolveInvoiceLocale } from "@starter/shared/locale";
import { toClientInvoice, type InvoiceDocLike } from "../models/Invoice.js";
import { renderInvoicePdf } from "../services/invoice-pdf.js";
import { formatPdfAmount } from "../services/pdf.js";
import { pdfFormat } from "../services/pdf-format.js";
import { pageTexts } from "./support/pdf-text.js";

const GENERATED_AT = "2026-09-01T08:00:00.000Z";

const doc = (overrides: Partial<InvoiceDocLike> = {}): InvoiceDocLike => ({
  _id: "64b7f9c2e13a4d5f6a7b8c9d",
  workspaceId: "ws_acme",
  createdBy: "user_alice",
  number: "2026-014",
  clientId: "c1",
  clientName: "Acme GmbH",
  status: "draft",
  issueDate: new Date("2026-09-01T00:00:00.000Z"),
  dueDate: new Date("2026-09-15T00:00:00.000Z"),
  from: new Date("2026-08-01T00:00:00.000Z"),
  to: new Date("2026-09-01T00:00:00.000Z"),
  groupBy: "project",
  lineItems: [
    {
      key: "p1",
      label: "Website",
      projectId: "p1",
      taskId: null,
      seconds: 3 * 3600,
      hours: 3,
      hourlyRate: 100,
      currency: "EUR",
      amount: 1234.5,
    },
  ],
  subtotal: 1234.5,
  taxRate: 19,
  taxAmount: 234.56,
  total: 1469.06,
  currency: "EUR",
  entryIds: ["e1"],
  notes: "Thanks",
  createdAt: new Date("2026-09-01T08:00:00.000Z"),
  updatedAt: new Date("2026-09-01T08:00:00.000Z"),
  ...overrides,
});

const text = async (invoice: Invoice): Promise<string> => {
  const pages = pageTexts(await renderInvoicePdf(invoice, { generatedAt: GENERATED_AT }));
  assert.equal(pages.length, 1);
  return pages[0] ?? "";
};

/** An invoice with no `locale`. Change it only with the English catalog. */
const ENGLISH_GOLDEN =
  "Invoice 2026-014 · Acme GmbHPage 1Invoice 2026-014Billed toAcme GmbHStatusDraft" +
  "Issue date2026-09-01Due date2026-09-15Period2026-08-01 to 2026-09-01Grouped byProject" +
  "Amounts in EUR · generated 2026-09-01T08:00:00.000ZDescriptionHoursRateAmount" +
  "Website3.00100.001,234.50Subtotal (EUR)1,234.50Tax (19%)234.56Total (EUR)1,469.06" +
  "NotesThanks";

describe("invoice PDF language", () => {
  it("an invoice issued before localisation prints the page it always printed", async () => {
    const legacy = toClientInvoice(doc());
    assert.equal("locale" in legacy, false, "a missing locale must stay missing on the wire");
    assert.equal(await text(legacy), ENGLISH_GOLDEN);
  });

  it("an explicit English invoice is the same page as a pre-localisation one", async () => {
    assert.equal(await text(toClientInvoice(doc({ locale: "en" }))), ENGLISH_GOLDEN);
  });

  it("a German invoice is German, labels and figures alike", async () => {
    const page = await text(toClientInvoice(doc({ locale: "de" })));
    for (const expected of [
      "Rechnung 2026-014",
      "Seite 1",
      "Rechnungsempfänger",
      "StatusEntwurf",
      "Rechnungsdatum01.09.2026",
      "Fälligkeitsdatum15.09.2026",
      "Leistungszeitraum01.08.2026 bis 01.09.2026",
      "Gruppiert nachProjekt",
      "Beträge in EUR · erstellt am 01.09.2026, 08:00 UTC",
      "BeschreibungStundenStundensatzBetrag",
      "Website3,00100,001.234,50",
      "Zwischensumme (EUR)1.234,50",
      "USt. (19 %)234,56",
      "Gesamtbetrag (EUR)1.469,06",
      "AnmerkungenThanks",
    ]) {
      assert.ok(page.includes(expected), `missing ${JSON.stringify(expected)} in ${page}`);
    }
    for (const english of ["Invoice", "Billed to", "Subtotal", "Amounts in", "1,234.50"]) {
      assert.ok(!page.includes(english), `English leaked into a German invoice: ${english}`);
    }
  });

  it("the user's text is never translated", async () => {
    const page = await text(
      toClientInvoice(doc({ locale: "de", clientName: "Invoice Ltd", notes: "Total due" })),
    );
    assert.ok(page.includes("Invoice Ltd"));
    assert.ok(page.includes("Total due"));
  });

  it("the language is the snapshot's, whatever decides a NEW invoice today", async () => {
    // The document was snapshotted German. Everything that would decide the
    // language of an invoice created now points at English — the renderer
    // must not care, because it is given none of it.
    assert.equal(
      resolveInvoiceLocale({ clientLocale: "en", issuerPreference: "en" }),
      "en",
    );
    const snapshot = toClientInvoice(doc({ locale: "de" }));
    const first = await text(snapshot);
    const again = await text(toClientInvoice(doc({ locale: "de" })));
    assert.equal(again, first);
    assert.ok(first.startsWith("Rechnung"));
  });

  it("the status line follows the status, in the invoice's language", async () => {
    const sent = await text(toClientInvoice(doc({ locale: "de", status: "sent" })));
    assert.ok(sent.includes("Statusversendet"));
    const paid = await text(toClientInvoice(doc({ status: "paid", groupBy: "task" })));
    assert.ok(paid.includes("StatusPaid"));
    assert.ok(paid.includes("Grouped byTask"));
  });

  it("a German invoice with no lines and no tax says so in German", async () => {
    const page = await text(
      toClientInvoice(
        doc({ locale: "de", lineItems: [], subtotal: 0, taxRate: null, taxAmount: 0, total: 0 }),
      ),
    );
    assert.ok(page.includes("Keine abrechenbare Zeit in diesem Zeitraum."));
    assert.ok(!page.includes("USt."));
  });
});

describe("pdfFormat", () => {
  it("English amounts are formatPdfAmount's, rounding included", () => {
    const en = pdfFormat("en");
    for (const value of [0, 1, 1.005, 2.675, -0.001, -1234.5, 999.995, 1_234_567.891, Number.NaN]) {
      assert.equal(en.amount(value), formatPdfAmount(value), String(value));
    }
  });

  it("English keeps ISO dates, ungrouped counts and a bare tax rate", () => {
    const en = pdfFormat("en");
    assert.equal(en.date("2026-08-31T22:00:00.000Z"), "2026-08-31");
    assert.equal(en.weekdayDate("2026-09-01"), "Tue 09-01");
    assert.equal(en.month("2026-08"), "August 2026");
    assert.equal(en.count(12345), "12345");
    assert.equal(en.plain(7.5), "7.5");
    assert.equal(en.hours(2.5), "2.50");
  });

  it("German writes dates, numbers and rates the German way", () => {
    const de = pdfFormat("de");
    // The calendar date on the wire, never shifted by a zone.
    assert.equal(de.date("2026-08-31T22:00:00.000Z"), "31.08.2026");
    assert.equal(de.date("2026-08-31"), "31.08.2026");
    assert.equal(de.amount(1234.5), "1.234,50");
    assert.equal(de.amount(-0.5), "-0,50");
    assert.equal(de.hours(2.5), "2,50");
    assert.equal(de.plain(7.5), "7,5");
    assert.equal(de.month("2026-03"), "März 2026");
    assert.equal(de.weekdayDate("2026-09-01"), "Di., 01.09.");
  });

  it("never emits a character the PDF fonts cannot draw", () => {
    for (const locale of ["en", "de"] as const) {
      const format = pdfFormat(locale);
      const samples = [
        format.amount(1_234_567.89),
        format.date("2026-08-31"),
        format.weekdayDate("2026-08-31"),
        format.month("2026-08"),
        format.timestamp(GENERATED_AT),
        format.count(1_234_567),
      ];
      for (const sample of samples) {
        assert.ok(!sample.includes(" "), `${locale}: ${JSON.stringify(sample)}`);
      }
    }
  });
});
