import * as React from "react";

import { BrandMark } from "@/components/brand-mark";
import { cn } from "@/lib/utils";

/**
 * The mark plus the wordmark, for the pages that have no app chrome around
 * them to say what this is — sign-in, sign-up, password reset.
 *
 * The wordmark is real HTML text, not the SVG `<text>` that
 * `public/brand/logo-lockup.svg` uses. That file has to carry its own type
 * because it is consumed standalone (a README, an email); in the app there is
 * a font stack and a type scale already, and using them means the wordmark
 * matches the headings beside it, hinting and all, and stays selectable and
 * searchable. So the SVG asset and this component are two renderings of one
 * lockup rather than one importing the other.
 *
 * "time" takes the brand indigo via `--brand`, which lifts to #818CF8 in dark
 * mode exactly as the SVG assets do. Not `--primary`: that token is a neutral
 * in this palette.
 */
export function BrandLockup({
  className,
}: {
  className?: string;
}): React.ReactElement {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      {/* Decorative: the wordmark right next to it is the accessible name. */}
      <BrandMark label={null} className="size-9" />
      <span className="text-3xl font-semibold tracking-tight">
        Track Your <span className="text-brand">Time</span>
      </span>
    </span>
  );
}
