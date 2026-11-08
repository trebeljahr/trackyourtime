/**
 * The ZUGFeRD / Factur-X PDF on the server: the package's renderer
 * (`@starter/invoice-pdf/einvoice/zugferd`) with the Noto faces read from
 * `assets/fonts`, and the bytes wrapped in a Buffer as every server caller
 * expects. An encrypted workspace's browser calls the same renderer with the
 * same files fetched from the web app.
 */
import { renderZugferdPdf as renderWithFonts, type ZugferdPdfMeta } from "@starter/invoice-pdf/einvoice/zugferd";
import type { EinvoiceReadyInvoice } from "@starter/invoice-pdf/einvoice/validate";
import { loadPdfFonts } from "../pdf-fonts.js";

export { zugferdPdfFilename, type ZugferdPdfMeta } from "@starter/invoice-pdf/einvoice/zugferd";

export async function renderZugferdPdf(
  invoice: EinvoiceReadyInvoice,
  xml: string,
  meta: ZugferdPdfMeta,
): Promise<Buffer> {
  const fonts = loadPdfFonts();
  const bytes = await renderWithFonts(invoice, xml, meta, fonts, Buffer.from(xml, "utf8"));
  return Buffer.from(bytes);
}
