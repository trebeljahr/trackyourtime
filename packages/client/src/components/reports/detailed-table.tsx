"use client";

import * as React from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import type { DetailedEntry } from "@starter/shared";
import { formatReportMoney } from "@/components/reports/report-money";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CatalogName } from "@/components/catalog/catalog-name";
import { formatDayLabel } from "@/lib/format";
import { cn } from "@/lib/utils";

export type DetailedSortField = "date" | "duration";
export type SortDirection = "asc" | "desc";

export type DetailedSort = {
  field: DetailedSortField;
  direction: SortDirection;
};

export const DEFAULT_DETAILED_SORT: DetailedSort = {
  field: "date",
  direction: "desc",
};

/**
 * Sort the rows that have been loaded so far. The server streams entries
 * newest-first through a cursor, so sorting is applied client-side over the
 * pages currently in hand - the whole-range totals never come from here.
 */
export const sortDetailedEntries = (
  entries: DetailedEntry[],
  sort: DetailedSort
): DetailedEntry[] => {
  const factor = sort.direction === "asc" ? 1 : -1;
  return [...entries].sort((a, b) => {
    if (sort.field === "duration") {
      const delta = a.durationSec - b.durationSec;
      if (delta !== 0) return delta * factor;
    }
    const aStart = Date.parse(a.start);
    const bStart = Date.parse(b.start);
    if (aStart !== bStart) return (aStart - bStart) * factor;
    return a.id.localeCompare(b.id) * factor;
  });
};

function SortButton({
  label,
  field,
  sort,
  onSort,
  className,
}: {
  label: string;
  field: DetailedSortField;
  sort: DetailedSort;
  onSort: (field: DetailedSortField) => void;
  className?: string;
}): React.JSX.Element {
  const active = sort.field === field;
  const Icon = !active
    ? ChevronsUpDown
    : sort.direction === "asc"
      ? ArrowUp
      : ArrowDown;

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={cn("-mx-2 h-7 gap-1 font-medium", className)}
      aria-label={`Sort by ${label}`}
      aria-sort={
        active
          ? sort.direction === "asc"
            ? "ascending"
            : "descending"
          : "none"
      }
      onClick={() => onSort(field)}
      data-testid={`detailed-sort-${field}`}
    >
      {label}
      <Icon className={cn("size-3.5", active ? "opacity-80" : "opacity-40")} />
    </Button>
  );
}

export type DetailedTableProps = {
  entries: DetailedEntry[];
  selected: ReadonlySet<string>;
  onToggle: (id: string, selected: boolean) => void;
  onToggleAll: (selected: boolean) => void;
  sort: DetailedSort;
  onSort: (field: DetailedSortField) => void;
  duration: (seconds: number) => string;
  money: (amount: number) => string;
  clock: (iso: string) => string;
  /**
   * Opens the project a row is filed under. Omitted where the project rows
   * are not to hand, which leaves the cell as plain text.
   */
  onEditProject?: (projectId: string) => void;
};

/** The flat entry log, one row per time entry, with bulk-select checkboxes. */
export function DetailedTable({
  entries,
  selected,
  onToggle,
  onToggleAll,
  sort,
  onSort,
  duration,
  money,
  clock,
  onEditProject,
}: DetailedTableProps): React.JSX.Element {
  const allSelected = entries.length > 0 && selected.size >= entries.length;
  const someSelected = selected.size > 0 && !allSelected;

  return (
    <Table data-testid="detailed-table">
      <TableHeader>
        <TableRow>
          <TableHead className="w-10">
            <Checkbox
              checked={
                allSelected ? true : someSelected ? "indeterminate" : false
              }
              onCheckedChange={(value) => onToggleAll(value === true)}
              aria-label="Select all loaded entries"
              data-testid="detailed-select-all"
            />
          </TableHead>
          <TableHead className="w-28">
            <SortButton
              label="Date"
              field="date"
              sort={sort}
              onSort={onSort}
            />
          </TableHead>
          <TableHead>Description</TableHead>
          <TableHead className="w-40">Project</TableHead>
          <TableHead className="w-32">Client</TableHead>
          <TableHead className="w-32">Task</TableHead>
          <TableHead className="w-24">Billable</TableHead>
          <TableHead className="w-32 text-right">Start / End</TableHead>
          <TableHead className="w-24 text-right">
            <SortButton
              label="Duration"
              field="duration"
              sort={sort}
              onSort={onSort}
              className="ml-auto"
            />
          </TableHead>
          <TableHead className="w-24 text-right">Amount</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map((entry) => {
          const isSelected = selected.has(entry.id);
          const running = entry.end === null;
          // Hoisted so the narrowing survives into the click handler below.
          const projectId = entry.projectId;
          return (
            <TableRow
              key={entry.id}
              data-state={isSelected ? "selected" : undefined}
              className={cn(isSelected && "bg-muted/50")}
              data-testid={`detailed-row-${entry.id}`}
            >
              <TableCell>
                <Checkbox
                  checked={isSelected}
                  onCheckedChange={(value) => onToggle(entry.id, value === true)}
                  aria-label={`Select entry ${entry.description || "without description"}`}
                  data-testid={`detailed-select-${entry.id}`}
                />
              </TableCell>
              <TableCell className="whitespace-nowrap text-muted-foreground">
                {formatDayLabel(entry.start)}
              </TableCell>
              <TableCell className="max-w-0">
                <span className="block truncate">
                  {entry.description === "" ? (
                    <span className="text-muted-foreground">
                      No description
                    </span>
                  ) : (
                    entry.description
                  )}
                </span>
              </TableCell>
              {/* The project's own colour and name are edited from wherever
                  they are read, this log included — the row's project itself
                  is changed with the bulk bar, which is the report's job. */}
              <TableCell>
                {entry.projectName === null ? (
                  <span className="text-muted-foreground">No project</span>
                ) : onEditProject && projectId !== null ? (
                  <CatalogName
                    name={entry.projectName}
                    color={entry.projectColor}
                    nameClassName="font-normal"
                    editLabel={`Edit project "${entry.projectName}"`}
                    onEdit={() => onEditProject(projectId)}
                    testId={`detailed-project-${entry.id}`}
                  />
                ) : (
                  <span className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className="size-2.5 shrink-0 rounded-full"
                      style={{
                        backgroundColor:
                          entry.projectColor ?? "hsl(var(--muted-foreground))",
                      }}
                    />
                    <span className="truncate">{entry.projectName}</span>
                  </span>
                )}
              </TableCell>
              <TableCell className="truncate text-muted-foreground">
                {entry.clientName ?? "—"}
              </TableCell>
              <TableCell className="truncate text-muted-foreground">
                {entry.taskName ?? "—"}
              </TableCell>
              <TableCell>
                <Badge variant={entry.billable ? "default" : "outline"}>
                  {entry.billable ? "Billable" : "Non-billable"}
                </Badge>
              </TableCell>
              <TableCell className="whitespace-nowrap text-right tabular-nums text-muted-foreground">
                {clock(entry.start)}
                {" – "}
                {running ? "running" : clock(entry.end ?? entry.start)}
              </TableCell>
              <TableCell className="text-right font-medium tabular-nums">
                {duration(entry.durationSec)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatReportMoney(entry.amount, money)}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
