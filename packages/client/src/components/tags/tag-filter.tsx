"use client";

import * as React from "react";

import {
  MultiSelect,
  type MultiSelectOption,
} from "@/components/reports/multi-select";
import { TagFormDialog } from "@/components/tags/tag-manager";
import { pickableTags } from "@/components/tags/tag-picker";
import { tagById, useTags, type TagRow } from "@/components/tags/use-tags";
import { useT } from "@/i18n/use-t";

export type TagFilterProps = {
  /** Selected tag ids; empty means "no tag filter", not "untagged only". */
  value: string[];
  onChange: (ids: string[]) => void;
  className?: string;
  testId?: string;
};

/**
 * Filters BY tag in the reports filter bar — the read-side counterpart of
 * `TagPicker`. Selecting several tags is an OR ("entries carrying any of
 * these"), matching `ReportFilters.tagIds` on the server.
 *
 * It also creates and edits tags, through the same `TagFormDialog` the tag
 * manager uses — a filter list is where you notice a tag is misnamed, and
 * sending the user to Settings to fix it loses the report they were reading.
 */
export function TagFilter({
  value,
  onChange,
  className = "w-[9.5rem]",
  testId = "filter-tags",
}: TagFilterProps): React.JSX.Element {
  const t = useT("catalog");
  const tc = useT("common");
  const { allTags } = useTags({ includeArchived: true });

  // An archived tag still labels historical time, so it has to stay filterable
  // once it is part of the URL — otherwise a shared report link silently drops
  // its own filter. Archived tags that are NOT selected stay out of the list.
  const options = React.useMemo<MultiSelectOption[]>(
    () =>
      pickableTags(allTags, value).map((tag) => ({
        value: tag.id,
        label: tag.name,
        color: tag.color,
      })),
    [allTags, value]
  );

  const [editing, setEditing] = React.useState<TagRow | null>(null);
  const [dialogOpen, setDialogOpen] = React.useState(false);

  return (
    <>
      <MultiSelect
        label={tc("fields.tags")}
        options={options}
        value={value}
        onChange={onChange}
        emptyText={t("tags.filter.empty")}
        searchPlaceholder={t("tags.filter.search")}
        className={className}
        testId={testId}
        editLabel={t("tags.filter.edit")}
        onEditOption={(option) => {
          setEditing(tagById(allTags, option.value));
          setDialogOpen(true);
        }}
        footerActions={[
          {
            label: t("tags.filter.new"),
            onSelect: () => {
              setEditing(null);
              setDialogOpen(true);
            },
            testId: `${testId}-new`,
          },
        ]}
      />

      <TagFormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        tag={editing}
      />
    </>
  );
}
