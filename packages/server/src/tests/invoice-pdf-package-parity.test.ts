// The invoice renderer lives in @starter/invoice-pdf and the server calls it
// through services/invoice-pdf.ts, which only wraps the Uint8Array in a Buffer.
// This pins that the two produce the same bytes, so the split can never let the
// server and a browser page (which imports the package directly) drift apart.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderInvoicePdf as renderPackageBytes } from "@starter/invoice-pdf";
import { renderInvoicePdf as renderServerBytes } from "../services/invoice-pdf.js";
import { einvoiceCase } from "./fixtures/einvoice/cases.js";

const META = { generatedAt: "2026-10-01T10:00:00.000Z" };
// pdfkit stamps info.CreationDate with the wall clock unless it is given one;
// pin it so two renders in the same test are comparable byte for byte.
const pinned = {
  documentOptions: { info: { CreationDate: new Date("2026-01-02T03:04:05.000Z") } },
  prepare() {},
  finish() {},
} as const;

describe("invoice PDF package parity", () => {
  it("the package and the server entry point emit identical bytes", async () => {
    const invoice = einvoiceCase("standard-19").invoice();
    const fromPackage = await renderPackageBytes(invoice, META, pinned);
    const fromServer = await renderServerBytes(invoice, META, pinned);
    assert.ok(fromPackage instanceof Uint8Array);
    assert.ok(Buffer.isBuffer(fromServer));
    assert.deepEqual(Buffer.from(fromPackage), fromServer);
  });
});
