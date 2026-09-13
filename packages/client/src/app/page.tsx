import type { Metadata } from "next";

import { LandingPage, landingMetadata } from "@/components/marketing/pages/landing-page";

/**
 * English build of / — the page itself lives in
 * components/marketing/pages/landing-page.tsx and is shared by every locale.
 */
export const metadata: Metadata = landingMetadata("en");

export default function Page(): React.ReactElement {
  return <LandingPage locale="en" />;
}
