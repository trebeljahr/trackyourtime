import { GuidePage, guideMetadata } from "@/components/marketing/pages/guide-page";

export const metadata = guideMetadata("en", "import-csv");

export default function Page(): React.ReactElement {
  return <GuidePage locale="en" slug="import-csv" />;
}
