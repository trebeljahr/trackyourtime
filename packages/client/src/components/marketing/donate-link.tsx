"use client";

import * as React from "react";

import { useIsCapacitor } from "@/hooks/use-shell";
import { recordDonationReturn } from "@/lib/donation-return";
import { DONATE_URL } from "@/lib/site-links";

/**
 * The footer's "Donate" item, a link to the shared donate page on ricos.site.
 *
 * Never inside the iOS or Android app: App Store guideline 3.1.1 and Google
 * Play's payments policy do not allow a link out to a payment there. The page
 * is prerendered in Node, where no shell can be detected, so the served HTML
 * carries the link and `useIsCapacitor` removes it right after hydration.
 * Until then `html.cap [data-marketing]` in native.css keeps the whole public
 * page from painting in the app.
 *
 * Same tab: nothing on a public page is lost by leaving it.
 */
export function DonateLink({ label }: { label: string }): React.ReactElement | null {
  if (useIsCapacitor()) return null;
  return (
    <li>
      <a href={DONATE_URL} className="hover:text-foreground" data-testid="marketing-donate">
        {label}
      </a>
    </li>
  );
}

/** Records a `?supported=1` return from the donate page, once, after mount. */
export function DonationReturn(): null {
  React.useEffect(() => {
    recordDonationReturn(window);
  }, []);
  return null;
}
