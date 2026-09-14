// Fixed identifiers of the EN 16931 CII output. One place, so the XML
// serializer, the PDF/A-3 wrapper and the stored-XML record cannot disagree.
import type { EinvoiceProfile } from "@starter/shared";

/** BT-24 for a ZUGFeRD / Factur-X EN 16931 document. */
export const EN16931_GUIDELINE_ID = "urn:cen.eu:en16931:2017";

/** BT-24 for XRechnung 3.0. */
export const XRECHNUNG_GUIDELINE_ID =
  "urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0";

/** BT-24 by profile. This is the only line in which the two outputs differ. */
export const GUIDELINE_IDS: Readonly<Record<EinvoiceProfile, string>> = {
  en16931: EN16931_GUIDELINE_ID,
  xrechnung: XRECHNUNG_GUIDELINE_ID,
};

/** BT-23, emitted for both profiles. */
export const BUSINESS_PROCESS_ID = "urn:fdc:peppol.eu:2017:poacc:billing:01:1.0";

/** BT-3: commercial invoice. Credit notes (381) are out of scope. */
export const INVOICE_TYPE_CODE = "380";

/** BT-81: SEPA credit transfer. */
export const PAYMENT_MEANS_CREDIT_TRANSFER = "58";

/** Unit of BT-129 / BT-130: hours. */
export const HOURS_UNIT_CODE = "HUR";

/** The Factur-X XMP extension values and the attachment name. */
export const FACTURX_XMP = {
  documentFileName: "factur-x.xml",
  documentType: "INVOICE",
  version: "1.0",
  conformanceLevel: "EN 16931",
} as const;

/**
 * Written with every stored XML so a later reader knows which serializer
 * produced it. Bump on any change to the output bytes.
 */
export const EINVOICE_GENERATOR = "track-your-time-cii/1";
