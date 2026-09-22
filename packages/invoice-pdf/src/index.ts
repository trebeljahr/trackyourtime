/**
 * `@starter/invoice-pdf` — the invoice PDF renderer, extracted so it runs on
 * the server and in the browser from one source.
 *
 * NO `node:` import, no `fs`/`path`, no `Buffer` in the public API: the bytes
 * come back as a `Uint8Array`. The server wraps that in `Buffer.from` at its
 * own entry point (`packages/server/src/services/invoice-pdf.ts`); the public
 * generator page consumes the `Uint8Array` directly. `import-guard.test.ts`
 * fails the build if a Node-only import slips in.
 *
 * Fonts are injected, never read: the plain PDF uses pdfkit's standard-14
 * Helvetica under `INVOICE_PDF_FONT_NAMES`, and the server's ZUGFeRD variant
 * registers embedded Noto faces under those same names through the variant's
 * `prepare` hook. See the README for the pdfkit browser alias.
 */
export {
  renderInvoicePdf,
  invoicePdfFilename,
  INVOICE_PDF_FONT_NAMES,
} from "./invoice-pdf.js";
export type {
  InvoicePdfMeta,
  InvoicePdfVariant,
  RenderableInvoice,
  RenderableInvoiceLogo,
} from "./invoice-pdf.js";

export {
  bankLines,
  breakdownTotalRows,
  exemptionReasons,
  groupIban,
  omitsVatIds,
  taxIdentityLines,
} from "./invoice-pdf-blocks.js";
export type { TotalsRow } from "./invoice-pdf-blocks.js";

export { pdfFormat } from "./pdf-format.js";
export type { PdfFormat } from "./pdf-format.js";

export { sanitizePdfText } from "./text.js";

export { invoiceT, invoiceMessages } from "./i18n.js";
export type { InvoiceTranslator, InvoiceMessages } from "./i18n.js";

// The pure arithmetic and format helpers the generator page needs to compute
// an invoice's totals in the browser. The server's e-invoice code imports the
// same functions (through its own re-export shims), so there is one copy.
export * from "./totals.js";
export * from "./format.js";
