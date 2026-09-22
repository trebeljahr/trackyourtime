/**
 * The server's invoice PDF entry point.
 *
 * The renderer itself lives in `@starter/invoice-pdf` so it runs in the browser
 * too; it returns a `Uint8Array` and never touches `Buffer`. Here — the one
 * place server code, the tRPC router and the ZUGFeRD variant call it — the
 * bytes are wrapped in a Node `Buffer`, byte for byte, so every existing
 * caller keeps the `Buffer` it had. The invoice bytes are unchanged.
 */
import {
  renderInvoicePdf as renderInvoicePdfBytes,
  type InvoicePdfMeta,
  type InvoicePdfVariant,
  type RenderableInvoice,
} from "@starter/invoice-pdf";

export { invoicePdfFilename, INVOICE_PDF_FONT_NAMES } from "@starter/invoice-pdf";
export type { InvoicePdfMeta, InvoicePdfVariant, RenderableInvoice } from "@starter/invoice-pdf";

/** Render one persisted invoice as a Node `Buffer` (the package returns `Uint8Array`). */
export async function renderInvoicePdf(
  invoice: RenderableInvoice,
  meta: InvoicePdfMeta,
  variant?: InvoicePdfVariant,
): Promise<Buffer> {
  return Buffer.from(await renderInvoicePdfBytes(invoice, meta, variant));
}
