import { ChangelogPage, changelogMetadata } from "@/components/marketing/pages/changelog-page";

export const metadata = changelogMetadata("en");

export default function Page(): React.ReactElement {
  return <ChangelogPage locale="en" />;
}
