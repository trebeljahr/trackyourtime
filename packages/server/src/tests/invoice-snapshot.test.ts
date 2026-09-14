// An invoice freezes both parties at creation, and the PDF prints the frozen
// copy — never the live business profile or client.
//
// The snapshot helpers and the renderer are pure, so the promise is tested
// where it is kept: the snapshot is a copy (editing the profile afterwards
// cannot reach it), the document renders from the invoice alone, and an
// invoice written before snapshots existed still prints its client name.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inflateSync } from "node:zlib";
import {
  dueDateFromTerms,
  issuerSnapshot,
  recipientSnapshot,
  type BusinessProfileFields,
  type Invoice,
} from "@starter/shared";
import { toClientInvoice, type InvoiceDocLike } from "../models/Invoice.js";
import { renderInvoicePdf } from "../services/invoice-pdf.js";

/** The text a PDF draws, all pages joined — see pdf.test.ts for the method. */
const pdfText = (bytes: Buffer): string => {
  const open = Buffer.from("stream\n", "latin1");
  const close = Buffer.from("endstream", "latin1");
  const pages: string[] = [];
  let cursor = 0;
  for (;;) {
    const at = bytes.indexOf(open, cursor);
    if (at === -1) break;
    const start = at + open.byteLength;
    const end = bytes.indexOf(close, start);
    if (end === -1) break;
    try {
      const inflated = inflateSync(bytes.subarray(start, end)).toString("latin1");
      const runs = inflated.match(/<([0-9a-fA-F]+)>/g) ?? [];
      pages.push(
        Buffer.from(runs.map((run) => run.slice(1, -1)).join(""), "hex").toString(
          "latin1",
        ),
      );
      cursor = end + close.byteLength;
    } catch {
      cursor = start;
    }
  }
  return pages.join("\n");
};

const profile = (): BusinessProfileFields => ({
  legalName: "Alice Consulting",
  addressLines: ["Hauptstr. 1", "  "],
  postalCode: "10115",
  city: "Berlin",
  country: "de",
  taxId: "DE123456789",
  email: "billing@example.com",
  phone: "",
  website: null,
  paymentDetails: "IBAN DE00 1234",
  paymentTermsDays: 14,
  invoiceFooter: "Thank you for the work.",
});

const legacyDoc = (): InvoiceDocLike => ({
  _id: "64b7f9c2e13a4d5f6a7b8c9d",
  workspaceId: "ws",
  createdBy: "user",
  number: "2025-003",
  clientId: "c1",
  clientName: "Acme GmbH",
  status: "sent",
  issueDate: new Date("2025-03-01T00:00:00.000Z"),
  dueDate: new Date("2025-03-15T00:00:00.000Z"),
  from: new Date("2025-02-01T00:00:00.000Z"),
  to: new Date("2025-02-28T00:00:00.000Z"),
  groupBy: "project",
  lineItems: [
    {
      key: "p1",
      label: "Website",
      projectId: "p1",
      taskId: null,
      seconds: 3600,
      hours: 1,
      hourlyRate: 100,
      currency: "EUR",
      amount: 100,
    },
  ],
  subtotal: 100,
  taxRate: 19,
  taxAmount: 19,
  total: 119,
  currency: "EUR",
  entryIds: ["e1"],
  notes: null,
  createdAt: new Date("2025-03-01T00:00:00.000Z"),
  updatedAt: new Date("2025-03-01T00:00:00.000Z"),
});

const GENERATED = { generatedAt: "2026-09-14T08:00:00.000Z" };

describe("invoice snapshots", () => {
  it("copies the profile, so a later edit cannot reach an issued invoice", () => {
    const live = profile();
    const issuer = issuerSnapshot(live);
    assert.ok(issuer);

    // The edit a person makes after the invoice went out.
    live.legalName = "Renamed Ltd";
    (live.addressLines as string[])[0] = "Neuer Weg 9";
    live.taxId = "DE999";

    assert.equal(issuer.legalName, "Alice Consulting");
    assert.deepEqual(issuer.addressLines, ["Hauptstr. 1"]);
    assert.equal(issuer.taxId, "DE123456789");
  });

  it("stores blanks as null and the country upper case", () => {
    const issuer = issuerSnapshot(profile());
    assert.equal(issuer?.phone, null);
    assert.equal(issuer?.country, "DE");
  });

  it("takes no snapshot of an empty profile or a client without billing details", () => {
    assert.equal(issuerSnapshot(null), null);
    assert.equal(issuerSnapshot({ legalName: "  ", addressLines: [""] }), null);
    assert.equal(recipientSnapshot("Acme", undefined), null);
    assert.equal(recipientSnapshot("Acme", { city: "" }), null);
    assert.deepEqual(recipientSnapshot("Acme", { reference: "PO-7" }), {
      name: "Acme",
      legalName: null,
      addressLines: [],
      postalCode: null,
      city: null,
      country: null,
      taxId: null,
      email: null,
      reference: "PO-7",
    });
  });

  it("an invoice from before snapshots reads with neither party", () => {
    const wire = toClientInvoice(legacyDoc());
    assert.equal(wire.issuer, null);
    assert.equal(wire.recipient, null);
  });

  it("suggests a due date from the payment terms, in calendar days", () => {
    assert.equal(dueDateFromTerms("2026-12-20", 14), "2027-01-03");
    assert.equal(dueDateFromTerms("2026-02-28", 1), "2026-03-01");
    assert.equal(dueDateFromTerms("2026-09-01", 0), "2026-09-01");
    assert.equal(dueDateFromTerms("2026-09-01", null), null);
  });
});

describe("invoice PDF parties", () => {
  const withParties = (): Invoice => {
    const doc = legacyDoc();
    return toClientInvoice({
      ...doc,
      issuer: issuerSnapshot(profile()),
      recipient: recipientSnapshot("Acme GmbH", {
        legalName: "Acme Holding GmbH",
        addressLines: ["Industriestr. 4"],
        postalCode: "20095",
        city: "Hamburg",
        country: "DE",
        taxId: "DE555",
        reference: "PO-7",
      }),
    });
  };

  it("prints issuer, billed-to address, tax ids, reference, payment details, due date and footer", async () => {
    const text = pdfText(await renderInvoicePdf(withParties(), GENERATED));
    for (const expected of [
      "Alice Consulting",
      "Hauptstr. 1",
      "10115 Berlin",
      "Tax ID: DE123456789",
      "billing@example.com",
      "Billed to",
      "Acme Holding GmbH",
      "Industriestr. 4",
      "20095 Hamburg",
      "Tax ID: DE555",
      "Your reference: PO-7",
      "Payment details",
      "IBAN DE00 1234",
      "Payable within 14 days, by 2025-03-15.",
      "Thank you for the work.",
    ]) {
      assert.ok(text.includes(expected), `PDF is missing "${expected}"`);
    }
  });

  it("keeps the line breaks typed into the payment details", async () => {
    const invoice = withParties();
    const issuer = invoice.issuer;
    assert.ok(issuer);
    const text = pdfText(
      await renderInvoicePdf(
        {
          ...invoice,
          issuer: { ...issuer, paymentDetails: "Bank A\nIBAN DE00 1234\r\nBIC ABCDDEFF" },
        },
        GENERATED,
      ),
    );
    assert.ok(text.includes("IBAN DE00 1234"));
    assert.ok(text.includes("BIC ABCDDEFF"));
    // Collapsed into one run, the three lines would read as one sentence.
    assert.ok(!text.includes("Bank A IBAN"), "payment details were collapsed onto one line");
  });

  it("renders from the invoice alone: the snapshot, not today's profile", async () => {
    const invoice = withParties();
    const before = pdfText(await renderInvoicePdf(invoice, GENERATED));
    // Nothing the renderer could read has changed, so neither may the page.
    const after = pdfText(await renderInvoicePdf(invoice, GENERATED));
    assert.equal(after, before);
    assert.ok(!before.includes("Renamed Ltd"));
  });

  it("an invoice from before snapshots still prints its client name as Billed to", async () => {
    const text = pdfText(await renderInvoicePdf(toClientInvoice(legacyDoc()), GENERATED));
    assert.ok(text.includes("Billed to"));
    assert.ok(text.includes("Acme GmbH"));
    assert.ok(!text.includes("Payment details"));
    assert.ok(!text.includes("From"));
  });

  it("prints the new blocks in the invoice's own language", async () => {
    const text = pdfText(
      await renderInvoicePdf({ ...withParties(), locale: "de" }, GENERATED),
    );
    for (const expected of [
      "Rechnung 2025-003",
      "Rechnungsempfänger",
      "Steuernummer: DE555",
      "Zahlungsinformationen",
      "Zahlbar innerhalb von 14 Tagen, bis zum 2025-03-15.",
    ]) {
      assert.ok(text.includes(expected), `German PDF is missing "${expected}"`);
    }
  });
});
