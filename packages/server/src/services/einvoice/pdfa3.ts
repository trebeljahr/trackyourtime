/**
 * The ZUGFeRD / Factur-X hybrid: the invoice PDF as PDF/A-3b with the CII XML
 * embedded as `factur-x.xml`.
 *
 * It is the plain renderer (`renderInvoicePdf`) with a variant, not a second
 * drawing: the variant switches the document to PDF/A-3b and PDF 1.7, registers
 * the embedded Noto Sans faces under the font names every draw call already
 * uses, and before `end()` attaches the XML and writes the XMP.
 *
 * `xml` is passed in and never built here, so a stored issued XML is re-wrapped
 * byte for byte. Nothing here touches the database or mutates its argument.
 */
import { recipientLegalName } from "@starter/shared";
import { safeFilenamePart } from "./format.js";
import { FACTURX_XMP } from "./constants.js";
import { coverInvoiceText } from "./glyph-coverage.js";
import type { EinvoiceReadyInvoice } from "./validate.js";
import {
  documentIdXmp,
  documentUuid,
  dublinCoreXmp,
  FACTURX_EXTENSION_SCHEMA_XMP,
  facturxPropertiesXmp,
} from "./xmp.js";
import {
  INVOICE_PDF_FONT_NAMES,
  renderInvoicePdf,
  type InvoicePdfMeta,
} from "../invoice-pdf.js";
import { loadPdfFonts } from "../pdf-fonts.js";

declare global {
  // pdfkit 0.20 supports the PDF/A-3 associated-file relationship
  // (`/AFRelationship`, pushed to the catalog's `/AF`); @types/pdfkit does not
  // declare the option yet.
  namespace PDFKit.Mixins {
    interface PDFAttachmentOptions {
      relationship?: "Alternative" | "Data" | "Source" | "Supplement" | "Unspecified";
    }
  }
}

export type ZugferdPdfMeta = InvoicePdfMeta;

/** ASCII constant: pdfkit writes Creator and Producer into XMP unescaped. */
const PRODUCER = "Track Your Time";

/**
 * PDF/A-3b rendering of the invoice with `xml` embedded as factur-x.xml
 * (/AFRelationship /Alternative, XMP per FACTURX_XMP, embedded fonts).
 */
export async function renderZugferdPdf(
  invoice: EinvoiceReadyInvoice,
  xml: string,
  meta: ZugferdPdfMeta,
): Promise<Buffer> {
  const fonts = loadPdfFonts();
  // The drawn copy only: a glyph the font lacks would draw .notdef, which
  // PDF/A forbids. The XML and the XMP keep the real text.
  const drawn = coverInvoiceText(invoice, fonts.hasGlyph);
  const createdAt = new Date(meta.generatedAt);
  if (Number.isNaN(createdAt.getTime())) {
    throw new RangeError(`renderZugferdPdf: invalid generatedAt ${meta.generatedAt}`);
  }
  const xmlBytes = Buffer.from(xml, "utf8");

  return renderInvoicePdf(drawn, meta, {
    documentOptions: {
      subset: "PDF/A-3b",
      // pdfkit's default 1.3 writes no /Metadata stream at all.
      pdfVersion: "1.7",
      // No default font. pdfkit's constructor would otherwise load the
      // standard-14 Helvetica, and the cache entry it leaves under that name
      // would win over the registered Noto face. Loading Noto here instead is no
      // better: pdfkit then never caches the registered alias and re-parses the
      // TTF on every font() call (seconds per invoice). The first draw selects a
      // registered name.
      font: "",
      lang: invoice.locale === "de" ? "de-DE" : "en",
      info: { Creator: PRODUCER, Producer: PRODUCER, CreationDate: createdAt },
    },
    prepare(doc) {
      doc.registerFont(INVOICE_PDF_FONT_NAMES.regular, fonts.regular);
      doc.registerFont(INVOICE_PDF_FONT_NAMES.bold, fonts.bold);
    },
    finish(doc) {
      // pdfkit writes these into XMP unescaped, and PDF/A's Info↔XMP
      // equivalence binds only the keys that exist. The escaped dc: block
      // below carries title, creator and description instead.
      delete doc.info.Title;
      delete doc.info.Author;
      delete doc.info.Subject;
      delete doc.info.Keywords;
      delete doc.info.ModDate;
      doc.info.Creator = PRODUCER;
      doc.info.Producer = PRODUCER;

      doc.file(xmlBytes, {
        name: FACTURX_XMP.documentFileName,
        type: "text/xml",
        relationship: "Alternative",
        description: "Factur-X/ZUGFeRD invoice, EN 16931 profile",
        creationDate: createdAt,
        modifiedDate: createdAt,
      });

      doc.appendXML(
        dublinCoreXmp({
          title: `Invoice ${invoice.number}`,
          creator: invoice.issuer.legalName ?? "",
          description: `Invoice ${invoice.number} to ${recipientLegalName(invoice.recipient)}`,
        }),
      );
      doc.appendXML(FACTURX_EXTENSION_SCHEMA_XMP);
      doc.appendXML(facturxPropertiesXmp());
      doc.appendXML(documentIdXmp(documentUuid(invoice.id, xmlBytes)));
    },
  });
}

/** "invoice-<sanitised number>-zugferd.pdf" */
export function zugferdPdfFilename(invoiceNumber: string): string {
  return `invoice-${safeFilenamePart(invoiceNumber)}-zugferd.pdf`;
}
