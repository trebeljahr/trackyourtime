import type { Metadata } from "next";

import { invoiceGeneratorMetadata } from "@/components/marketing/pages/invoice-generator-meta";
import { InvoiceGeneratorPage } from "@/components/marketing/pages/invoice-generator-page";

/**
 * English build of /invoice-generator/ — the page itself lives in
 * components/marketing/pages/invoice-generator-page.tsx (a Client Component)
 * and its metadata in the sibling invoice-generator-meta.ts.
 */
export const metadata: Metadata = invoiceGeneratorMetadata("en");

export default function Page(): React.ReactElement {
  return <InvoiceGeneratorPage locale="en" />;
}
