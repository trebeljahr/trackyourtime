import type { Metadata } from "next";

import { ExtensionPage, extensionMetadata } from "@/components/marketing/pages/extension-page";

/**
 * English build of /extension/ — the page itself lives in
 * components/marketing/pages/extension-page.tsx and is shared by every locale.
 */
export const metadata: Metadata = extensionMetadata("en");

export default function Page(): React.ReactElement {
  return <ExtensionPage locale="en" />;
}
