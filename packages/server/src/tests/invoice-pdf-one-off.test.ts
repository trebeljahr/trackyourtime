// Two renderer behaviours the public invoice generator needs, pinned on the
// server's copy of the renderer (the same package source the browser runs):
//
// - `meta.oneOff` leaves out the Status and Grouped-by rows. A one-off invoice
//   has no workflow in the app, and "Status: Draft" on the final document a
//   person sends reads as unfinished. A stored invoice passes no flag and keeps
//   both rows (`invoice-pdf-locale.test.ts` pins that page whole).
// - A description wider than its column wraps onto further lines instead of
//   losing its end to "...". The line is what the customer pays for.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Invoice, InvoiceLineItem } from "@starter/shared";
import { toClientInvoice, type InvoiceDocLike } from "../models/Invoice.js";
import { renderInvoicePdf } from "../services/invoice-pdf.js";
import { pageTexts } from "./support/pdf-text.js";

const GENERATED_AT = "2026-11-06T08:00:00.000Z";

const line = (label: string, key = "manual:l1"): InvoiceLineItem => ({
  key,
  label,
  projectId: null,
  taskId: null,
  kind: "manual",
  seconds: 0,
  hours: 0,
  hourlyRate: 100,
  currency: "EUR",
  amount: 100,
  quantity: 1,
  unit: "hour",
  unitPrice: 100,
});

const doc = (overrides: Partial<InvoiceDocLike> = {}): InvoiceDocLike => ({
  _id: "64b7f9c2e13a4d5f6a7b8c9e",
  workspaceId: "ws_acme",
  createdBy: "user_alice",
  number: "2026-099",
  clientId: "c1",
  clientName: "Client Co",
  status: "draft",
  issueDate: new Date("2026-11-06T00:00:00.000Z"),
  dueDate: new Date("2026-11-20T00:00:00.000Z"),
  from: null,
  to: null,
  groupBy: "project",
  lineItems: [line("Design review")],
  subtotal: 100,
  taxRate: null,
  taxAmount: 0,
  total: 100,
  currency: "EUR",
  entryIds: [],
  notes: null,
  createdAt: new Date(GENERATED_AT),
  updatedAt: new Date(GENERATED_AT),
  ...overrides,
});

const pages = async (invoice: Invoice, oneOff?: boolean): Promise<string[]> =>
  pageTexts(
    await renderInvoicePdf(
      invoice,
      oneOff === undefined ? { generatedAt: GENERATED_AT } : { generatedAt: GENERATED_AT, oneOff },
    ),
  );

describe("invoice PDF: one-off invoices", () => {
  it("leaves out the Status and Grouped-by rows", async () => {
    for (const locale of ["en", "de"] as const) {
      const [page] = await pages(toClientInvoice(doc({ locale })), true);
      assert.ok(page);
      for (const label of ["Status", "Draft", "Entwurf", "Grouped by", "Gruppiert nach"]) {
        assert.ok(!page.includes(label), `${locale}: ${label} still printed in ${page}`);
      }
      assert.ok(page.includes(locale === "de" ? "Rechnungsdatum" : "Issue date"));
    }
  });

  it("keeps both rows for a stored invoice", async () => {
    const [page] = await pages(toClientInvoice(doc()));
    assert.ok(page?.includes("StatusDraft"));
    assert.ok(page?.includes("Grouped byProject"));
  });

  it("prints the service period when it has one", async () => {
    const [page] = await pages(
      toClientInvoice(
        doc({
          locale: "de",
          from: new Date("2026-10-01T00:00:00.000Z"),
          to: new Date("2026-10-31T00:00:00.000Z"),
        }),
      ),
      true,
    );
    assert.ok(page?.includes("Leistungszeitraum01.10.2026 bis 31.10.2026"), page);
  });
});

describe("invoice PDF: long descriptions", () => {
  const long =
    "Implementation of the customer onboarding flow including account creation, " +
    "email verification, two-factor setup, data import from the previous provider " +
    "and a written hand-over for the support team";

  it("wraps a long description instead of cutting it off", async () => {
    const [page] = await pages(toClientInvoice(doc({ lineItems: [line(long)] })), true);
    assert.ok(page);
    assert.ok(!page.includes("..."), `truncated: ${page}`);
    // Every word is drawn, in order, across however many lines it takes.
    let from = 0;
    for (const word of long.split(" ")) {
      const at = page.indexOf(word, from);
      assert.ok(at >= 0, `missing ${JSON.stringify(word)} in ${page}`);
      from = at + word.length;
    }
    assert.ok(page.includes("Total (EUR)100.00"));
  });

  it("starts a new page rather than running a wrapped row into the footer", async () => {
    const lines = Array.from({ length: 30 }, (_, index) => line(long, `manual:l${index}`));
    const result = await pages(
      toClientInvoice(doc({ lineItems: lines, subtotal: 3000, total: 3000 })),
      true,
    );
    assert.ok(result.length > 1, "expected more than one page");
    const all = result.join("");
    assert.ok(!all.includes("..."));
    assert.equal(all.split("Implementation").length - 1, 30);
    assert.equal(all.split("support").length - 1, 30);
  });
});
