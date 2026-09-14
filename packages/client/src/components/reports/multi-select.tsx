"use client";

import * as React from "react";
import { Check, ChevronsUpDown, Pencil, Plus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { useT } from "@/i18n/use-t";
import { cn } from "@/lib/utils";

export type MultiSelectOption = {
  value: string;
  label: string;
  /** Optional swatch - project/client colours. */
  color?: string | null;
  /** Options sharing a group render under one heading. */
  group?: string | null;
  keywords?: string[];
};

/** A row pinned to the bottom of the list — normally "New client…". */
export type MultiSelectFooterAction = {
  label: string;
  onSelect: () => void;
  testId?: string;
};

export type MultiSelectProps = {
  options: MultiSelectOption[];
  value: string[];
  onChange: (values: string[]) => void;
  /** Shown on the trigger when nothing is selected, e.g. "Projects". */
  label: string;
  emptyText?: string;
  searchPlaceholder?: string;
  disabled?: boolean;
  /** Pinned rows below the options, always visible regardless of the search. */
  footerActions?: MultiSelectFooterAction[];
  /**
   * When supplied, each row carries a pencil that edits that option instead of
   * toggling it. The popover closes first, so the dialog it opens is not
   * fighting the popover for focus.
   */
  onEditOption?: (option: MultiSelectOption) => void;
  /** Accessible name for the pencil, e.g. "Edit client". */
  editLabel?: string;
  className?: string;
  testId: string;
};

type OptionGroup = { heading: string | null; options: MultiSelectOption[] };

const groupOptions = (options: MultiSelectOption[]): OptionGroup[] => {
  const groups: OptionGroup[] = [];
  const byHeading = new Map<string, OptionGroup>();

  for (const option of options) {
    const heading = option.group ?? null;
    const key = heading ?? " ungrouped";
    const existing = byHeading.get(key);
    if (existing) {
      existing.options.push(option);
      continue;
    }
    const created: OptionGroup = { heading, options: [option] };
    byHeading.set(key, created);
    groups.push(created);
  }

  return groups;
};

/**
 * Checkbox list in a popover - the filter-bar counterpart to `Combobox`,
 * which only ever holds one value. Selecting never closes the popover, so a
 * user can tick several projects in one pass.
 */
export function MultiSelect({
  options,
  value,
  onChange,
  label,
  emptyText,
  searchPlaceholder,
  disabled = false,
  footerActions,
  onEditOption,
  editLabel,
  className,
  testId,
}: MultiSelectProps): React.JSX.Element {
  const t = useT("reports");
  const tc = useT("common");
  const [open, setOpen] = React.useState(false);

  const selected = React.useMemo(() => new Set(value), [value]);
  const groups = React.useMemo(() => groupOptions(options), [options]);

  const selectedLabel = React.useMemo(() => {
    if (value.length === 0) return label;
    if (value.length === 1) {
      const match = options.find((option) => option.value === value[0]);
      return match?.label ?? tc("counts.selected", { count: "1" });
    }
    return label;
  }, [label, options, value, tc]);

  // Ids are opaque Mongo ids; scoring them would produce phantom matches on
  // hex-looking queries, so only the human-readable keywords are scored.
  const filter = React.useCallback(
    (_value: string, search: string, keywords?: string[]): number => {
      if (search.length === 0) return 1;
      const haystack = (keywords ?? []).join(" ").toLowerCase();
      return haystack.includes(search.toLowerCase()) ? 1 : 0;
    },
    []
  );

  const toggle = React.useCallback(
    (id: string): void => {
      onChange(
        selected.has(id)
          ? value.filter((existing) => existing !== id)
          : [...value, id]
      );
    },
    [onChange, selected, value]
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn("justify-between gap-2 font-normal", className)}
          data-testid={testId}
        >
          <span className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                "truncate",
                value.length === 0 && "text-muted-foreground"
              )}
              title={selectedLabel}
            >
              {selectedLabel}
            </span>
            {value.length > 1 ? (
              <Badge variant="secondary" className="shrink-0 px-1.5 py-0">
                {value.length}
              </Badge>
            ) : null}
          </span>
          <ChevronsUpDown className="ml-1 size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-64 p-0"
        data-testid={`${testId}-content`}
      >
        <Command filter={filter} loop>
          <CommandInput
            placeholder={searchPlaceholder ?? t("multiSelect.search")}
            data-testid={`${testId}-search`}
          />
          <CommandList>
            <CommandEmpty>{emptyText ?? t("multiSelect.noMatches")}</CommandEmpty>
            {groups.map((group) => (
              <CommandGroup
                key={group.heading ?? "__ungrouped"}
                heading={group.heading ?? undefined}
              >
                {group.options.map((option) => {
                  const isSelected = selected.has(option.value);
                  return (
                    <CommandItem
                      key={option.value}
                      value={option.value}
                      keywords={[
                        option.label,
                        ...(group.heading ? [group.heading] : []),
                        ...(option.keywords ?? []),
                      ]}
                      onSelect={() => toggle(option.value)}
                      data-testid={`${testId}-option-${option.value}`}
                      aria-selected={isSelected}
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          "flex size-4 shrink-0 items-center justify-center rounded-sm border border-input",
                          isSelected &&
                            "border-primary bg-primary text-primary-foreground"
                        )}
                      >
                        {isSelected ? <Check className="size-3" /> : null}
                      </span>
                      {option.color !== undefined && option.color !== null ? (
                        <span
                          aria-hidden="true"
                          className="size-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: option.color }}
                        />
                      ) : null}
                      <span className="truncate">{option.label}</span>
                      {onEditOption ? (
                        <button
                          type="button"
                          aria-label={t("multiSelect.editOption", {
                            action: editLabel ?? tc("actions.edit"),
                            name: option.label,
                          })}
                          className="ml-auto shrink-0 rounded-sm p-1 text-muted-foreground opacity-60 hover:bg-accent hover:text-foreground hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          // cmdk selects on pointer down as well as on click,
                          // so both have to be stopped or the pencil would
                          // toggle the filter on its way to the dialog.
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={(event) => {
                            event.stopPropagation();
                            setOpen(false);
                            onEditOption(option);
                          }}
                          data-testid={`${testId}-edit-${option.value}`}
                        >
                          <Pencil className="size-3.5" />
                        </button>
                      ) : null}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))}

            {footerActions && footerActions.length > 0 ? (
              <>
                <CommandSeparator />
                <CommandGroup forceMount>
                  {footerActions.map((action) => (
                    <CommandItem
                      key={action.label}
                      forceMount
                      // A leading NUL keeps the row out of the id namespace the
                      // options use, so a search can never collide with it.
                      value={`\u0000action-${action.label}`}
                      onSelect={() => {
                        setOpen(false);
                        action.onSelect();
                      }}
                      data-testid={action.testId}
                    >
                      <Plus className="size-4" />
                      <span className="truncate">{action.label}</span>
                    </CommandItem>
                  ))}
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
                  {t("multiSelect.clearSelected", { count: value.length })}
                </Button>
              </div>
            </>
          ) : null}
        </Command>
      </PopoverContent>
    </Popover>
  );
}
