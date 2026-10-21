import { GuidePage, guideMetadata } from "@/components/marketing/pages/guide-page";

export const metadata = guideMetadata("en", "guides/offline-phone");

export default function Page(): React.ReactElement {
  return <GuidePage locale="en" slug="guides/offline-phone" />;
}
