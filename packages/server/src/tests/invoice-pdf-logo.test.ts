// The logo on the invoice document: the bytes stay on the server (the wire
// says `hasLogo`), the PDF embeds an image XObject exactly when the invoice
// froze one, the ZUGFeRD variant carries it inside its PDF/A-3b container,
// and an invoice without a logo draws the page it always drew.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { renderableInvoice, toClientInvoice, type InvoiceDocLike } from "../models/Invoice.js";
import { buildCiiXml } from "../services/einvoice/cii.js";
import { coverInvoiceText } from "../services/einvoice/glyph-coverage.js";
import { renderZugferdPdf } from "../services/einvoice/pdfa3.js";
import { assertEinvoiceReady } from "../services/einvoice/validate.js";
import { inspectLogoBytes, type StoredLogo } from "../services/invoice-logo.js";
import { renderInvoicePdf } from "../services/invoice-pdf.js";
import { loadPdfFonts } from "../services/pdf-fonts.js";
import { einvoiceCase } from "./fixtures/einvoice/cases.js";
import { pdfObjects } from "./support/pdf-bytes.js";
import { pageTexts } from "./support/pdf-text.js";

const GENERATED_AT = "2026-09-01T08:00:00.000Z";

const fixtureLogo = (name: string): StoredLogo => {
  const bytes = readFileSync(fileURLToPath(new URL(`./fixtures/logo/${name}`, import.meta.url)));
  const inspected = inspectLogoBytes(bytes);
  assert.ok(inspected.ok);
  return inspected.logo;
};

/** The image XObject dictionaries of a PDF. */
const imageObjects = (bytes: Buffer): string[] =>
  pdfObjects(bytes)
    .map((object) => object.dict)
    .filter((dict) => dict.includes("/Subtype /Image"));

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
      amount: 300,
    },
  ],
  subtotal: 300,
  taxRate: 19,
  taxAmount: 57,
  total: 357,
  currency: "EUR",
  entryIds: ["e1"],
  notes: null,
  locale: "en",
  issuer: {
    legalName: "Alice Consulting",
    addressLines: ["Hauptstr. 1"],
    postalCode: "10115",
    city: "Berlin",
    country: "DE",
    taxId: null,
    email: "billing@example.com",
    phone: null,
    website: null,
    paymentDetails: null,
    paymentTermsDays: 14,
    invoiceFooter: "Thank you.",
    vatId: "DE123456789",
    taxNumber: null,
    registrationNumber: null,
    sellerIdentifier: null,
    contactName: null,
    electronicAddress: null,
    electronicAddressScheme: null,
    iban: null,
    bic: null,
    bankName: null,
    accountHolder: null,
    smallBusiness: false,
  },
  createdAt: new Date("2026-09-01T08:00:00.000Z"),
  updatedAt: new Date("2026-09-01T08:00:00.000Z"),
  ...overrides,
});

const withLogo = (name = "rgba.png"): InvoiceDocLike => {
  const base = doc();
  return { ...base, issuer: { ...base.issuer!, logo: fixtureLogo(name) } };
};

describe("toClientInvoice and the logo", () => {
  it("answers hasLogo instead of the bytes, and nothing at all without a logo", () => {
    const wire = toClientInvoice(withLogo());
    assert.equal(wire.issuer?.hasLogo, true);
    assert.equal("logo" in (wire.issuer ?? {}), false);
    assert.equal(JSON.stringify(wire).includes("sha256"), false);

    const plain = toClientInvoice(doc());
    assert.equal("hasLogo" in (plain.issuer ?? {}), false);
    assert.equal("logo" in (plain.issuer ?? {}), false);
  });

  it("renderableInvoice puts the bytes back for the renderer only", () => {
    const stored = withLogo("rgb.jpg");
    const renderable = renderableInvoice(stored);
    assert.equal(renderable.issuer?.logo?.sha256, stored.issuer?.logo?.sha256);
    assert.equal(renderable.issuer?.hasLogo, true);
    assert.equal(renderableInvoice(doc()).issuer?.logo, undefined);
  });
});

describe("the invoice PDF and the logo", () => {
  it("embeds one image XObject when the invoice froze a logo, and none otherwise", async () => {
    const without = await renderInvoicePdf(toClientInvoice(doc()), { generatedAt: GENERATED_AT });
    assert.deepEqual(imageObjects(without), []);

    const png = await renderInvoicePdf(renderableInvoice(withLogo("rgba.png")), { generatedAt: GENERATED_AT });
    const pngImages = imageObjects(png);
    // The colour image plus its /SMask (PNG alpha).
    assert.equal(pngImages.length, 2);
    assert.ok(pngImages.some((dict) => dict.includes("/SMask")));
    assert.ok(pngImages.some((dict) => dict.includes("/Width 48") && dict.includes("/Height 16")));

    const jpeg = await renderInvoicePdf(renderableInvoice(withLogo("rgb.jpg")), { generatedAt: GENERATED_AT });
    const jpegImages = imageObjects(jpeg);
    assert.equal(jpegImages.length, 1);
    assert.ok(jpegImages[0]?.includes("/DCTDecode"));
  });

  it("keeps every word of the page: the logo is drawn beside the title, not instead of anything", async () => {
    const [without] = pageTexts(await renderInvoicePdf(toClientInvoice(doc()), { generatedAt: GENERATED_AT }));
    const [withImage] = pageTexts(
      await renderInvoicePdf(renderableInvoice(withLogo()), { generatedAt: GENERATED_AT }),
    );
    assert.equal(withImage, without);
  });

  it("carries the logo into the ZUGFeRD PDF/A-3b container", async () => {
    const invoice = einvoiceCase("standard-19").invoice();
    const logo = fixtureLogo("rgba.png");
    const ready = assertEinvoiceReady({ ...invoice, issuer: { ...invoice.issuer!, logo } }, "en16931");
    const xml = buildCiiXml(ready, "en16931");
    // The drawn copy the variant renders from keeps the bytes.
    const drawn = coverInvoiceText(ready, loadPdfFonts().hasGlyph) as typeof ready & {
      issuer: { logo?: StoredLogo };
    };
    assert.equal(drawn.issuer.logo?.sha256, logo.sha256);

    const bytes = await renderZugferdPdf(ready, xml, { generatedAt: GENERATED_AT });
    const raw = bytes.toString("latin1");
    assert.equal(raw.slice(0, 8), "%PDF-1.7");
    assert.ok(raw.includes("/OutputIntents"));
    assert.ok(imageObjects(bytes).some((dict) => dict.includes("/SMask")));
    // The XML is the same document, logo or not.
    assert.equal(xml, buildCiiXml(assertEinvoiceReady(invoice, "en16931"), "en16931"));
    assert.equal(xml.includes("logo"), false);
  });
});
