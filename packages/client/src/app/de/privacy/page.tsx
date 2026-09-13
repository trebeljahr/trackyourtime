import type { Metadata } from "next";

import { PrivacyPage, privacyMetadata } from "@/components/marketing/pages/privacy-page";

/**
 * German build of /de/privacy/ — the page itself lives in
 * components/marketing/pages/privacy-page.tsx and is shared by every locale.
 */
export const metadata: Metadata = privacyMetadata("de");

export default function Page(): React.ReactElement {
  return <PrivacyPage locale="de" />;
}
