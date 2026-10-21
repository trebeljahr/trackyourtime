import { GuidePage, guideMetadata } from "@/components/marketing/pages/guide-page";

export const metadata = guideMetadata("de", "import-csv");

export default function Page(): React.ReactElement {
  return <GuidePage locale="de" slug="import-csv" />;
}
