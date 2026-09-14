import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
} from "react";
import { useT } from "../i18n/use-t";

/**
 * A searchable picker that can also create what you were searching for.
 *
 * A plain `<select>` is fine for five projects and useless for eighty, and it
 * cannot offer "make this one" — which is the whole point here: reaching for a
 * project that does not exist yet is the ordinary case at the start of a piece
 * of work, and being sent to the web app to create it defeats a toolbar
 * button.
 *
 * Deliberately not a listbox that steals the whole popup: it renders inline and
 * closes on blur, because at 380px an overlay covering the timer is worse than
 * a list that pushes the button down a little.
 */

export type ComboboxOption = {
  id: string;
  label: string;
  /** Optional colour dot, matching how the web app shows projects and clients. */
  color?: string;
  /** Secondary line, e.g. a project's client. */
  hint?: string;
};

export type ComboboxProps = {
  label: string;
  options: ComboboxOption[];
  value: string | null;
  onChange: (id: string | null) => void;
  /** Shown as the "nothing selected" choice. Omit to make a choice required. */
  emptyLabel?: string;
  placeholder?: string;
  disabled?: boolean;
  disabledHint?: string;
  /** When given, offers "Create <query>" for a query that matches nothing. */
  onCreate?: (name: string) => Promise<void>;
  createLabel?: (name: string) => string;
  testId?: string;
};

const normalize = (value: string): string => value.trim().toLowerCase();

export function Combobox({
  label,
  options,
  value,
  onChange,
  emptyLabel,
  placeholder,
  disabled = false,
  disabledHint,
  onCreate,
  createLabel,
  testId,
}: ComboboxProps): JSX.Element {
  const t = useT("popup");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [creating, setCreating] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [flipped, setFlipped] = useState(false);
  const listId = useId();

  const selected = options.find((option) => option.id === value) ?? null;

  const matches = useMemo(() => {
    const needle = normalize(query);
    if (needle === "") return options;
    return options.filter((option) => normalize(option.label).includes(needle));
  }, [options, query]);

  // "Create X" only when X is genuinely new — offering it next to an exact
  // match invites duplicates the server would reject anyway.
  const trimmed = query.trim();
  const canCreate =
    onCreate !== undefined &&
    trimmed !== "" &&
    !options.some((option) => normalize(option.label) === normalize(trimmed));

  const rows: Array<{ kind: "empty" | "option" | "create"; option?: ComboboxOption }> =
    [
      ...(emptyLabel !== undefined && normalize(query) === ""
        ? [{ kind: "empty" as const }]
        : []),
      ...matches.map((option) => ({ kind: "option" as const, option })),
      ...(canCreate ? [{ kind: "create" as const }] : []),
    ];

  useEffect(() => {
    if (!open) return;
    const onDocumentClick = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocumentClick);
    return () => document.removeEventListener("mousedown", onDocumentClick);
  }, [open]);

  // Clamp rather than reset: the active row should survive typing that only
  // narrows the list, or every keystroke would throw the highlight back to top.
  useEffect(() => {
    setActive((current) => Math.min(current, Math.max(0, rows.length - 1)));
  }, [rows.length]);

  /**
   * Open upward when the list would run off the bottom of the popup.
   *
   * Chrome clips an extension popup instead of growing it, so a dropdown that
   * does not flip is simply unreachable — and the settings screen and the entry
   * form both put pickers far lower in the page than the tracker ever did.
   *
   * Measured only while the list is still hanging downward: once flipped, its
   * own rect no longer answers "would this clip below", and re-reading it would
   * flip the list back on the next render, forever.
   */
  useEffect(() => {
    if (!open) {
      setFlipped(false);
      return;
    }
    const list = listRef.current;
    if (list === null) return;
    setFlipped(
      (current) =>
        current ||
        list.getBoundingClientRect().bottom >
          document.documentElement.clientHeight,
    );
  }, [open, rows.length]);

  const close = (): void => {
    setOpen(false);
    setQuery("");
  };

  const choose = async (index: number): Promise<void> => {
    const row = rows[index];
    if (!row) return;

    if (row.kind === "empty") {
      onChange(null);
      close();
      return;
    }
    if (row.kind === "option" && row.option) {
      onChange(row.option.id);
      close();
      return;
    }
    if (row.kind === "create" && onCreate) {
      setCreating(true);
      try {
        // The parent creates it and re-renders with the new option selected;
        // guessing an id here would desync the moment the server disagrees.
        await onCreate(trimmed);
        close();
      } finally {
        setCreating(false);
      }
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActive((current) => Math.min(current + 1, rows.length - 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((current) => Math.max(current - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      // Never let this reach the surrounding form: Enter in the picker means
      // "choose", not "start the timer with whatever is selected so far".
      event.preventDefault();
      event.stopPropagation();
      if (open) void choose(active);
      else setOpen(true);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  };

  if (disabled) {
    return (
      <div className="field">
        <span className="field__label">{label}</span>
        <p className="combobox__disabled" data-testid={testId && `${testId}-disabled`}>
          {disabledHint ?? t("combobox.notAvailable")}
        </p>
      </div>
    );
  }

  return (
    <div className="field" ref={rootRef}>
      <label className="field__label" htmlFor={`${listId}-input`}>
        {label}
      </label>

      <div className="combobox">
        <input
          id={`${listId}-input`}
          className="input"
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          autoComplete="off"
          placeholder={selected?.label ?? placeholder ?? emptyLabel ?? t("combobox.search")}
          value={open ? query : (selected?.label ?? "")}
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
          disabled={creating}
          data-testid={testId}
        />

        {open && (
          <ul
            ref={listRef}
            className={
              flipped ? "combobox__list combobox__list--up" : "combobox__list"
            }
            id={listId}
            role="listbox"
          >
            {rows.length === 0 && (
              <li className="combobox__none">{t("combobox.noMatches")}</li>
            )}
            {rows.map((row, index) => {
              const isActive = index === active;
              const key =
                row.kind === "option" ? (row.option?.id ?? "option") : row.kind;
              return (
                <li key={key}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    className={
                      isActive
                        ? "combobox__row combobox__row--active"
                        : "combobox__row"
                    }
                    // mousedown, not click: the input's blur would close the
                    // list before a click ever landed.
                    onMouseDown={(event) => {
                      event.preventDefault();
                      void choose(index);
                    }}
                    onMouseEnter={() => setActive(index)}
                  >
                    {row.kind === "empty" && (
                      <span className="combobox__muted">{emptyLabel}</span>
                    )}
                    {row.kind === "option" && row.option && (
                      <>
                        {row.option.color !== undefined && (
                          <span
                            className="project__dot"
                            style={{ backgroundColor: row.option.color }}
                          />
                        )}
                        <span className="combobox__label">{row.option.label}</span>
                        {row.option.hint !== undefined && (
                          <span className="combobox__hint">{row.option.hint}</span>
                        )}
                      </>
                    )}
                    {row.kind === "create" && (
                      <span className="combobox__create">
                        {creating
                          ? t("actions.creating")
                          : createLabel !== undefined
                            ? createLabel(trimmed)
                            : t("combobox.create", { name: trimmed })}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
