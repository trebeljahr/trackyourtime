import { ChangelogPage, changelogMetadata } from "@/components/marketing/pages/changelog-page";

export const metadata = changelogMetadata("de");

export default function Page(): React.ReactElement {
  return <ChangelogPage locale="de" />;
}
