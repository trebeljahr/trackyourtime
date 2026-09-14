"use client";

import * as React from "react";
import { withTags, type EntryFields } from "@starter/core";

import { ProjectTaskPicker } from "@/components/entry-fields/project-task-picker";
import { TagPicker } from "@/components/tags/tag-picker";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/i18n/use-t";
import { cn } from "@/lib/utils";

/**
 * Which of the five to render.
 *
 * Every surface that creates or edits an entry offers all of them; the option
 * exists for the one place that renders a field itself for a reason — the
 * calendar popover puts billable next to the duration it decides — not as a
 * per-screen preference about which affordances a user gets.
 */
export type EntryFieldName =
  | "description"
  | "projectTask"
  | "tags"
  | "billable";

const ALL_FIELDS: readonly EntryFieldName[] = [
  "description",
  "projectTask",
  "tags",
  "billable",
];

export type EntryFieldsEditorProps = {
  value: EntryFields;
  /**
   * `patch` holds exactly what changed, in the shape `entries.update` takes —
   * so a surface that writes as you go can forward it untouched, and one that
   * buffers until Save can ignore it and send `value`.
   */
  onChange: (next: EntryFields, patch: Partial<EntryFields>) => void;
  fields?: readonly EntryFieldName[];
  disabled?: boolean;
  autoFocus?: boolean;
  descriptionPlaceholder?: string;
  /** Blur or Enter on the description — where write-through surfaces commit. */
  onDescriptionCommit?: () => void;
  /** Enter in the description, for dialogs whose primary action it triggers. */
  onSubmit?: () => void;
  /** Prefixes `id`/`htmlFor`, so several editors can share one page. */
  idPrefix: string;
  testIdPrefix: string;
  className?: string;
};

/**
 * Every affordance an entry has, in one place.
 *
 * Description, project, client, task, tags and billable are what an entry IS,
 * and they used to be assembled by hand on each surface that creates or edits
 * one — with a different subset missing on each. The calendar could not tag or
 * set a task; the entry dialog had no task either; changing a project from a
 * row failed outright when the entry carried a task. None of those were
 * decisions, they were omissions, and they stay fixed only because there is
 * now one place to fix them.
 *
 * Controlled, and layout-only: it owns no state and performs no writes. Which
 * changes reach the server, and when, stays with the caller — a row writes
 * through on every change, a dialog waits for Save, and the tracker bar does
 * one or the other depending on whether a timer is running.
 */
export function EntryFieldsEditor({
  value,
  onChange,
  fields = ALL_FIELDS,
  disabled = false,
  autoFocus = false,
  descriptionPlaceholder,
  onDescriptionCommit,
  onSubmit,
  idPrefix,
  testIdPrefix,
  className,
}: EntryFieldsEditorProps): React.JSX.Element {
  const t = useT("tracker");
  const tc = useT("common");
  const shows = (field: EntryFieldName): boolean => fields.includes(field);

  return (
    <div
      className={cn("space-y-4", className)}
      data-testid={`${testIdPrefix}-fields`}
    >
      {shows("description") ? (
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-description`}>{tc("fields.description")}</Label>
          <Input
            id={`${idPrefix}-description`}
            value={value.description}
            autoFocus={autoFocus}
            disabled={disabled}
            placeholder={
              descriptionPlaceholder ?? t("entryFields.descriptionPlaceholder")
            }
            onChange={(event) => {
              const description = event.target.value;
              onChange({ ...value, description }, { description });
            }}
            onBlur={onDescriptionCommit}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              onDescriptionCommit?.();
              onSubmit?.();
            }}
            data-testid={`${testIdPrefix}-description`}
          />
        </div>
      ) : null}

      {shows("projectTask") ? (
        <ProjectTaskPicker
          value={value}
          onChange={onChange}
          disabled={disabled}
          labelled
          testIdPrefix={testIdPrefix}
        />
      ) : null}

      {shows("tags") ? (
        <div className="space-y-2">
          <Label>{tc("fields.tags")}</Label>
          <TagPicker
            value={value.tagIds}
            onChange={(tagIds) => onChange(withTags(value, tagIds), { tagIds })}
            disabled={disabled}
            variant="count"
            maxChips={4}
            className="w-full"
            testId={`${testIdPrefix}-tags`}
          />
        </div>
      ) : null}

      {shows("billable") ? (
        <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
          <Label htmlFor={`${idPrefix}-billable`}>{tc("fields.billable")}</Label>
          <Switch
            id={`${idPrefix}-billable`}
            checked={value.billable}
            disabled={disabled}
            onCheckedChange={(billable) =>
              onChange({ ...value, billable }, { billable })
            }
            data-testid={`${testIdPrefix}-billable`}
          />
        </div>
      ) : null}
    </div>
  );
}
