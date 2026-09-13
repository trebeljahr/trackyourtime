import type { Metadata } from "next";

import { RaycastPage, raycastMetadata } from "@/components/marketing/pages/raycast-page";

/**
 * German build of /de/raycast/ — the page itself lives in
 * components/marketing/pages/raycast-page.tsx and is shared by every locale.
 */
export const metadata: Metadata = raycastMetadata("de");

export default function Page(): React.ReactElement {
  return <RaycastPage locale="de" />;
}
