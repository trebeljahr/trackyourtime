import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { CATALOG_COLORS } from "@starter/shared";
import { useT } from "../i18n/use-t";
import type {
  ClientPatch,
  ProjectDetails,
  ProjectPatch,
  TagPatch,
  TaskPatch,
} from "../lib/messaging";

/**
 * Editing the catalog from inside the pickers: rename a project, move it to
 * another client, recolour a tag — without leaving the popup for the web app.
 *
 * A context rather than four more props on every screen: the pickers sit in
 * five screens, and each of those already threads four create callbacks down
 * to them. With no provider (a test rendering one picker) the edit buttons are
 * simply not drawn, which is the honest answer when nothing can save.
 */
export type CatalogEdit = {
  createProject: (
    name: string,
    clientId: string | null,
    details: ProjectDetails,
  ) => Promise<boolean>;
  updateClient: (id: string, patch: ClientPatch) => Promise<boolean>;
  updateProject: (id: string, patch: ProjectPatch) => Promise<boolean>;
  updateTask: (id: string, patch: TaskPatch) => Promise<boolean>;
  updateTag: (id: string, patch: TagPatch) => Promise<boolean>;
};

const CatalogEditContext = createContext<CatalogEdit | null>(null);

export function CatalogEditProvider({
  value,
  children,
}: {
  value: CatalogEdit;
  children: ReactNode;
}): JSX.Element {
  return (
    <CatalogEditContext.Provider value={value}>{children}</CatalogEditContext.Provider>
  );
}

export const useCatalogEdit = (): CatalogEdit | null => useContext(CatalogEditContext);

/**
 * The fields of `next` that differ from `before`, and nothing else.
 *
 * Load-bearing, not tidiness: a member who cannot see colleagues' money reads
 * every project's `hourlyRate` as `null`, so a form that sent its whole state
 * back would clear a rate that person was never shown.
 */
export const changedFields = <T extends Record<string, unknown>>(
  before: T,
  next: T,
): Partial<T> => {
  const patch: Partial<T> = {};
  for (const key of Object.keys(next) as Array<keyof T>) {
    if (next[key] !== before[key]) patch[key] = next[key];
  }
  return patch;
};

/**
 * An hourly rate as typed: empty is "no rate of its own" (`null`), anything
 * else must be a number of 0 or more. A comma is what a German keyboard types
 * for a decimal point, whatever language the popup is in.
 */
export const parseRate = (raw: string): number | null | "invalid" => {
  const normalized = raw.trim().replace(",", ".");
  if (normalized === "") return null;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) return "invalid";
  return Math.round(parsed * 100) / 100;
};

/** The palette every client offers, so a colour picked here has a name there. */
export function ColorSwatches({
  value,
  onChange,
  testId,
}: {
  value: string | null;
  onChange: (hex: string) => void;
  testId: string;
}): JSX.Element {
  const t = useT("popup");
  return (
    <div className="swatches" role="radiogroup" aria-label={t("catalogEdit.color")}>
      {CATALOG_COLORS.map((color) => {
        const selected = value?.toLowerCase() === color.hex;
        return (
          <button
            key={color.hex}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={color.name}
            title={color.name}
            className={selected ? "swatch swatch--selected" : "swatch"}
            style={{ backgroundColor: color.hex }}
            onClick={() => onChange(color.hex)}
            data-testid={`${testId}-${color.hex.slice(1)}`}
          />
        );
      })}
    </div>
  );
}

/**
 * Enter saves and Escape cancels, and neither reaches the surrounding form —
 * Enter there means "start the timer", Escape means "go back a screen".
 */
export const panelKeys =
  (onSave: () => void, onCancel: () => void) =>
  (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      onSave();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    }
  };

export type NamedRow = { id: string; name: string; color?: string };

/**
 * Rename (and, where the row has one, recolour) a client, task or tag — or,
 * with `create`, name a new one.
 *
 * Replaces the picker it was opened from, like the new-project panel: at 380px
 * there is no room beside it.
 */
export function RenamePanel({
  title,
  row,
  onSave,
  onClose,
  create = false,
  testId,
}: {
  title: string;
  /** For a create, the typed name and whether the row takes a colour. */
  row: NamedRow;
  create?: boolean;
  onSave: (patch: { name?: string; color?: string }) => Promise<boolean>;
  onClose: () => void;
  testId: string;
}): JSX.Element {
  const t = useT("popup");
  const [name, setName] = useState(row.name);
  const [color, setColor] = useState(row.color);
  const [saving, setSaving] = useState(false);

  const save = async (): Promise<void> => {
    if (name.trim() === "") return;
    const patch = create
      ? { name: name.trim() }
      : changedFields({ name: row.name, color: row.color }, { name: name.trim(), color });
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    setSaving(true);
    const ok = await onSave(patch);
    setSaving(false);
    // Left open on failure: the banner says why, and closing would throw away
    // what was typed.
    if (ok) onClose();
  };

  return (
    <div className="panel" data-testid={testId}>
      <p className="panel__title">{title}</p>
      <div className="panel__fields">
        <input
          className="input"
          type="text"
          value={name}
          aria-label={t("catalogEdit.name")}
          autoFocus
          onChange={(event) => setName(event.target.value)}
          onKeyDown={panelKeys(() => void save(), onClose)}
          data-testid={`${testId}-name`}
        />
        {row.color !== undefined && (
          <ColorSwatches
            value={color ?? null}
            onChange={setColor}
            testId={`${testId}-color`}
          />
        )}
      </div>
      <PanelActions
        saving={saving}
        canSave={name.trim() !== ""}
        onCancel={onClose}
        onSave={() => void save()}
        create={create}
        testId={testId}
      />
    </div>
  );
}

export function PanelActions({
  saving,
  canSave,
  onCancel,
  onSave,
  create = false,
  testId,
}: {
  saving: boolean;
  canSave: boolean;
  onCancel: () => void;
  onSave: () => void;
  create?: boolean;
  testId: string;
}): JSX.Element {
  const t = useT("popup");
  const idle = create ? t("actions.create") : t("actions.save");
  const busy = create ? t("actions.creating") : t("actions.saving");
  return (
    <div className="panel__actions">
      <button
        className="button"
        type="button"
        onClick={onCancel}
        disabled={saving}
        data-testid={`${testId}-cancel`}
      >
        {t("actions.cancel")}
      </button>
      <button
        className="button button--primary"
        type="button"
        onClick={onSave}
        disabled={saving || !canSave}
        data-testid={`${testId}-${create ? "create" : "save"}`}
      >
        {saving ? busy : idle}
      </button>
    </div>
  );
}

/**
 * Which pickers have a panel open, as one answer.
 *
 * The screens around the pickers have a submit button, and pressing it while
 * any panel is open would start or save an entry against a project, task or
 * tag the user is still describing. Three pickers can each have one open at
 * once, so a single boolean per screen would let one closing panel unlock the
 * submit while another is still open.
 */
export function useOpenPanels(onAnyChange?: (any: boolean) => void): {
  any: boolean;
  track: (key: string) => (open: boolean) => void;
} {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const any = open.size > 0;

  const report = useRef(onAnyChange);
  report.current = onAnyChange;
  useEffect(() => {
    report.current?.(any);
  }, [any]);

  return {
    any,
    track: (key) => (isOpen) =>
      setOpen((current) => {
        if (current.has(key) === isOpen) return current;
        const next = new Set(current);
        if (isOpen) next.add(key);
        else next.delete(key);
        return next;
      }),
  };
}
