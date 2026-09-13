import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * The tracktime mark.
 *
 * Inlined rather than an `<img src="/brand/mark-tile.svg">` so it paints with
 * the first render instead of after a second request — it sits in the sidebar
 * header, which is above the fold on every screen.
 *
 * Kept in step with `public/brand/mark-tile.svg`, `src/app/icon.svg`, and the
 * bitmaps `pnpm run icons:brand` derives from the same file for the browser
 * extension, Raycast, desktop and mobile. Change one, change all of them —
 * the point of the mark is that the pinned toolbar button, the menu bar item
 * and this header are recognisably one app.
 *
 * The tile variant rather than the bare timer arc: the arc's track ring is a
 * neutral grey that needs a page background to read against, and the mark
 * appears here at 20px next to the wordmark, where the indigo ground is what
 * makes it legible at all.
 */
export function BrandMark({
  className,
  label = "Track Your Time",
}: {
  className?: string;
  /**
   * Pass `null` where the mark sits next to the name "Track Your Time" already —
   * the lockup, say. Two accessible names for one logo makes a screen reader
   * announce the app twice.
   */
  label?: string | null;
}): React.ReactElement {
  return (
    <svg
      viewBox="0 0 64 64"
      className={cn("size-5 shrink-0", className)}
      {...(label === null
        ? { "aria-hidden": true }
        : { role: "img", "aria-label": label })}
    >
      <rect width="64" height="64" rx="14" fill="#4F46E5" />
      <circle
        cx="32"
        cy="32"
        r="19"
        fill="none"
        stroke="#FFFFFF"
        strokeOpacity="0.32"
        strokeWidth="7"
      />
      <path
        d="M32 13A19 19 0 1 1 15.55 41.5"
        fill="none"
        stroke="#FFFFFF"
        strokeWidth="7"
        strokeLinecap="round"
      />
      <circle cx="32" cy="32" r="4.5" fill="#FFFFFF" />
    </svg>
  );
}
