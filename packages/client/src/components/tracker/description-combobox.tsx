"use client";

import * as React from "react";
import { Plus } from "lucide-react";
import { quickStartHint, type DescriptionSuggestion } from "@starter/core";

import { Input } from "@/components/ui/input";
import { useDescriptionSuggestions } from "@/components/tracker/use-description-suggestions";
import { useT } from "@/i18n/use-t";
import { cn } from "@/lib/utils";

/**
 * The tracker bar's description field, with what you have called work before
 * hanging under it (`entries.descriptions`).
 *
 * The keyboard contract is the one the browser extension and Raycast already
 * teach, and each rule protects something:
 *
 * - Nothing is highlighted until an arrow press, so Enter keeps meaning
 *   "start or stop the timer" — a completion is never worth stealing that.
 * - Tab completes the name only, and does not stop focus moving on.
 * - Cmd/Ctrl+Enter on a highlighted row also takes its project, task, tags and
 *   billable flag. It is the secondary action because overwriting a project
 *   the user already picked is the destructive reading of "complete this".
 * - Escape closes the list first; pressed again it reverts to `committed`
 *   without the blur it causes saving the abandoned text.
 *
 * Controlled: the bar owns when its text may be replaced (only when the
 * running timer's identity changes), and a second copy in here could disagree.
 */

export type DescriptionComboboxProps = {
  value: string;
  onValueChange: (next: string) => void;
  /**
   * The last settled value — the running entry's description, or "" for the
   * composer. What Escape restores.
   */
  committed: string;
  /** A settled value: blur, or a suggestion's name taken. */
  onCommit: (next: string) => void;
  /**
   * Enter with nothing highlighted — the surrounding form's own action. The
   * text has already gone through `onCommit` when this runs.
   */
  onSubmit: () => void;
  /** A suggestion taken WITH its project, task, tags and billable flag. */
  onFill: (suggestion: DescriptionSuggestion) => void;
  autoFocus?: boolean;
  className?: string;
  inputClassName?: string;
  testId?: string;
};

/** Nothing highlighted: Enter still belongs to the bar. */
const NONE = -1;

const carriesFields = (suggestion: DescriptionSuggestion): boolean =>
  suggestion.projectId !== null ||
  suggestion.taskId !== null ||
  suggestion.tagIds.length > 0 ||
  suggestion.billable;

const isMac = (): boolean =>
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export function DescriptionCombobox({
  value,
  onValueChange,
  committed,
  onCommit,
  onSubmit,
  onFill,
  autoFocus = false,
  className,
  inputClassName,
  testId = "tracker-description",
}: DescriptionComboboxProps): React.JSX.Element {
  const t = useT("tracker");
  const [open, setOpen] = React.useState(false);
  const [active, setActive] = React.useState(NONE);
  const listId = React.useId();

  const { rows: answered, rowsFor } = useDescriptionSuggestions(value, open);
  // Only rows that answer what is in the field: typing outruns the round trip,
  // and a list left over from two letters ago would describe a word already
  // moved past.
  const rows = React.useMemo(
    () => (rowsFor === value.trim() ? answered : []),
    [answered, rowsFor, value],
  );
  const showList = open && rows.length > 0;

  // Clamped, never promoted out of NONE: narrowing the list keeps the
  // highlight, and nothing but an arrow press ever sets one.
  const highlighted = active === NONE ? NONE : Math.min(active, rows.length - 1);

  /**
   * Set for the length of an Escape and read by the blur it causes: `blur()`
   * runs `onBlur` synchronously, before the reverted value has rendered, so
   * without this Escape would SAVE the edit it was pressed to throw away.
   */
  const reverting = React.useRef(false);

  /**
   * The last value handed to `onCommit`, so a Tab that takes a suggestion and
   * the blur that follows it write once, not twice. Forgotten whenever the
   * settled value changes underneath.
   */
  const lastCommitted = React.useRef(committed);
  React.useEffect(() => {
    lastCommitted.current = committed;
  }, [committed]);

  const commit = (next: string): void => {
    if (next === lastCommitted.current) return;
    lastCommitted.current = next;
    onCommit(next);
  };

  const close = (): void => {
    setOpen(false);
    setActive(NONE);
  };

  const take = (suggestion: DescriptionSuggestion, withFields: boolean): void => {
    close();
    onValueChange(suggestion.description);
    if (withFields) {
      // One call rather than a commit and then a fill: two writes, the second
      // built from a value the first had already replaced.
      lastCommitted.current = suggestion.description;
      onFill(suggestion);
      return;
    }
    commit(suggestion.description);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    const chosen = highlighted === NONE ? null : (rows[highlighted] ?? null);

    switch (event.key) {
      case "ArrowDown": {
        event.preventDefault();
        setOpen(true);
        // Recorded even while the rows are still loading (or refetching after
        // a timer write invalidated them): the press was deliberate, so the
        // first row lights up the moment it arrives.
        setActive(Math.min(highlighted + 1, Math.max(rows.length - 1, 0)));
        return;
      }
      case "ArrowUp": {
        if (!showList) return;
        event.preventDefault();
        setActive(Math.max(highlighted - 1, NONE));
        return;
      }
      case "Tab": {
        if (event.shiftKey) {
          close();
          return;
        }
        // Completes: the highlighted row, else the top one while the list is
        // on screen. Default not prevented, so focus still moves on.
        const target = chosen ?? (showList ? (rows[0] ?? null) : null);
        if (target === null) {
          close();
          return;
        }
        take(target, false);
        return;
      }
      case "Enter": {
        if (chosen !== null) {
          // Handled here, and kept from the bar's page-wide Cmd/Ctrl+Enter,
          // which would otherwise toggle the timer in the same keystroke.
          event.preventDefault();
          event.stopPropagation();
          take(chosen, event.metaKey || event.ctrlKey);
          return;
        }
        // Cmd/Ctrl+Enter with nothing chosen is the page-wide toggle's.
        if (event.metaKey || event.ctrlKey) return;
        event.preventDefault();
        close();
        commit(value);
        onSubmit();
        return;
      }
      case "Escape": {
        event.preventDefault();
        if (showList) {
          close();
          return;
        }
        reverting.current = true;
        onValueChange(committed);
        event.currentTarget.blur();
        return;
      }
      default:
        return;
    }
  };

  const shortcut = isMac() ? "⌘⏎" : "Ctrl+Enter";

  return (
    <div className={cn("relative", className)} data-testid={`${testId}-field`}>
      <Input
        type="text"
        role="combobox"
        aria-label={t("description.label")}
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          showList && highlighted !== NONE ? `${listId}-${highlighted}` : undefined
        }
        autoComplete="off"
        autoFocus={autoFocus}
        placeholder={t("description.placeholder")}
        value={value}
        className={inputClassName}
        onChange={(event) => {
          onValueChange(event.target.value);
          setOpen(true);
        }}
        // A click asks too, so an empty field offers the last few things you
        // worked on. Not on focus: the field is focused on mount, and a list
        // over the page on every visit to /track is in the way.
        onMouseDown={() => setOpen(true)}
        // The dedupe is for one visit to the field. A commit the bar ignored
        // (typed with nothing running) must not suppress the same text on a
        // later visit, after a timer started with `committed` unchanged.
        onFocus={() => {
          lastCommitted.current = committed;
        }}
        onBlur={() => {
          close();
          if (reverting.current) {
            reverting.current = false;
            return;
          }
          commit(value);
        }}
        onKeyDown={onKeyDown}
        data-testid={testId}
      />

      {showList ? (
        <div
          className="absolute left-0 top-full z-50 mt-1 w-full min-w-72 overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md"
          data-testid={`${testId}-suggestions`}
        >
          <ul id={listId} role="listbox" aria-label={t("description.suggestions")} className="max-h-72 overflow-y-auto p-1">
            {rows.map((suggestion, index) => {
              const hint = quickStartHint(suggestion);
              const isActive = index === highlighted;
              return (
                <li
                  key={suggestion.lastEntryId}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={isActive}
                  className={cn(
                    "flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm",
                    isActive && "bg-accent text-accent-foreground",
                  )}
                  // mousedown, not click: the input's blur would close the
                  // list before a click ever landed.
                  onMouseDown={(event) => {
                    event.preventDefault();
                    take(suggestion, false);
                  }}
                  onMouseEnter={() => setActive(index)}
                  data-testid={`${testId}-suggestion`}
                  data-active={isActive ? "true" : "false"}
                >
                  <span
                    aria-hidden="true"
                    className="size-2.5 shrink-0 rounded-full bg-muted"
                    style={
                      suggestion.projectColor === null
                        ? undefined
                        : { backgroundColor: suggestion.projectColor }
                    }
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{suggestion.description}</span>
                    {hint === null ? null : (
                      <span className="block truncate text-xs text-muted-foreground">
                        {hint}
                      </span>
                    )}
                  </span>
                  {carriesFields(suggestion) ? (
                    <button
                      type="button"
                      tabIndex={-1}
                      className="flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-background hover:text-foreground"
                      title={t("description.fill", { description: suggestion.description })}
                      aria-label={t("description.fill", { description: suggestion.description })}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        take(suggestion, true);
                      }}
                      data-testid={`${testId}-fill`}
                    >
                      <Plus className="size-3.5" />
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <p
            aria-hidden="true"
            className="border-t border-border px-3 py-1.5 text-xs text-muted-foreground"
          >
            {t("description.legend", { shortcut })}
          </p>
        </div>
      ) : null}
    </div>
  );
}
