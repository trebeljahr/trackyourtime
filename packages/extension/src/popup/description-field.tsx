import {
  useEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
} from "react";
import type { DescriptionSuggestion } from "@starter/core";
import { useT } from "../i18n/use-t";
import { quickHint } from "./entry-format";

/**
 * The description input, with what you have called work before hanging under
 * it.
 *
 * One component rather than three, because all three surfaces that name an
 * entry — the tracker's composer, the manual create form and the entry editor
 * — need the same behaviours, and they are fiddly enough that a second copy
 * drifts: commit when the field is left rather than on every keystroke, revert
 * on Escape without the blur it causes saving the abandoned text, and now the
 * suggestion list.
 *
 * Controlled, deliberately. Each caller already owns when its text may be
 * replaced — the tracker re-seeds only when the running timer's identity
 * changes, the entry form when a different entry is loaded — and a second copy
 * of the text in here would need the same rule written a second time, where it
 * could disagree.
 *
 * Not built out of {@link Combobox}. That control's value IS one of its
 * options and its input is a search box for them; this one's value is free
 * text that a list merely offers to complete. Bending one into the other would
 * mean a picker that has to accept anything typed into it, which is most of
 * what a picker does removed.
 */

export type DescriptionFieldProps = {
  /** DOM id — the label is rendered here, so it has to be unique per screen. */
  id: string;
  label: string;
  /** The text on screen. The caller owns it. */
  value: string;
  /**
   * The last settled value: what Escape restores, and what a commit is
   * compared against so leaving an untouched field writes nothing.
   */
  committed: string;
  placeholder: string;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Suggestions from the worker, and the query they answer. */
  suggestions: DescriptionSuggestion[];
  suggestionsFor: string | null;
  /** Asks the worker for suggestions matching a query. Debounced in here. */
  onSearch: (query: string) => void;
  onType: (next: string) => void;
  /** A settled value: blur, Enter, or a suggestion taken. Already trimmed. */
  onCommit: (next: string) => void;
  /**
   * A suggestion taken WITH the project, task, tags and billable flag of the
   * newest entry that carried it. Omit to offer the description alone.
   */
  onFill?: (suggestion: DescriptionSuggestion) => void;
  testId: string;
};

/**
 * How long typing settles before the worker is asked.
 *
 * A request per keystroke would put a round trip behind every letter of a
 * sentence somebody is in the middle of writing, and the answers would arrive
 * for prefixes already abandoned.
 */
const SEARCH_DEBOUNCE_MS = 180;

/** Nothing is highlighted, so Enter still belongs to the surrounding form. */
const NONE = -1;

/** True when taking this suggestion would bring more than its name. */
const carriesFields = (suggestion: DescriptionSuggestion): boolean =>
  suggestion.projectId !== null ||
  suggestion.taskId !== null ||
  suggestion.tagIds.length > 0 ||
  suggestion.billable;

export function DescriptionField({
  id,
  label,
  value,
  committed,
  placeholder,
  disabled = false,
  autoFocus = false,
  suggestions,
  suggestionsFor,
  onSearch,
  onType,
  onCommit,
  onFill,
  testId,
}: DescriptionFieldProps): JSX.Element {
  const t = useT("popup");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(NONE);

  /**
   * Set for the length of an Escape, and read by the blur it causes.
   *
   * `blur()` dispatches React's `onBlur` synchronously inside the key handler,
   * before the state change above it has been applied — so without this the
   * commit runs against the abandoned text and Escape SAVES the edit it was
   * pressed to throw away.
   */
  const reverting = useRef(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Only rows that answer what is in the field are offered. Typing outruns the
  // round trip, so a list left over from two letters ago would otherwise be
  // presented as though it described the current word.
  const rows = suggestionsFor === value.trim() ? suggestions : [];

  const search = (query: string): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      onSearch(query);
    }, SEARCH_DEBOUNCE_MS);
  };

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  useEffect(() => {
    if (!open) return;
    const onDocumentClick = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocumentClick);
    return () => document.removeEventListener("mousedown", onDocumentClick);
  }, [open]);

  // Clamped rather than reset, so narrowing the list by typing does not throw
  // the highlight away — and never promoted out of NONE, which is what keeps
  // Enter meaning "start the timer" until a row is deliberately chosen.
  useEffect(() => {
    setActive((current) => Math.min(current, rows.length - 1));
  }, [rows.length]);

  const type = (next: string): void => {
    onType(next);
    setOpen(true);
    search(next);
  };

  const commit = (): void => {
    if (reverting.current) {
      reverting.current = false;
      return;
    }
    const next = value.trim();
    if (next === committed) return;
    onCommit(next);
  };

  /** Take a suggestion's name, and optionally everything else it carries. */
  const take = (
    suggestion: DescriptionSuggestion,
    withFields: boolean,
  ): void => {
    setOpen(false);
    setActive(NONE);
    onType(suggestion.description);
    if (withFields && onFill !== undefined) {
      // One call, not a commit followed by a fill: the two would be two
      // separate writes, and the second would be built from a value the first
      // had already replaced.
      onFill(suggestion);
      return;
    }
    onCommit(suggestion.description);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    const chosen = active === NONE ? null : (rows[active] ?? null);

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActive((current) => Math.min(current + 1, rows.length - 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((current) => Math.max(current - 1, NONE));
      return;
    }
    if (event.key === "Tab") {
      // Tab completes. With nothing highlighted it takes the top row, which is
      // the "finish the word for me" gesture; the default is deliberately NOT
      // prevented, so focus still moves on to the next field afterwards.
      const target = chosen ?? (open ? (rows[0] ?? null) : null);
      if (target === null) {
        setOpen(false);
        return;
      }
      take(target, false);
      return;
    }
    if (event.key === "Enter") {
      // With nothing highlighted this belongs to the surrounding form — on the
      // tracker, Enter starts the timer, and stealing that would cost more
      // than any completion is worth.
      if (chosen === null) {
        setOpen(false);
        commit();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      take(chosen, (event.metaKey || event.ctrlKey) && onFill !== undefined);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      // The list first: closing it is what the user meant if it is what is in
      // the way, and throwing the typing away as well would be two undos for
      // one keystroke.
      if (open) {
        setOpen(false);
        setActive(NONE);
        return;
      }
      reverting.current = true;
      onType(committed);
      event.currentTarget.blur();
    }
  };

  const listId = `${id}-suggestions`;
  const showList = open && rows.length > 0;

  return (
    <div className="field" ref={rootRef}>
      <label className="field__label" htmlFor={id}>
        {label}
      </label>

      <div className="suggest">
        <input
          id={id}
          className="input"
          type="text"
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={
            active === NONE ? undefined : `${listId}-${active}`
          }
          autoComplete="off"
          autoFocus={autoFocus}
          placeholder={placeholder}
          value={value}
          disabled={disabled}
          onFocus={() => {
            // Asked for on focus as well as while typing, so an empty field
            // offers the last few things you worked on rather than nothing.
            setOpen(true);
            search(value);
          }}
          onChange={(event) => type(event.target.value)}
          // Saved when the field is left — typing must not fire a mutation per
          // keystroke.
          onBlur={commit}
          onKeyDown={onKeyDown}
          data-testid={testId}
        />

        {showList && (
          <ul className="suggest__list" id={listId} role="listbox">
            {rows.map((suggestion, index) => {
              const hint = quickHint(suggestion, t);
              const isActive = index === active;
              return (
                <li key={suggestion.lastEntryId} className="suggest__item">
                  <button
                    id={`${listId}-${index}`}
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    className={
                      isActive
                        ? "suggest__row suggest__row--active"
                        : "suggest__row"
                    }
                    // mousedown, not click: the input's blur would close the
                    // list before a click ever landed.
                    onMouseDown={(event) => {
                      event.preventDefault();
                      take(suggestion, false);
                    }}
                    onMouseEnter={() => setActive(index)}
                    title={suggestion.description}
                    data-testid={`${testId}-suggestion`}
                  >
                    <span
                      className="suggest__dot"
                      style={
                        suggestion.projectColor === null
                          ? undefined
                          : { backgroundColor: suggestion.projectColor }
                      }
                    />
                    <span className="suggest__text">
                      <span className="suggest__label">
                        {suggestion.description}
                      </span>
                      {hint === null ? null : (
                        <span className="suggest__hint">{hint}</span>
                      )}
                    </span>
                  </button>

                  {onFill !== undefined && carriesFields(suggestion) ? (
                    <button
                      type="button"
                      className="suggest__fill"
                      title={t("description.fillTitle", {
                        description: suggestion.description,
                      })}
                      aria-label={t("description.fillLabel", {
                        description: suggestion.description,
                      })}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        take(suggestion, true);
                      }}
                      data-testid={`${testId}-fill`}
                    >
                      ＋
                    </button>
                  ) : null}
                </li>
              );
            })}

            <li className="suggest__legend" aria-hidden="true">
              {onFill === undefined
                ? t("description.legend")
                : t("description.legendWithFill")}
            </li>
          </ul>
        )}
      </div>
    </div>
  );
}
