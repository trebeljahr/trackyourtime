import type { Metadata } from "next";

import { SupportPage, supportMetadata } from "@/components/marketing/pages/support-page";

/**
 * English build of /support/ — the page itself lives in
 * components/marketing/pages/support-page.tsx and is shared by every locale.
 */
export const metadata: Metadata = supportMetadata("en");

export default function Page(): React.ReactElement {
  return <SupportPage locale="en" />;
}
