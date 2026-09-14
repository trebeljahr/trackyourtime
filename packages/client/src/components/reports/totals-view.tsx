"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { BarChart3, Clock, Receipt } from "lucide-react";
import type { SummaryGroup } from "@starter/shared";

import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PROJECT_LIST_INPUT } from "@/components/catalog/types";
import { budgetView, type BudgetView } from "@/lib/budget-view";
import { CURRENCY_FALLBACK_ICON, currencyIcon } from "@/lib/currency";
import { formatMoney, useFormatSettings } from "@/lib/format";
import { reportsHref } from "@/lib/report-links";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import {
  DEFAULT_GROUP_BY,
  GROUP_BY_OPTIONS,
  PARAM_FOR_GROUP_BY,
  parseGroupBy,
} from "@/components/reports/group-by";
import { KpiRow, type KpiItem } from "@/components/reports/kpi-row";
import {
  ChartSkeleton,
  KpiRowSkeleton,
  TableSkeleton,
} from "@/components/reports/report-skeletons";
import {
  GroupBreakdownChart,
  TimelineChart,
} from "@/components/reports/summary-charts";
import { SummaryTable } from "@/components/reports/summary-table";
import {
  REPORT_PARAM,
  type ReportViewProps,
} from "@/components/reports/use-report-filters";

const percent = (part: number, whole: number): string =>
  whole > 0 ? `${((part / whole) * 100).toFixed(0)}% of tracked time` : "";

/** Reports → Totals: KPIs, the timeline, the breakdown and the grouped table. */
export function TotalsView({
  filters,
  onExportReady,
}: ReportViewProps): React.JSX.Element {
  const { filters: reportFilters, setParam, getParam } = filters;
  const fmt = useFormatSettings();
  const searchParams = useSearchParams();

  const groupBy = parseGroupBy(getParam(REPORT_PARAM.groupBy));

  const dimension =
    GROUP_BY_OPTIONS.find((option) => option.id === groupBy)?.label ?? "Project";

  const query = trpc.reports.summary.useQuery(
    { ...reportFilters, groupBy },
    { staleTime: 15_000, placeholderData: (previous) => previous }
  );

  const result = query.data;

  const hasResult = result !== undefined;
  // A layout effect, so a view whose report is already cached enables the
  // export before the first paint after a switch rather than one frame later.
  React.useLayoutEffect(() => {
    onExportReady(hasResult);
  }, [hasResult, onExportReady]);

  // Budgets live on the project, not on the report, so they are joined in the
  // browser rather than folded into the range-scoped summary result. Only
  // fetched while the report is actually grouped by project.
  const projectsQuery = trpc.projects.list.useQuery(PROJECT_LIST_INPUT, {
    staleTime: 30_000,
    enabled: groupBy === "project",
  });

  const budgetFor = React.useMemo<
    ((groupKey: string) => BudgetView | null) | undefined
  >(() => {
    if (groupBy !== "project") return undefined;
    const projects = projectsQuery.data ?? [];
    if (projects.every((project) => project.progress === null)) return undefined;

    const views = new Map<string, BudgetView | null>(
      projects.map((project) => [
        project.id,
        budgetView(project.progress, {
          durationShort: fmt.durationShort,
          money: formatMoney,
          fallbackCurrency: fmt.currency,
        }),
      ]),
    );
    return (groupKey) => views.get(groupKey) ?? null;
  }, [groupBy, projectsQuery.data, fmt.durationShort, fmt.currency]);

  /**
   * Drilling into a group keeps every filter already on screen and adds the
   * group as one more — Entries reads the same query string, so the row's
   * number and the log it opens describe the same set of entries. The grouping
   * stays in the URL although Entries ignores it, so switching back to Totals
   * lands on the dimension the drill-down started from. A link, not a view
   * switch, so browser back returns to the unfiltered totals.
   */
  const hrefForGroup = React.useMemo<
    ((group: SummaryGroup) => string | null) | undefined
  >(() => {
    const param = PARAM_FOR_GROUP_BY[groupBy];
    if (param === undefined) return undefined;
    const base = searchParams.toString();
    return (group) => {
      const next = new URLSearchParams(base);
      next.set(param, group.key);
      return reportsHref("entries", next);
    };
  }, [groupBy, searchParams]);

  const kpis = React.useMemo<KpiItem[]>(() => {
    const totalSec = result?.totalSec ?? 0;
    const billableSec = result?.billableSec ?? 0;
    const nonBillableSec = Math.max(0, totalSec - billableSec);
    return [
      {
        label: "Total tracked",
        value: fmt.duration(totalSec),
        hint: fmt.durationShort(totalSec),
        icon: Clock,
        testId: "kpi-total",
      },
      {
        label: "Billable",
        value: fmt.duration(billableSec),
        hint: percent(billableSec, totalSec),
        icon: Receipt,
        testId: "kpi-billable",
      },
      {
        label: "Non-billable",
        value: fmt.duration(nonBillableSec),
        hint: percent(nonBillableSec, totalSec),
        icon: Clock,
        testId: "kpi-non-billable",
      },
      {
        label: "Amount earned",
        value: fmt.money(result?.totalAmount ?? 0),
        hint: result?.currency ?? fmt.currency,
        icon:
          currencyIcon(result?.currency ?? fmt.currency) ??
          CURRENCY_FALLBACK_ICON,
        testId: "kpi-amount",
      },
    ];
  }, [fmt, result]);

  const isLoading = query.isPending;
  const isEmpty = result !== undefined && result.totalSec === 0;

  return (
    <div className="space-y-4" data-testid="summary-report">
      {isLoading ? <KpiRowSkeleton /> : <KpiRow items={kpis} />}

      {/*
        Budgets sit under the KPIs and above the group-by switch: they are a
        property of the projects in view, not of the grouping, so re-grouping
        the report must not look like it changed them. Renders null until any
        project has a budget set.
      */}

      <div
        className="flex flex-wrap items-center gap-1 rounded-lg border border-border bg-card p-1"
        role="group"
        aria-label="Group by"
        data-testid="groupby-switch"
      >
        <span className="px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Group by
        </span>
        {GROUP_BY_OPTIONS.map((option) => (
          <Button
            key={option.id}
            type="button"
            size="sm"
            variant={option.id === groupBy ? "secondary" : "ghost"}
            aria-pressed={option.id === groupBy}
            className={cn("font-normal", option.id === groupBy && "font-medium")}
            onClick={() =>
              setParam(
                REPORT_PARAM.groupBy,
                option.id === DEFAULT_GROUP_BY ? null : option.id
              )
            }
            data-testid={`groupby-${option.id}`}
          >
            {option.label}
          </Button>
        ))}
      </div>

      {isLoading ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <ChartSkeleton testId="timeline-chart-skeleton" />
          <ChartSkeleton testId="breakdown-chart-skeleton" />
        </div>
      ) : result ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <TimelineChart
            timeline={result.timeline}
            duration={fmt.duration}
            weekStartsOn={fmt.weekStartsOn}
          />
          <GroupBreakdownChart
            groups={result.groups}
            totalSec={result.totalSec}
            duration={fmt.duration}
            money={fmt.money}
            dimension={dimension.toLowerCase()}
          />
        </div>
      ) : null}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">
            Totals by {dimension.toLowerCase()}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <TableSkeleton rows={6} columns={5} testId="summary-table-skeleton" />
          ) : isEmpty || result === undefined ? (
            <EmptyState
              icon={BarChart3}
              title="No time tracked in this range"
              description="Adjust the filters or track some time, and the numbers will show up here."
              testId="summary-empty"
            />
          ) : (
            <SummaryTable
              groups={result.groups}
              totalSec={result.totalSec}
              billableSec={result.billableSec}
              totalAmount={result.totalAmount}
              duration={fmt.duration}
              money={fmt.money}
              dimensionLabel={dimension}
              budgetFor={budgetFor}
              hrefForGroup={hrefForGroup}
              // Stated from the grouping itself, not inferred from the label,
              // so renaming "Tag" cannot silently drop the double-counting
              // caveat.
              groupsOverlap={groupBy === "tag"}
            />
          )}
        </CardContent>
      </Card>

      {query.isError ? (
        <p className="text-sm text-destructive" data-testid="summary-error">
          {query.error.message}
        </p>
      ) : null}
    </div>
  );
}
