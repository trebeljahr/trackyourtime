"use client";

import * as React from "react";

import { cn } from "@/lib/utils";
import type { TagRow } from "@/components/tags/use-tags";

/** What a chip needs — a subset of `TagRow`, so a bare `Tag` works too. */
export type ChipTag = { id: string; name: string; color: string };

export type TagOverflow = {
  shown: ChipTag[];
  /** How many tags did not fit. Zero means everything is shown. */
  hidden: number;
  /** Names of the hidden tags, for the title attribute. */
  hiddenNames: string[];
};

/**
 * Split a tag list into what fits and what becomes "+N".
 *
 * Pure so the overflow rule is testable without rendering: a row that carries
 * eight tags must not push every other row's controls onto a second line.
 */
export function splitForOverflow(tags: ChipTag[], max: number): TagOverflow {
  if (max <= 0 || tags.length <= max) {
    return { shown: tags, hidden: 0, hiddenNames: [] };
  }
  // One slot is spent on the "+N" chip itself, so showing `max` chips plus a
  // counter would be one wider than asked for.
  const shown = tags.slice(0, Math.max(1, max - 1));
  const rest = tags.slice(shown.length);
  return {
    shown,
    hidden: rest.length,
    hiddenNames: rest.map((tag) => tag.name),
  };
}

export type TagChipsProps = {
  tags: ChipTag[];
  /** Total chip slots, counting the "+N" chip. Zero disables the cap. */
  max?: number;
  /** Dims archived tags in the manager; the tracker never passes it. */
  className?: string;
  testId?: string;
};

/**
 * Coloured labels for one entry's tags.
 *
 * Deliberately short: these sit inside an `h-8` row control, so the chip is a
 * 20px pill and the row keeps its height no matter how many tags it carries.
 */
export function TagChips({
  tags,
  max = 0,
  className,
  testId = "tag-chips",
}: TagChipsProps): React.JSX.Element | null {
  const { shown, hidden, hiddenNames } = React.useMemo(
    () => splitForOverflow(tags, max),
    [tags, max],
  );

  if (tags.length === 0) return null;

  return (
    <span
      className={cn("flex min-w-0 items-center gap-1", className)}
      data-testid={testId}
      data-tag-count={tags.length}
    >
      {shown.map((tag) => (
        <span
          key={tag.id}
          title={tag.name}
          // Shrinkable, not `shrink-0`: the entry row's tag column goes down
          // to 5rem and the trigger clips its overflow, so a chip that cannot
          // shrink loses its right edge instead of truncating its name.
          className="flex h-5 min-w-0 max-w-24 items-center gap-1 rounded-full border px-1.5 text-[11px] leading-none"
          style={{
            // 22% alpha over the tag colour reads on both themes without a
            // per-theme palette; the border carries the hue at full strength.
            backgroundColor: `${tag.color}22`,
            borderColor: tag.color,
          }}
          data-testid={`${testId}-${tag.id}`}
        >
          <span className="truncate">{tag.name}</span>
        </span>
      ))}
      {hidden > 0 ? (
        <span
          className="flex h-5 shrink-0 items-center rounded-full border border-border bg-muted px-1.5 text-[11px] leading-none text-muted-foreground"
          title={hiddenNames.join(", ")}
          data-testid={`${testId}-overflow`}
        >
          +{hidden}
        </span>
      ) : null}
    </span>
  );
}

/** `TagChips` fed straight from a resolved catalog — the common call. */
export function tagChipList(tags: TagRow[]): ChipTag[] {
  return tags.map((tag) => ({ id: tag.id, name: tag.name, color: tag.color }));
}
