import { GuidePage, guideMetadata } from "@/components/marketing/pages/guide-page";

export const metadata = guideMetadata("en", "studios");

export default function Page(): React.ReactElement {
  return <GuidePage locale="en" slug="studios" />;
}
