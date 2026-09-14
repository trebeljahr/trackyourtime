"use client";

import * as React from "react";
import Link from "next/link";
import { Timer, Layers, MoveRight } from "lucide-react";
import {
  parseTimesheetCell,
  timesheetCellState,
  TIMESHEET_MAX_CELL_SECONDS,
  type DurationFormat,
  type TimesheetCell,
} from "@starter/shared";

import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useFormat } from "@/i18n/use-format";
import { useT } from "@/i18n/use-t";
import { cn } from "@/lib/utils";
import { isNavKey, type TimesheetNavKey } from "./timesheet-nav";
import { refusalMessageKey } from "./refusal-message";

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
  isToday = false,
  onCommit,
  onNavigate,
  testId,
}: TimesheetCellFieldProps): React.JSX.Element {
  const state = timesheetCellState(cell);
  const editable = state === "empty" || state === "single";

  if (!editable) {
    return (
      <ReadOnlyCell
        cell={cell}
        label={label}
        duration={duration}
        clock={clock}
        detailHref={detailHref}
        isToday={isToday}
        onNavigate={onNavigate}
        testId={testId}
      />
    );
  }

  return (
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
  }, [cell.seconds, display, draft, formatCell, onCommit]);

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
      disabled={disabled}
      spellCheck={false}
      inputMode="decimal"
      autoComplete="off"
      aria-label={label}
      aria-invalid={invalid || undefined}
      className={cn(
        cellClasses(isToday, cell.seconds === 0),
        invalid && "border-destructive"
      )}
      onFocus={(event) => {
        setEditing(true);
        setInvalid(false);
        event.target.select();
      }}
      onChange={(event) => {
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

// ── read-only, with the breakdown that explains why ──────────────────

type ReadOnlyCellProps = Pick<
  TimesheetCellFieldProps,
  | "cell"
  | "label"
  | "duration"
  | "clock"
  | "detailHref"
  | "isToday"
  | "onNavigate"
  | "testId"
>;

function ReadOnlyCell({
  cell,
  label,
  duration,
  clock,
  detailHref,
  isToday = false,
  onNavigate,
  testId,
}: ReadOnlyCellProps): React.JSX.Element {
  const t = useT("calendar");
  const state = timesheetCellState(cell);
  const reason =
    state === "running"
      ? "running"
      : state === "multiple"
        ? "multiple"
        : "spans-days";
  const explanation = t(`timesheet.refusal.${refusalMessageKey(reason)}`);
  const Icon = state === "running" ? Timer : state === "multiple" ? Layers : MoveRight;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${label}: ${duration(cell.seconds)}. ${explanation}`}
          title={explanation}
          className={cn(
            cellClasses(isToday, false),
            "inline-flex items-center justify-center gap-1 border border-dashed border-border bg-muted/40",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          )}
          onKeyDown={(event) => {
            if (!isNavKey(event.key)) return;
            event.preventDefault();
            onNavigate(event.key);
          }}
          data-testid={testId}
          data-cell-state={state}
        >
          <Icon
            className={cn(
              "size-3 shrink-0 text-muted-foreground",
              state === "running" && "animate-pulse text-destructive"
            )}
            aria-hidden="true"
          />
          {duration(cell.seconds)}
        </button>
      </PopoverTrigger>

      <PopoverContent align="center" className="w-72 text-sm">
        <p className="font-medium">{label}</p>
        <p className="mt-1 text-xs text-muted-foreground">{explanation}</p>

        <ul className="mt-2 grid gap-1" data-testid={`${testId}-breakdown`}>
          {cell.entries.map((entry) => (
            <li
              key={entry.id}
              className="flex items-center justify-between gap-2 text-xs"
            >
              <span className="text-muted-foreground">
                {clock(entry.start)}
                {" – "}
                {entry.end === null ? t("timesheet.running") : clock(entry.end)}
              </span>
              <span className="font-mono tabular-nums">
                {duration(entry.secondsInCell)}
              </span>
            </li>
          ))}
        </ul>

        <Link
          href={detailHref}
          className="mt-3 inline-block text-xs font-medium underline underline-offset-4"
          data-testid={`${testId}-open`}
        >
          {t("timesheet.openEntries")}
        </Link>
      </PopoverContent>
    </Popover>
  );
}
