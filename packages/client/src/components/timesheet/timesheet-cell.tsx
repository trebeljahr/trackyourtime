"use client";

import * as React from "react";
import Link from "next/link";
import { Timer, Layers, MoveRight, List } from "lucide-react";
import {
  parseTimesheetCell,
  timesheetCellState,
  TIMESHEET_MAX_CELL_SECONDS,
  type DurationFormat,
  type TimesheetCell,
  type DetailedEntry,
} from "@starter/shared";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  PopoverClose,
} from "@/components/ui/popover";
import { useFormat } from "@/i18n/use-format";
import { useT } from "@/i18n/use-t";
import { cn } from "@/lib/utils";
import { isNavKey, type TimesheetNavKey } from "./timesheet-nav";
import { refusalMessageKey } from "./refusal-message";

export type TimesheetBlockActions = {
  entry: (id: string) => DetailedEntry | undefined;
  protection: (id: string) => string | null;
  onEdit: (id: string, testId: string) => void;
  onAdd: (testId: string) => void;
  disabled?: boolean;
};

export type TimesheetCellFieldProps = {
  cell: TimesheetCell;
  /** Announced to screen readers, e.g. "Acme – Design, Wed 4 Feb". */
  label: string;
  durationFormat: DurationFormat;
  duration: (seconds: number) => string;
  clock: (iso: string) => string;
  /** Where the breakdown links to for a cell the grid refuses to edit. */
  detailHref: string;
  disabled?: boolean;
  /** Localized approval/locked-period reason, supplied by the caller. */
  readOnlyReason?: string;
  blocks?: TimesheetBlockActions;
  isToday?: boolean;
  onCommit: (seconds: number) => void;
  onNavigate: (key: TimesheetNavKey) => void;
  testId: string;
};

const cellClasses = (isToday: boolean, empty: boolean): string =>
  cn(
    "mx-auto h-9 w-24 rounded-md text-center font-mono text-sm tabular-nums",
    isToday && "bg-accent/40",
    empty && "text-muted-foreground"
  );

/**
 * One cell of the grid.
 *
 * Which of the two shapes it takes is decided by `timesheetCellState`, not by
 * what happens when the user presses Enter: a cell the grid would refuse to
 * write is rendered read-only WITH its breakdown, so the refusal is visible
 * before anything is typed rather than as an error afterwards.
 */
export function TimesheetCellField({
  cell,
  label,
  durationFormat,
  duration,
  clock,
  detailHref,
  disabled = false,
  readOnlyReason,
  blocks,
  isToday = false,
  onCommit,
  onNavigate,
  testId,
}: TimesheetCellFieldProps): React.JSX.Element {
  const state = timesheetCellState(cell);
  const editable = (state === "empty" || state === "single") && readOnlyReason === undefined;

  if (!editable) {
    return (
      <ReadOnlyCell
        cell={cell}
        label={label}
        duration={duration}
        clock={clock}
        detailHref={detailHref}
        disabled={disabled}
        readOnlyReason={readOnlyReason}
        blocks={blocks}
        isToday={isToday}
        onNavigate={onNavigate}
        testId={testId}
      />
    );
  }

  return (
    <div className="flex items-center justify-center gap-1">
      <EditableCell
        cell={cell}
        label={label}
        durationFormat={durationFormat}
        disabled={disabled}
        isToday={isToday}
        onCommit={onCommit}
        onNavigate={onNavigate}
        testId={testId}
      />
      {blocks !== undefined ? (
        <ReadOnlyCell cell={cell} label={label} duration={duration} clock={clock}
          detailHref={detailHref} disabled={disabled} blocks={blocks}
          onNavigate={onNavigate} testId={testId} secondary />
      ) : null}
    </div>
  );
}

// ── writable ─────────────────────────────────────────────────────────

type EditableCellProps = Pick<
  TimesheetCellFieldProps,
  | "cell"
  | "label"
  | "durationFormat"
  | "disabled"
  | "isToday"
  | "onCommit"
  | "onNavigate"
  | "testId"
>;

function EditableCell({
  cell,
  label,
  durationFormat,
  disabled = false,
  isToday = false,
  onCommit,
  onNavigate,
  testId,
}: EditableCellProps): React.JSX.Element {
  const f = useFormat();
  // Zero is an empty cell, not "0:00:00" — a grid of zeroes is unreadable.
  // Formatted in the reader's locale ("1,50 h"); the parser takes either mark.
  const formatCell = React.useCallback(
    (seconds: number): string =>
      seconds <= 0 ? "" : f.duration(seconds, durationFormat),
    [durationFormat, f]
  );
  const display = formatCell(cell.seconds);

  const [draft, setDraft] = React.useState(display);
  const [editing, setEditing] = React.useState(false);
  const [invalid, setInvalid] = React.useState(false);
  const [lastDisplay, setLastDisplay] = React.useState(display);

  /**
   * Set when a nav key has just committed this cell.
   *
   * Moving focus fires a blur, and a blur that committed again would send the
   * SAME value a second time — against a cell the cache has not caught up with
   * yet, so it reads as a second, identical edit and creates a duplicate entry.
   * Any further typing clears the flag, so a value typed after the move is
   * still committed when the user clicks away.
   */
  const committedByKey = React.useRef(false);

  // A sync event from another device must not overwrite a half-typed cell.
  // Showing one cell stale for a few seconds is far better than eating the
  // keystrokes someone is in the middle of.
  if (lastDisplay !== display) {
    setLastDisplay(display);
    if (!editing) setDraft(display);
  }

  const commit = React.useCallback((): boolean => {
    // Pending writes must not steal keyboard focus from the next cell.
    // Read-only inputs stay traversable, but cannot submit a stale draft.
    if (disabled) return true;
    const parsed = parseTimesheetCell(draft);
    if (parsed === null || parsed > TIMESHEET_MAX_CELL_SECONDS) {
      setInvalid(true);
      setDraft(display);
      return false;
    }
    setInvalid(false);
    setDraft(formatCell(parsed));
    if (parsed !== Math.round(cell.seconds)) onCommit(parsed);
    return true;
  }, [cell.seconds, disabled, display, draft, formatCell, onCommit]);

  /**
   * Left/Right leave the cell only when the caret has nowhere left to go
   * inside it — otherwise they would eat the caret movement people expect
   * while correcting a value. A fully selected value (which is what focus
   * leaves behind) counts as "not yet editing", so arrows work immediately.
   */
  const caretEscapes = (
    element: HTMLInputElement,
    key: "ArrowLeft" | "ArrowRight"
  ): boolean => {
    const { selectionStart, selectionEnd, value } = element;
    if (value === "") return true;
    if (selectionStart === 0 && selectionEnd === value.length) return true;
    return key === "ArrowLeft"
      ? selectionStart === 0 && selectionEnd === 0
      : selectionStart === value.length && selectionEnd === value.length;
  };

  return (
    <Input
      value={draft}
      readOnly={disabled}
      aria-disabled={disabled || undefined}
      spellCheck={false}
      inputMode="decimal"
      autoComplete="off"
      aria-label={label}
      aria-invalid={invalid || undefined}
      className={cn(
        cellClasses(isToday, cell.seconds === 0),
        disabled && "cursor-not-allowed opacity-50",
        invalid && "border-destructive"
      )}
      onFocus={(event) => {
        setEditing(true);
        setInvalid(false);
        event.target.select();
      }}
      onChange={(event) => {
        if (disabled) return;
        committedByKey.current = false;
        setDraft(event.target.value);
        setInvalid(false);
      }}
      onBlur={() => {
        setEditing(false);
        if (committedByKey.current) {
          committedByKey.current = false;
          return;
        }
        commit();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          setInvalid(false);
          setDraft(display);
          return;
        }
        if (!isNavKey(event.key)) return;

        if (
          (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
          !caretEscapes(event.currentTarget, event.key)
        ) {
          return;
        }

        // Committing before moving is what makes Tab and the arrows safe: a
        // typed value can never be lost by navigating away from it.
        event.preventDefault();
        if (!commit()) return;
        setEditing(false);
        committedByKey.current = true;
        onNavigate(event.key);
      }}
      data-testid={testId}
      data-cell-state={cell.entries.length === 0 ? "empty" : "single"}
    />
  );
}

// The sum stays read-only; the breakdown addresses actual entry records.
type ReadOnlyCellProps = Pick<TimesheetCellFieldProps,
  "cell" | "label" | "duration" | "clock" | "detailHref" | "disabled" |
  "readOnlyReason" | "blocks" | "isToday" | "onNavigate" | "testId"
> & { secondary?: boolean };

function ReadOnlyCell({
  cell, label, duration, clock, detailHref, disabled = false, readOnlyReason,
  blocks, isToday = false, onNavigate, testId, secondary = false,
}: ReadOnlyCellProps): React.JSX.Element {
  const t = useT("calendar");
  const tc = useT("common");
  const f = useFormat();
  const headingId = React.useId();
  const [open, setOpen] = React.useState(false);
  const openingEditor = React.useRef(false);
  const state = timesheetCellState(cell);
  const reason = state === "running" ? "running" : state === "multiple" ? "multiple" : "spans-days";
  const explanation = readOnlyReason ?? (secondary ? t("timesheet.blocks.hint") : t(`timesheet.refusal.${refusalMessageKey(reason)}`));
  const Icon = secondary ? List : state === "running" ? Timer : state === "multiple" ? Layers : MoveRight;
  const actionsDisabled = disabled || blocks?.disabled === true;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={secondary ? t("timesheet.blocks.show", { label }) : `${label}: ${duration(cell.seconds)}. ${explanation}`}
          title={secondary ? t("timesheet.blocks.show", { label }) : explanation}
          className={cn(secondary ? "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted" :
            cn(cellClasses(isToday, cell.seconds === 0), "inline-flex items-center justify-center gap-1 border border-dashed border-border bg-muted/40"),
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring")}
          onKeyDown={(event) => {
            // Enter and Space open the popover through the native button.
            if (secondary || event.key === "Enter" || !isNavKey(event.key)) return;
            event.preventDefault();
            onNavigate(event.key);
          }}
          data-testid={secondary ? `${testId}-blocks` : testId}
          data-cell-state={state}
        >
          <Icon className={cn("size-3 shrink-0 text-muted-foreground", state === "running" && !secondary && "animate-pulse text-destructive")} aria-hidden="true" />
          {secondary ? null : duration(cell.seconds)}
        </button>
      </PopoverTrigger>

      <PopoverContent align="center" className="max-h-[70dvh] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto text-sm" aria-labelledby={headingId}
        onCloseAutoFocus={(event) => {
          if (openingEditor.current) {
            event.preventDefault();
            openingEditor.current = false;
          }
        }}>
        <p id={headingId} className="font-medium">{label}</p>
        <p className="mt-1 text-xs text-muted-foreground">{explanation}</p>
        {blocks?.disabled ? <p className="mt-1 text-xs" role="status">{tc("status.saving")}</p> : null}

        {cell.entries.length === 0 ? <p className="mt-3 text-xs text-muted-foreground">{t("timesheet.blocks.empty")}</p> : (
          <ul className="mt-3 grid gap-3" data-testid={`${testId}-breakdown`}>
            {cell.entries.map((slice) => {
              const entry = blocks?.entry(slice.id);
              const protection = blocks?.protection(slice.id);
              const name = entry?.description || t("timesheet.blocks.untitled");
              return (
                <li key={slice.id} className="space-y-1 border-b border-border pb-2 text-xs" data-testid={`${testId}-block-${slice.id}`}>
                  {blocks !== undefined ? <p className="break-words font-medium">{name}</p> : null}
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-muted-foreground">
                      {!slice.containedInDay ? `${f.date(slice.start, "dayLabel")} ` : ""}{clock(slice.start)}
                      {" – "}
                      {slice.end === null ? t("timesheet.running") : <>{!slice.containedInDay ? `${f.date(slice.end, "dayLabel")} ` : ""}{clock(slice.end)}</>}
                    </span>
                    <span className="shrink-0 font-mono tabular-nums">{duration(slice.secondsInCell)}</span>
                  </div>
                  {!slice.containedInDay ? <p className="text-muted-foreground">{t("timesheet.blocks.dayContribution")}</p> : null}
                  {blocks !== undefined ? <>
                    {protection ? <p id={`${testId}-${slice.id}-reason`} className="text-muted-foreground">{protection}</p> : null}
                    <Button type="button" variant="outline" size="sm" className="h-7"
                      disabled={actionsDisabled || protection !== null}
                      aria-label={t("timesheet.blocks.edit", { label: `${name}, ${clock(slice.start)}` })}
                      aria-describedby={protection ? `${testId}-${slice.id}-reason` : undefined}
                      data-testid={`${testId}-edit-${slice.id}`}
                      onClick={() => { openingEditor.current = true; setOpen(false); blocks.onEdit(slice.id, testId); }}>
                      {tc("actions.edit")}
                    </Button>
                  </> : null}
                </li>
              );
            })}
          </ul>
        )}

        {blocks !== undefined ? <Button type="button" variant="outline" size="sm" className="mt-3 w-full"
          disabled={actionsDisabled} data-testid={`${testId}-add-block`}
          onClick={() => { openingEditor.current = true; setOpen(false); blocks.onAdd(testId); }}>
          {t("timesheet.blocks.add")}
        </Button> : null}
        <div className="mt-3 flex items-center justify-between gap-2">
          <Link href={detailHref} className="text-xs font-medium underline underline-offset-4" data-testid={`${testId}-open`}>
            {t("timesheet.openEntries")}
          </Link>
          <PopoverClose asChild><Button type="button" variant="ghost" size="sm">{tc("a11y.close")}</Button></PopoverClose>
        </div>
      </PopoverContent>
    </Popover>
  );
}
