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
  /**
   * When given, every option carries an edit button that calls this with its
   * id. The picker closes first: the caller replaces it with an edit panel.
   */
  onEdit?: (id: string) => void;
  /** Accessible name of an option's edit button. */
  editLabel?: (label: string) => string;
  /**
   * When given, the unfiltered list ends with this row ("New project…").
   *
   * "Create X" only appears after typing a name that matches nothing, so on
   * an empty workspace there was no visible way to make anything at all — the
   * same reason the web app's pickers carry one.
   */
  onNew?: () => void;
  newLabel?: string;
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
  onEdit,
  editLabel,
  onNew,
  newLabel,
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

  const rows: Array<{
    kind: "empty" | "option" | "create" | "new";
    option?: ComboboxOption;
  }> = [
    ...(emptyLabel !== undefined && normalize(query) === ""
      ? [{ kind: "empty" as const }]
      : []),
    ...matches.map((option) => ({ kind: "option" as const, option })),
    ...(canCreate ? [{ kind: "create" as const }] : []),
    // Only while nothing is typed: with a query, "Create X" is the same
    // action already, and two rows for it would read as two different things.
    ...(onNew !== undefined && trimmed === "" ? [{ kind: "new" as const }] : []),
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
    if (row.kind === "new" && onNew) {
      close();
      onNew();
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
      return;
    }
    // ⌘E / Ctrl+E edits the highlighted row, so the pencil is not
    // mouse-only. The pencil itself stays out of the tab order: tabbing
    // through a pencil per row would make leaving the list take eighty stops.
    if (event.key === "e" && (event.metaKey || event.ctrlKey) && open) {
      const row = rows[active];
      if (row?.kind !== "option" || !row.option || onEdit === undefined) return;
      event.preventDefault();
      close();
      onEdit(row.option.id);
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
                <li
                  key={key}
                  className={onEdit !== undefined ? "combobox__item" : undefined}
                >
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
                    {row.kind === "new" && (
                      <span className="combobox__create">{newLabel}</span>
                    )}
                  </button>
                  {row.kind === "option" && row.option && onEdit !== undefined && (
                    <EditButton
                      option={row.option}
                      label={
                        editLabel !== undefined
                          ? editLabel(row.option.label)
                          : t("combobox.edit", { name: row.option.label })
                      }
                      onEdit={(id) => {
                        close();
                        onEdit(id);
                      }}
                      testId={testId && `${testId}-pencil-${row.option.id}`}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * A pencil beside an option. A sibling of the row's button, never inside it:
 * a button in a button is invalid HTML, and the click would also choose.
 */
function EditButton({
  option,
  label,
  onEdit,
  testId,
}: {
  option: ComboboxOption;
  label: string;
  onEdit: (id: string) => void;
  testId?: string;
}): JSX.Element {
  return (
    <button
      type="button"
      className="combobox__edit"
      aria-label={label}
      title={label}
      tabIndex={-1}
      // mousedown for the same reason as the row: the input's blur would
      // otherwise close the list before the click landed.
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onEdit(option.id);
      }}
      data-testid={testId}
    >
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
        <path
          d="M11.3 2.3a1 1 0 0 1 1.4 0l1 1a1 1 0 0 1 0 1.4L6 12.4 3 13l.6-3z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
