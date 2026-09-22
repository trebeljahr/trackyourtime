import type { Metadata } from "next";

import { invoiceGeneratorMetadata } from "@/components/marketing/pages/invoice-generator-meta";
import { InvoiceGeneratorPage } from "@/components/marketing/pages/invoice-generator-page";

/**
 * German build of /de/rechnung-erstellen/ — the page itself lives in
 * components/marketing/pages/invoice-generator-page.tsx (a Client Component)
 * and its metadata in the sibling invoice-generator-meta.ts. The German slug
 * differs from the English one; the pairing is in i18n/marketing.ts.
 */
export const metadata: Metadata = invoiceGeneratorMetadata("de");

export default function Page(): React.ReactElement {
  return <InvoiceGeneratorPage locale="de" />;
}
