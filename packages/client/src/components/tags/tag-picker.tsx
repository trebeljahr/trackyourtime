"use client";

import * as React from "react";
import { Check, Plus, Tag as TagIcon, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { translate, useT } from "@/i18n/use-t";
import { cn } from "@/lib/utils";
import { TagChips, tagChipList } from "@/components/tags/tag-chips";
import {
  tagsForIds,
  useTagMutations,
  useTags,
  type TagRow,
} from "@/components/tags/use-tags";

// ── pure selection logic (unit-tested) ───────────────────────────────

/**
 * Mirrors `entryTagIds` in @starter/shared, which caps the array at 20.
 *
 * Enforced here so the 21st pick is refused with a sentence, rather than
 * going out, failing zod validation, and rolling the optimistic change back
 * under a raw schema error.
 */
export const MAX_TAGS_PER_ENTRY = 20;

/** Add or remove one id, preserving the order the user picked them in. */
export function toggleTagId(value: readonly string[], id: string): string[] {
  return value.includes(id)
    ? value.filter((existing) => existing !== id)
    : [...value, id];
}

/**
 * Whether the typed text should offer a "Create" row.
 *
 * An exact name match — case-insensitively, matching the server's unique
 * index collation — offers nothing, because creating it would be refused as a
 * CONFLICT the moment it is clicked.
 */
export function canCreateTag(
  query: string,
  tags: readonly { name: string }[],
): boolean {
  const trimmed = query.trim();
  if (trimmed === "") return false;
  return !tags.some(
    (tag) => tag.name.toLowerCase() === trimmed.toLowerCase(),
  );
}

/**
 * The tags a picker may offer: everything live, plus any archived tag the
 * entry already carries.
 *
 * Archiving a tag retires it from new use without rewriting history, so an
 * archived tag still on this entry has to stay visible and un-tickable-off-able
 * — dropping it from the list would make it impossible to remove.
 */
export function pickableTags(
  all: readonly TagRow[],
  selected: readonly string[],
): TagRow[] {
  const chosen = new Set(selected);
  return all.filter((tag) => !tag.archived || chosen.has(tag.id));
}

// ── component ────────────────────────────────────────────────────────

export type TagPickerProps = {
  /** Currently selected tag ids. */
  value: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  /** `data-testid` for the E2E suite. */
  testId?: string;
  /** "chips" puts the selected tags on the trigger; "count" shows "3 tags". */
  variant?: "chips" | "count";
  /** Chip slots on the trigger before the rest collapse into "+N". */
  maxChips?: number;
  /** Trigger text when nothing is selected. */
  placeholder?: string;
  className?: string;
};

/**
 * Assigns tags TO one entry.
 *
 * Multi-select over the catalog with create-on-type, because the whole value
 * of a tag is being able to coin it at the moment you need it — a detour to a
 * management screen means the label never gets applied. Selecting never closes
 * the popover, so several tags land in one pass.
 */
export function TagPicker({
  value,
  onChange,
  disabled = false,
  testId = "tag-picker",
  variant = "chips",
  maxChips = 3,
  placeholder,
  className,
}: TagPickerProps): React.JSX.Element {
  const t = useT("catalog");
  const tc = useT("common");
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");

  const { allTags } = useTags({ includeArchived: true });
  const { createTag, isSaving } = useTagMutations();

  const options = React.useMemo(
    () => pickableTags(allTags, value),
    [allTags, value],
  );
  const selected = React.useMemo(
    () => tagsForIds(allTags, value),
    [allTags, value],
  );
  const selectedIds = React.useMemo(() => new Set(value), [value]);

  const showCreate = canCreateTag(query, allTags);

  // cmdk scores the item `value`, which here is an opaque id; scoring names
  // instead keeps hex-looking queries from producing phantom matches.
  const filter = React.useCallback(
    (_value: string, search: string, keywords?: string[]): number => {
      if (search.length === 0) return 1;
      const haystack = (keywords ?? []).join(" ").toLowerCase();
      return haystack.includes(search.toLowerCase()) ? 1 : 0;
    },
    [],
  );

  const handleCreate = React.useCallback(async (): Promise<void> => {
    const name = query.trim();
    if (name === "") return;
    if (value.length >= MAX_TAGS_PER_ENTRY) {
      toast.error(
        translate("catalog")("tags.picker.tooMany", { max: MAX_TAGS_PER_ENTRY }),
      );
      return;
    }
    const created = await createTag({ name });
    // A refused create (duplicate name, offline) already surfaced its own
    // message; leaving the query in place lets the user amend it.
    if (created === null) return;
    setQuery("");
    onChange([...value, created.id]);
  }, [createTag, onChange, query, value]);

  const triggerLabel = (): React.ReactNode => {
    if (selected.length === 0) {
      return (
        <span className="text-muted-foreground">
          {placeholder ?? tc("fields.tags")}
        </span>
      );
    }
    if (variant === "count") {
      return (
        <span>{tc("counts.tags", { count: selected.length })}</span>
      );
    }
    return (
      <TagChips
        tags={tagChipList(selected)}
        max={maxChips}
        testId={`${testId}-chips`}
      />
    );
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={tc("fields.tags")}
          disabled={disabled}
          className={cn(
            "justify-start gap-1.5 overflow-hidden font-normal",
            className,
          )}
          data-testid={testId}
          data-tag-count={value.length}
        >
          <TagIcon className="size-4 shrink-0 opacity-60" aria-hidden="true" />
          {triggerLabel()}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-64 p-0"
        data-testid={`${testId}-content`}
      >
        <Command filter={filter} loop>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={t("tags.picker.search")}
            data-testid={`${testId}-search`}
          />
          <CommandList>
            {showCreate ? null : (
              <CommandEmpty>{t("tags.picker.empty")}</CommandEmpty>
            )}

            <CommandGroup>
              {options.map((tag) => {
                const isSelected = selectedIds.has(tag.id);
                return (
                  <CommandItem
                    key={tag.id}
                    value={tag.id}
                    keywords={[tag.name]}
                    onSelect={() => {
                      if (
                        !isSelected &&
                        value.length >= MAX_TAGS_PER_ENTRY
                      ) {
                        toast.error(
                          translate("catalog")("tags.picker.tooMany", {
                            max: MAX_TAGS_PER_ENTRY,
                          }),
                        );
                        return;
                      }
                      onChange(toggleTagId(value, tag.id));
                    }}
                    aria-selected={isSelected}
                    data-testid={`${testId}-option-${tag.id}`}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "flex size-4 shrink-0 items-center justify-center rounded-sm border border-input",
                        isSelected &&
                          "border-primary bg-primary text-primary-foreground",
                      )}
                    >
                      {isSelected ? <Check className="size-3" /> : null}
                    </span>
                    <span
                      aria-hidden="true"
                      className="size-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: tag.color }}
                    />
                    <span className="truncate">{tag.name}</span>
                    {tag.archived ? (
                      <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                        {t("row.archivedMarker")}
                      </span>
                    ) : null}
                  </CommandItem>
                );
              })}
            </CommandGroup>

            {showCreate ? (
              <>
                <CommandSeparator />
                <CommandGroup forceMount>
                  <CommandItem
                    forceMount
                    value=" create-tag"
                    disabled={isSaving}
                    onSelect={() => {
                      void handleCreate();
                    }}
                    data-testid={`${testId}-create`}
                  >
                    <Plus className="size-4" />
                    <span className="truncate">
                      {t("tags.picker.create", { name: query.trim() })}
                    </span>
                  </CommandItem>
                </CommandGroup>
              </>
            ) : null}
          </CommandList>

          {value.length > 0 ? (
            <>
              <CommandSeparator />
              <div className="p-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start font-normal"
                  onClick={() => onChange([])}
                  data-testid={`${testId}-clear`}
                >
                  <X className="size-4" />
                  {t("tags.picker.remove", { count: value.length })}
                </Button>
              </div>
            </>
          ) : null}
        </Command>
      </PopoverContent>
    </Popover>
  );
}
