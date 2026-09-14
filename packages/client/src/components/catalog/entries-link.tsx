"use client";

import * as React from "react";
import Link from "next/link";
import { Table2 } from "lucide-react";

import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { entriesHref, type EntriesLinkTarget } from "@/lib/entry-links";
import type { DateRange } from "@/components/date-range-picker";
import { useT } from "@/i18n/use-t";
import { cn } from "@/lib/utils";

export type EntriesLinkProps = {
  target: EntriesLinkTarget;
  range: DateRange;
  /** Names the row, e.g. `Acme` — used to build the link's own label. */
  label: string;
  children: React.ReactNode;
  className?: string;
  testId?: string;
};

/**
 * A roll-up figure that doubles as the way into the entries behind it.
 *
 * The number and the log are the same fact at two zoom levels, so the cell
 * showing "40h tracked" is the most direct place to ask "which forty hours?".
 * Rendered as a real link, so it opens in a new tab like any other.
 */
export function EntriesLink({
  target,
  range,
  label,
  children,
  className,
  testId,
}: EntriesLinkProps): React.JSX.Element {
  const t = useT("catalog");
  return (
    <Link
      href={entriesHref(target, range)}
      className={cn(
        "rounded underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
      title={t("entriesLink.title", { name: label })}
      data-testid={testId}
    >
      {children}
    </Link>
  );
}

/**
 * The same destination as a menu item, because a number that happens to be a
 * link is discoverable only by hovering it. Rows people scan and rows people
 * act on are not the same rows.
 */
export function ShowEntriesItem({
  target,
  range,
  testId,
}: {
  target: EntriesLinkTarget;
  range: DateRange;
  testId?: string;
}): React.JSX.Element {
  const t = useT("catalog");
  return (
    <DropdownMenuItem asChild data-testid={testId}>
      <Link href={entriesHref(target, range)}>
        <Table2 className="size-4" />
        {t("entriesLink.menuItem")}
      </Link>
    </DropdownMenuItem>
  );
}
