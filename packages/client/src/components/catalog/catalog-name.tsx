"use client";

import * as React from "react";
import { Pencil } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { useT } from "@/i18n/use-t";
import { cn } from "@/lib/utils";

/** The colour swatch every catalog row leads with. */
export function ColorDot({
  color,
  className,
}: {
  color: string | null | undefined;
  className?: string;
}): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cn("size-2.5 shrink-0 rounded-full", className)}
      style={{ backgroundColor: color ?? "hsl(var(--muted-foreground))" }}
    />
  );
}

export type CatalogNameProps = {
  name: string;
  /** Omitted for rows that carry no colour of their own, such as tasks. */
  color?: string | null;
  /** Opens this row's edit dialog. */
  onEdit: () => void;
  /** Appends an "Archived" badge, as the tables did before. */
  archived?: boolean;
  /** Struck through, for a completed task. */
  done?: boolean;
  /** What the button announces, e.g. `Edit client "Acme"`. */
  editLabel: string;
  className?: string;
  /** Overrides the name's own weight, for a secondary cell. */
  nameClassName?: string;
  /** Goes on the name itself, so text assertions keep matching the name. */
  nameTestId?: string;
  testId?: string;
};

/**
 * A catalog row's dot and name, as the way to edit it.
 *
 * The row menu still carries Edit, but reaching for a menu to fix a typo or a
 * colour is three interactions for a one-word change — and the name is what
 * the eye is already on. The pencil only appears on hover or focus, so a table
 * of twenty rows is not twenty icons; the button itself is always there, which
 * is what keyboard and screen-reader users navigate by.
 */
export function CatalogName({
  name,
  color,
  onEdit,
  archived = false,
  done = false,
  editLabel,
  className,
  nameClassName = "font-medium",
  nameTestId,
  testId,
}: CatalogNameProps): React.JSX.Element {
  const tc = useT("common");
  return (
    <button
      type="button"
      className={cn(
        "group/name flex min-w-0 items-center gap-2 rounded px-1 py-0.5 text-left",
        "-mx-1 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
      aria-label={editLabel}
      title={editLabel}
      onClick={onEdit}
      data-testid={testId}
    >
      {color === undefined ? null : <ColorDot color={color} />}
      <span
        className={cn(
          "truncate",
          nameClassName,
          done && "text-muted-foreground line-through",
        )}
        data-testid={nameTestId}
      >
        {name}
      </span>
      {archived ? (
        <Badge variant="outline" className="shrink-0">
          {tc("status.archived")}
        </Badge>
      ) : null}
      <Pencil
        aria-hidden="true"
        className="size-3 shrink-0 opacity-0 transition-opacity group-hover/name:opacity-60 group-focus-visible/name:opacity-60"
      />
    </button>
  );
}
