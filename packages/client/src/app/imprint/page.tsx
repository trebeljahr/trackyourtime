import type { Metadata } from "next";

import { ImprintPage, imprintMetadata } from "@/components/marketing/pages/imprint-page";

export const metadata: Metadata = imprintMetadata("en");

export default function Page(): React.ReactElement {
  return <ImprintPage locale="en" />;
}
