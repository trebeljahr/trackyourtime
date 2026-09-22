import type { Metadata } from "next";

import {
  InvoiceGeneratorPage,
  invoiceGeneratorMetadata,
} from "@/components/marketing/pages/invoice-generator-page";

/**
 * German build of /de/rechnung-erstellen/ — the page itself lives in
 * components/marketing/pages/invoice-generator-page.tsx and is shared by
 * every locale. The German slug differs from the English one; the pairing is
 * in i18n/marketing.ts (LOCALIZED_SLUGS).
 */
export const metadata: Metadata = invoiceGeneratorMetadata("de");

export default function Page(): React.ReactElement {
  return <InvoiceGeneratorPage locale="de" />;
}
