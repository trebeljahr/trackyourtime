"use client";

import * as React from "react";
import Link from "next/link";
import type { SummaryGroup } from "@starter/shared";

import { BudgetMeterCell } from "@/components/budget-meter";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CHART_COLORS, groupColorMap } from "@/components/reports/group-colors";
import { useFormat } from "@/i18n/use-format";
import { useT } from "@/i18n/use-t";
import type { BudgetView } from "@/lib/budget-view";
import { formatReportMoney } from "@/components/reports/report-money";

export type SummaryTableProps = {
  groups: SummaryGroup[];
  totalSec: number;
  billableSec: number;
  /** `null` when the report's money is withheld from the caller. */
  totalAmount: number | null;
  duration: (seconds: number) => string;
  money: (amount: number) => string;
  /** Column heading for the group key, e.g. "Project". */
  dimensionLabel: string;
  /**
   * Lifetime budget progress for a group, when the dimension has one.
   * Omitted entirely for dimensions that cannot carry a budget (day, client,
   * …), which is what hides the column.
   */
  budgetFor?: (groupKey: string) => BudgetView | null;
  /**
   * Where a group row leads — the entry log behind that row's number. Returns
   * null for a dimension whose keys are not catalog rows (day, week, month),
   * and may be omitted entirely.
   */
  hrefForGroup?: (group: SummaryGroup) => string | null;
  /**
   * Called instead of following `hrefForGroup` on a plain click, so the
   * screen can record the step for its Back button before navigating. A
   * modified click (new tab, middle button) still follows the link as is.
   */
  onDrill?: (group: SummaryGroup) => void;
  /**
   * Whether the groups can overlap — true only for tags, where one entry
   * carries several. Stated by the caller from the grouping itself: the
   * heading is translated, so it can no longer stand in for the grouping.
   */
  groupsOverlap?: boolean;
};

/** Grouped totals, biggest first, with an inline share-of-total bar. */
export function SummaryTable({
  groups,
  totalSec,
  billableSec,
  totalAmount,
  duration,
  money,
  dimensionLabel,
  budgetFor,
  hrefForGroup,
  onDrill,
  groupsOverlap = false,
}: SummaryTableProps): React.JSX.Element {
  const t = useT("reports");
  const tc = useT("common");
  const f = useFormat();
  const rows = React.useMemo(
    () => [...groups].sort((a, b) => b.seconds - a.seconds),
    [groups]
  );
  const colors = React.useMemo(() => groupColorMap(groups), [groups]);

  const denominator = totalSec > 0 ? totalSec : 1;

  return (
    <>
      {/* An entry with two tags is counted under both, so the rows add up to
          more than the total. Numbers that silently do not add up read as a
          bug, so the table says so rather than leaving it to be discovered. */}
      {groupsOverlap ? (
        <p
          className="mb-2 text-xs text-muted-foreground"
          data-testid="summary-overlap-note"
        >
          {t("summary.overlapNote")}
        </p>
      ) : null}

      <Table data-testid="summary-table">
      <TableHeader>
        <TableRow>
          <TableHead>{dimensionLabel}</TableHead>
          <TableHead className="w-[28%]">{t("summary.share")}</TableHead>
          <TableHead className="text-right">{tc("fields.billable")}</TableHead>
          <TableHead className="text-right">{tc("fields.duration")}</TableHead>
          <TableHead className="text-right">{tc("fields.amount")}</TableHead>
          {budgetFor ? (
            <TableHead className="w-52">
              {t("summary.budget")}
              <span className="ml-1 font-normal text-muted-foreground">
                {t("summary.lifetime")}
              </span>
            </TableHead>
          ) : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((group, index) => {
          const share = (group.seconds / denominator) * 100;
          const color =
            colors.get(group.key) ?? CHART_COLORS[index % CHART_COLORS.length];
          const href = hrefForGroup?.(group) ?? null;
          const label = (
            <span className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className="size-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: color }}
              />
              <span className="truncate">{group.label}</span>
            </span>
          );
          return (
            <TableRow key={group.key} data-testid={`summary-row-${group.key}`}>
              {/* A grouped total and the entries under it are the same fact at
                  two zoom levels, so the row itself is the way down to them. */}
              <TableCell className="font-medium">
                {href === null ? (
                  label
                ) : (
                  <Link
                    href={href}
                    className="rounded underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    title={t("summary.showEntriesFor", { name: group.label })}
                    onClick={(event: React.MouseEvent<HTMLAnchorElement>) => {
                      if (
                        onDrill === undefined ||
                        event.defaultPrevented ||
                        event.button !== 0 ||
                        event.metaKey ||
                        event.ctrlKey ||
                        event.shiftKey ||
                        event.altKey
                      ) {
                        return;
                      }
                      event.preventDefault();
                      onDrill(group);
                    }}
                    data-testid={`summary-link-${group.key}`}
                  >
                    {label}
                  </Link>
                )}
              </TableCell>
              <TableCell>
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="h-2 min-w-8 flex-1 overflow-hidden rounded-full bg-muted"
                  >
                    <span
                      className="block h-full rounded-full"
                      style={{
                        width: `${Math.max(share, share > 0 ? 2 : 0)}%`,
                        backgroundColor: color,
                      }}
                    />
                  </span>
                  <span className="w-11 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                    {f.number(share / 100, {
                      style: "percent",
                      minimumFractionDigits: 1,
                      maximumFractionDigits: 1,
                    })}
                  </span>
                </span>
              </TableCell>
              <TableCell className="text-right tabular-nums text-muted-foreground">
                {duration(group.billableSec)}
              </TableCell>
              <TableCell className="text-right font-medium tabular-nums">
                {duration(group.seconds)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatReportMoney(group.amount, money)}
              </TableCell>
              {budgetFor ? (
                <TableCell data-testid={`summary-budget-${group.key}`}>
                  {/*
                   * A budget is a lifetime target while these totals are
                   * range-scoped, so the meter deliberately reports the whole
                   * project rather than the filtered slice — hence the column
                   * heading saying so.
                   */}
                  <BudgetMeterCell
                    view={budgetFor(group.key)}
                    emptyLabel="—"
                    testId={`summary-budget-meter-${group.key}`}
                  />
                </TableCell>
              ) : null}
            </TableRow>
          );
        })}
      </TableBody>
      <TableFooter>
        <TableRow data-testid="summary-total-row">
          <TableCell>{tc("fields.total")}</TableCell>
          <TableCell />
          <TableCell className="text-right tabular-nums">
            {duration(billableSec)}
          </TableCell>
          <TableCell
            className="text-right tabular-nums"
            data-testid="summary-total-duration"
          >
            {duration(totalSec)}
          </TableCell>
          <TableCell
            className="text-right tabular-nums"
            data-testid="summary-total-amount"
          >
            {formatReportMoney(totalAmount, money)}
          </TableCell>
          {budgetFor ? <TableCell /> : null}
        </TableRow>
      </TableFooter>
      </Table>
    </>
  );
}
