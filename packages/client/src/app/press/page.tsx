import type { Metadata } from "next";

import { PressPage, pressMetadata } from "@/components/marketing/pages/press-page";

/**
 * English build of /press/ — the page itself lives in
 * components/marketing/pages/press-page.tsx and is shared by every locale.
 */
export const metadata: Metadata = pressMetadata("en");

export default function Page(): React.ReactElement {
  return <PressPage locale="en" />;
}
