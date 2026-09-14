"use client";

import * as React from "react";
import { X } from "lucide-react";
import {
  timesheetRowKey,
  type DurationFormat,
  type TimesheetGrid as TimesheetGridData,
  type TimesheetRow,
} from "@starter/shared";

import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useFormat, type LocaleFormat } from "@/i18n/use-format";
import { useT } from "@/i18n/use-t";
import { cn } from "@/lib/utils";
import { TimesheetCellField } from "./timesheet-cell";
import {
  nextCellPosition,
  type CellPosition,
  type TimesheetNavKey,
} from "./timesheet-nav";

/** Identifies one cell for focus moves and for the E2E selectors. */
const cellTestId = (rowKey: string, dayIndex: number): string =>
  `timesheet-cell-${rowKey}-${dayIndex}`;

export type TimesheetGridProps = {
  grid: TimesheetGridData;
  durationFormat: DurationFormat;
  duration: (seconds: number) => string;
  clock: (iso: string) => string;
  /** Link target for a cell's breakdown, given the row and the day. */
  detailHref: (row: TimesheetRow, day: string) => string;
  onCommitCell: (row: TimesheetRow, dayIndex: number, seconds: number) => void;
  /** Unpin a row the user added. Absent for rows implied by their entries. */
  onUnpinRow: (row: TimesheetRow) => void;
  disabled?: boolean;
  /** "YYYY-MM-DD" of today in the grid's zone, so the column can be marked. */
  todayKey?: string;
};

/** Column heading for a "YYYY-MM-DD" key, e.g. "Tue" over "3 Feb". */
const dayHeading = (
  f: LocaleFormat,
  day: string
): { weekday: string; date: string } => {
  const date = f.date(day, "dayMonth");
  if (date === "") return { weekday: day, date: "" };
  return { weekday: f.date(day, { weekday: "short" }), date };
};

/**
 * The grid itself: one row per project+task, one column per weekday.
 *
 * Focus is tracked here rather than in the cells, because moving between them
 * is a property of the grid — a cell only reports which key was pressed and
 * this decides where that lands.
 */
export function TimesheetGrid({
  grid,
  durationFormat,
  duration,
  clock,
  detailHref,
  onCommitCell,
  onUnpinRow,
  disabled = false,
  todayKey,
}: TimesheetGridProps): React.JSX.Element {
  // Cells are found by their testid inside this container rather than through
  // a ref registry: the registry has to be written during render, and every
  // cell already carries a stable identifier for the E2E tests anyway.
  const container = React.useRef<HTMLDivElement>(null);
  const f = useFormat();
  const t = useT("calendar");
  const tc = useT("common");

  const navigate = React.useCallback(
    (from: CellPosition, key: TimesheetNavKey): void => {
      const next = nextCellPosition(from, key, {
        rows: grid.rows.length,
        cols: grid.days.length,
      });
      if (next === null) return;

      const row = grid.rows[next.row];
      if (row === undefined) return;
      const testId = cellTestId(
        timesheetRowKey(row.projectId, row.taskId),
        next.col
      );
      container.current
        ?.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
        ?.focus();
    },
    [grid.days.length, grid.rows]
  );

  return (
    <div className="overflow-x-auto" ref={container}>
      <Table data-testid="timesheet-grid">
        <TableHeader>
          <TableRow>
            <TableHead className="min-w-44">
              {t("timesheet.projectTask")}
            </TableHead>
            {grid.days.map((day) => {
              const heading = dayHeading(f, day);
              return (
                <TableHead
                  key={day}
                  className={cn(
                    "w-24 text-center",
                    day === todayKey && "text-foreground"
                  )}
                  data-testid={`timesheet-head-${day}`}
                >
                  <span className="block text-xs font-medium">
                    {heading.weekday}
                  </span>
                  <span className="block text-[11px] font-normal text-muted-foreground">
                    {heading.date}
                  </span>
                </TableHead>
              );
            })}
            <TableHead className="w-24 text-right">
              {tc("fields.total")}
            </TableHead>
          </TableRow>
        </TableHeader>

        <TableBody>
          {grid.rows.map((row, rowIndex) => {
            const key = timesheetRowKey(row.projectId, row.taskId);
            return (
              <TableRow key={key} data-testid={`timesheet-row-${key}`}>
                <TableCell className="font-medium">
                  <span className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className="size-2.5 shrink-0 rounded-full"
                      style={{
                        backgroundColor:
                          row.color ?? "var(--color-muted-foreground)",
                      }}
                    />
                    <span className="truncate">{row.label}</span>
                    {row.pinned ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="ml-auto size-6 shrink-0"
                        aria-label={t("timesheet.removeRow", {
                          label: row.label,
                        })}
                        onClick={() => onUnpinRow(row)}
                        data-testid={`timesheet-unpin-${key}`}
                      >
                        <X className="size-3.5" />
                      </Button>
                    ) : null}
                  </span>
                </TableCell>

                {grid.days.map((day, dayIndex) => {
                  const cell = row.cells[dayIndex];
                  if (cell === undefined) return <TableCell key={day} />;
                  return (
                    <TableCell key={day} className="p-1 text-center">
                      <TimesheetCellField
                        cell={cell}
                        label={`${row.label}, ${f.date(day, "dayLabel") || day}`}
                        durationFormat={durationFormat}
                        duration={duration}
                        clock={clock}
                        detailHref={detailHref(row, day)}
                        disabled={disabled}
                        isToday={day === todayKey}
                        onCommit={(seconds) =>
                          onCommitCell(row, dayIndex, seconds)
                        }
                        onNavigate={(navKey) =>
                          navigate({ row: rowIndex, col: dayIndex }, navKey)
                        }
                        testId={cellTestId(key, dayIndex)}
                      />
                    </TableCell>
                  );
                })}

                <TableCell
                  className="text-right font-medium tabular-nums"
                  data-testid={`timesheet-row-total-${key}`}
                >
                  {duration(row.totalSec)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>

        <TableFooter>
          <TableRow>
            <TableCell>{tc("fields.total")}</TableCell>
            {grid.dayTotals.map((seconds, index) => (
              <TableCell
                key={grid.days[index] ?? index}
                className="text-center tabular-nums"
                data-testid={`timesheet-day-total-${index}`}
              >
                {duration(seconds)}
              </TableCell>
            ))}
            <TableCell
              className="text-right tabular-nums"
              data-testid="timesheet-week-total"
            >
              {duration(grid.totalSec)}
            </TableCell>
          </TableRow>
        </TableFooter>
      </Table>
    </div>
  );
}
