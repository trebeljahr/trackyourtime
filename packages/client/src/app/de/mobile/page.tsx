import type { Metadata } from "next";

import { MobilePage, mobileMetadata } from "@/components/marketing/pages/mobile-page";

/**
 * German build of /de/mobile/ — the page itself lives in
 * components/marketing/pages/mobile-page.tsx and is shared by every locale.
 */
export const metadata: Metadata = mobileMetadata("de");

export default function Page(): React.ReactElement {
  return <MobilePage locale="de" />;
}
