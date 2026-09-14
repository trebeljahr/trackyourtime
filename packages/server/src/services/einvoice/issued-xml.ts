// Which XML an export uses: the one stored at first issue, or a fresh one.
//
// The first export of a non-draft invoice stores its XML per profile, and every
// later export serves those bytes — a future serializer change must never alter
// a document already in the buyer's system. A stored XML is served even if the
// invoice went back to draft. Its content cannot have changed: `status` is the
// only field an edit reaches, and the one other write to an issued invoice —
// the e-invoice fill — is refused once an XML exists in either profile
// (routers/invoice-einvoice.ts). Pure; the router does the conditional write.
import type { InvoiceStatus } from "@starter/shared";
import type { IssuedXmlDoc } from "../../models/einvoice-schemas.js";

export type IssuedXmlDecision =
  | { kind: "stored"; xml: string }
  | { kind: "generate"; persist: boolean };

export function decideIssuedXml(
  status: InvoiceStatus,
  stored: IssuedXmlDoc | null | undefined,
): IssuedXmlDecision {
  if (stored && typeof stored.xml === "string" && stored.xml.length > 0) {
    return { kind: "stored", xml: stored.xml };
  }
  return { kind: "generate", persist: status !== "draft" };
}
