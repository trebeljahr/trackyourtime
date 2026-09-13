import type { Metadata } from "next";

import { MobilePage, mobileMetadata } from "@/components/marketing/pages/mobile-page";

/**
 * English build of /mobile/ — the page itself lives in
 * components/marketing/pages/mobile-page.tsx and is shared by every locale.
 */
export const metadata: Metadata = mobileMetadata("en");

export default function Page(): React.ReactElement {
  return <MobilePage locale="en" />;
}
