import type { Metadata } from "next";

import { DownloadPage, downloadMetadata } from "@/components/marketing/pages/download-page";

/**
 * German build of /de/download/ — the page itself lives in
 * components/marketing/pages/download-page.tsx and is shared by every locale.
 */
export const metadata: Metadata = downloadMetadata("de");

export default function Page(): React.ReactElement {
  return <DownloadPage locale="de" />;
}
