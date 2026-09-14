"use client";

import * as React from "react";
import { Check, ChevronsUpDown, Plus, X } from "lucide-react";

import { useT } from "@/i18n/use-t";
import { cn } from "@/lib/utils";
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

export interface ComboboxOption {
  /** Stable id written back through `onChange`. */
  value: string;
  label: string;
  /** Optional group heading - options sharing a group render together. */
  group?: string;
  /** Optional swatch colour (any CSS colour, e.g. a project colour). */
  color?: string | null;
  /** Extra text the search should match on. */
  keywords?: string[];
  disabled?: boolean;
}

export interface ComboboxFooterAction {
  label: string;
  onSelect: () => void;
  testId?: string;
}

export interface ComboboxProps
  extends Omit<
    React.ComponentPropsWithoutRef<typeof Button>,
    "value" | "onChange" | "children" | "type"
  > {
  options: ComboboxOption[];
  value: string | null;
  onChange: (value: string | null) => void;
  /** Trigger text when nothing is selected. */
  placeholder?: string;
  /** Shown when the search matches nothing. */
  emptyText?: string;
  /** When supplied, a "Create <query>" row appears for unmatched searches. */
  onCreate?: (name: string) => void;
  /** Label for the create row. Defaults to `Create "<query>"`. */
  createLabel?: (query: string) => string;
  /** Muted hint under the create row, for a shorthand worth advertising. */
  createHint?: string;
  /**
   * Rows pinned to the bottom of the list, always visible regardless of the
   * search query. Use for "New project…"-style actions, which must be
   * discoverable without first typing a name that matches nothing.
   */
  footerActions?: ComboboxFooterAction[];
  searchPlaceholder?: string;
  /** Adds a row that resets the selection to `null`. */
  allowClear?: boolean;
  clearLabel?: string;
  contentClassName?: string;
  align?: "start" | "center" | "end";
  /** Controlled open state (optional). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

interface OptionGroup {
  heading: string | null;
  options: ComboboxOption[];
}

function groupOptions(options: ComboboxOption[]): OptionGroup[] {
  const groups: OptionGroup[] = [];
  const byHeading = new Map<string, OptionGroup>();

  for (const option of options) {
    const heading = option.group ?? null;
    const key = heading ?? "\u0000ungrouped";
    const existing = byHeading.get(key);
    if (existing) {
      existing.options.push(option);
      continue;
    }
    const created: OptionGroup = { heading, options: [option] };
    byHeading.set(key, created);
    groups.push(created);
  }

  // Ungrouped options always sit at the top, matching the usual picker convention.
  return groups.sort((a, b) => {
    if (a.heading === b.heading) return 0;
    if (a.heading === null) return -1;
    if (b.heading === null) return 1;
    return 0;
  });
}

function ColorDot({ color }: { color: string | null }): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="size-2.5 shrink-0 rounded-full border border-border"
      style={color ? { backgroundColor: color, borderColor: color } : undefined}
    />
  );
}

const Combobox = React.forwardRef<HTMLButtonElement, ComboboxProps>(
  (
    {
      options,
      value,
      onChange,
      placeholder,
      emptyText,
      onCreate,
      createLabel,
      createHint,
      footerActions,
      searchPlaceholder,
      allowClear = false,
      clearLabel: clearLabelProp,
      className,
      contentClassName,
      align = "start",
      open: openProp,
      onOpenChange,
      variant = "outline",
      size = "default",
      ...triggerProps
    },
    ref,
  ) => {
    const t = useT("shell");
    const tc = useT("common");
    const clearLabel = clearLabelProp ?? t("ui.combobox.clear");
    const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false);
    const [query, setQuery] = React.useState("");

    const open = openProp ?? uncontrolledOpen;
    const setOpen = React.useCallback(
      (next: boolean): void => {
        if (openProp === undefined) setUncontrolledOpen(next);
        onOpenChange?.(next);
        if (!next) setQuery("");
      },
      [openProp, onOpenChange],
    );

    const selected = React.useMemo(
      () => options.find((option) => option.value === value) ?? null,
      [options, value],
    );

    const groups = React.useMemo(() => groupOptions(options), [options]);

    const trimmedQuery = query.trim();
    const hasExactMatch = React.useMemo(
      () =>
        options.some(
          (option) => option.label.toLowerCase() === trimmedQuery.toLowerCase(),
        ),
      [options, trimmedQuery],
    );
    const showCreate =
      onCreate !== undefined && trimmedQuery.length > 0 && !hasExactMatch;

    // cmdk scores the item `value`, which here is an opaque id - score the
    // human-readable keywords instead so ids never produce phantom matches.
    const filter = React.useCallback(
      (_value: string, search: string, keywords?: string[]): number => {
        if (search.length === 0) return 1;
        const haystack = (keywords ?? []).join(" ").toLowerCase();
        return haystack.includes(search.toLowerCase()) ? 1 : 0;
      },
      [],
    );

    const handleSelect = React.useCallback(
      (next: string): void => {
        onChange(next);
        setOpen(false);
      },
      [onChange, setOpen],
    );

    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            ref={ref}
            variant={variant}
            size={size}
            role="combobox"
            aria-expanded={open}
            className={cn("justify-between font-normal", className)}
            {...triggerProps}
          >
            <span className="flex min-w-0 items-center gap-2">
              {selected?.color ? <ColorDot color={selected.color} /> : null}
              <span
                className={cn(
                  "truncate",
                  selected === null && "text-muted-foreground",
                )}
              >
                {selected?.label ?? placeholder ?? t("ui.combobox.placeholder")}
              </span>
            </span>
            <ChevronsUpDown className="ml-2 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align={align}
          className={cn(
            "w-[var(--radix-popover-trigger-width)] min-w-56 p-0",
            contentClassName,
          )}
        >
          <Command filter={filter} loop>
            <CommandInput
              value={query}
              onValueChange={setQuery}
              placeholder={searchPlaceholder ?? t("ui.combobox.search")}
              data-testid="combobox-search"
            />
            <CommandList>
              {showCreate ? null : <CommandEmpty>{emptyText ?? tc("status.noResults")}</CommandEmpty>}

              {allowClear && (
                // forceMount on the GROUP, not just the item: cmdk hides a
                // whole group when none of its items match the query, and a
                // forceMount on the child does not override that.
                <CommandGroup forceMount>
                  <CommandItem
                    value="\u0000clear"
                    keywords={[clearLabel]}
                    onSelect={() => {
                      onChange(null);
                      setOpen(false);
                    }}
                    data-testid="combobox-clear"
                  >
                    <X className="opacity-60" />
                    <span className="text-muted-foreground">{clearLabel}</span>
                  </CommandItem>
                </CommandGroup>
              )}

              {groups.map((group) => (
                <CommandGroup
                  key={group.heading ?? "__ungrouped"}
                  heading={group.heading ?? undefined}
                >
                  {group.options.map((option) => (
                    <CommandItem
                      key={option.value}
                      value={option.value}
                      keywords={[
                        option.label,
                        ...(group.heading ? [group.heading] : []),
                        ...(option.keywords ?? []),
                      ]}
                      disabled={option.disabled}
                      onSelect={handleSelect}
                      data-testid={`combobox-option-${option.value}`}
                    >
                      {option.color !== undefined ? (
                        <ColorDot color={option.color} />
                      ) : null}
                      <span className="truncate">{option.label}</span>
                      <Check
                        className={cn(
                          "ml-auto",
                          option.value === value ? "opacity-100" : "opacity-0",
                        )}
                      />
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}

              {showCreate && onCreate && (
                <>
                  <CommandSeparator />
                  <CommandGroup forceMount>
                    <CommandItem
                      forceMount
                      value="\u0000create"
                      onSelect={() => {
                        onCreate(trimmedQuery);
                        setOpen(false);
                      }}
                      data-testid="combobox-create"
                    >
                      <Plus />
                      <span className="truncate">
                        {createLabel
                          ? createLabel(trimmedQuery)
                          : t("ui.combobox.create", { query: trimmedQuery })}
                      </span>
                    </CommandItem>
                  </CommandGroup>
                  {/* Outside the group: cmdk hoists a group's non-item
                      children above its item list, which would put the hint
                      above the row it describes. */}
                  {createHint && (
                    <p
                      className="px-3 pb-2 text-xs text-muted-foreground"
                      data-testid="combobox-create-hint"
                    >
                      {createHint}
                    </p>
                  )}
                </>
              )}
              {footerActions && footerActions.length > 0 && (
                <>
                  <CommandSeparator />
                  <CommandGroup forceMount>
                    {footerActions.map((action) => (
                      <CommandItem
                        key={action.label}
                        forceMount
                        value={`\u0000action-${action.label}`}
                        onSelect={() => {
                          setOpen(false);
                          action.onSelect();
                        }}
                        data-testid={action.testId}
                      >
                        <Plus />
                        <span className="truncate">{action.label}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    );
  },
);
Combobox.displayName = "Combobox";

export { Combobox };
