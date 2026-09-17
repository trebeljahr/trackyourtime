import type { Metadata } from "next";

import { DownloadPage, downloadMetadata } from "@/components/marketing/pages/download-page";

/**
 * English build of /download/ — the page itself lives in
 * components/marketing/pages/download-page.tsx and is shared by every locale.
 */
export const metadata: Metadata = downloadMetadata("en");

export default function Page(): React.ReactElement {
  return <DownloadPage locale="en" />;
}
