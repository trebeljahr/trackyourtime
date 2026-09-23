"use client";

import * as React from "react";
import { currencyIcon, currencySymbol } from "@/lib/currency";
import { useFormatSettings } from "@/lib/format";

export type BillableGlyphProps = {
  billable: boolean;
};

/**
 * The billable affordance — the workspace currency's symbol, struck through
 * when the entry is not billable. Shown in the tracker bar and on every entry
 * row, so it follows the currency setting rather than hardcoding one symbol.
 */
export function BillableGlyph({
  billable,
}: BillableGlyphProps): React.JSX.Element {
  const { currency } = useFormatSettings();
  const Icon = currencyIcon(currency);
  const tone = billable
    ? "text-primary"
    : "text-muted-foreground opacity-60";

  return (
    <span className="relative inline-flex items-center justify-center">
      {Icon ? (
        // Not a component created during render: `currencyIcon` is a lookup in
        // a module-level table of lucide icons, so the identity is stable per
        // currency code and this never remounts.
        // eslint-disable-next-line react-hooks/static-components
        <Icon className={tone} />
      ) : (
        // Codes lucide has no icon for — "kr", "zł". Sized to the icon box but
        // free to grow, since those symbols are two characters wide.
        <span
          className={`inline-flex h-4 min-w-4 items-center justify-center text-xs font-medium leading-none tracking-tight ${tone}`}
        >
          {currencySymbol(currency)}
        </span>
      )}
      {billable ? null : (
        <span
          aria-hidden="true"
          className="absolute h-px w-5 rotate-45 bg-muted-foreground"
        />
      )}
    </span>
  );
}
