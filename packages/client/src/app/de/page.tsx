import type { Metadata } from "next";

import { LandingPage, landingMetadata } from "@/components/marketing/pages/landing-page";

/**
 * German build of /de/ — the page itself lives in
 * components/marketing/pages/landing-page.tsx and is shared by every locale.
 */
export const metadata: Metadata = landingMetadata("de");

export default function Page(): React.ReactElement {
  return <LandingPage locale="de" />;
}
