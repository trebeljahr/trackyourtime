import { GuidePage, guideMetadata } from "@/components/marketing/pages/guide-page";

export const metadata = guideMetadata("de", "self-hosting");

export default function Page(): React.ReactElement {
  return <GuidePage locale="de" slug="self-hosting" />;
}
