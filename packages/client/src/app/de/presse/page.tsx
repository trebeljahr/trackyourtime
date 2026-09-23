import type { Metadata } from "next";

import { PressPage, pressMetadata } from "@/components/marketing/pages/press-page";

/**
 * German build of /de/presse/ — the page itself lives in
 * components/marketing/pages/press-page.tsx and is shared by every locale.
 * The German slug is mapped in i18n/marketing.ts's LOCALIZED_SLUGS.
 */
export const metadata: Metadata = pressMetadata("de");

export default function Page(): React.ReactElement {
  return <PressPage locale="de" />;
}
