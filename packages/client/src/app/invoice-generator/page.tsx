import type { Metadata } from "next";

import {
  InvoiceGeneratorPage,
  invoiceGeneratorMetadata,
} from "@/components/marketing/pages/invoice-generator-page";

/**
 * English build of /invoice-generator/ — the page itself lives in
 * components/marketing/pages/invoice-generator-page.tsx and is shared by
 * every locale.
 */
export const metadata: Metadata = invoiceGeneratorMetadata("en");

export default function Page(): React.ReactElement {
  return <InvoiceGeneratorPage locale="en" />;
}
