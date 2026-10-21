import { GuidePage, guideMetadata } from "@/components/marketing/pages/guide-page";

export const metadata = guideMetadata("de", "time-reports");

export default function Page(): React.ReactElement {
  return <GuidePage locale="de" slug="time-reports" />;
}
