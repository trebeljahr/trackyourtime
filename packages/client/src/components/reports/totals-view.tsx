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
import { useFormat } from "@/i18n/use-format";
import { useT } from "@/i18n/use-t";
import { userErrorMessage } from "@/lib/error-message";
import { useFormatSettings } from "@/lib/format";
import { reportsHref } from "@/lib/report-links";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import {
  DEFAULT_GROUP_BY,
  PARAM_FOR_GROUP_BY,
  effectiveGroupBy,
  groupByOptionsFor,
} from "@/components/reports/group-by";
import { MoneyHiddenNote } from "@/components/reports/member-reporting";
import { KpiRow, type KpiItem } from "@/components/reports/kpi-row";
import { MONEY_WITHHELD } from "@/components/reports/report-money";
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

/** Reports → Totals: KPIs, the timeline, the breakdown and the grouped table. */
export function TotalsView({
  filters,
  onExportReady,
  memberReporting = false,
}: ReportViewProps): React.JSX.Element {
  const { filters: reportFilters, setParam, getParam } = filters;
  const fmt = useFormatSettings();
  const f = useFormat();
  const t = useT("reports");
  const tc = useT("common");
  const searchParams = useSearchParams();
  const groupBy = effectiveGroupBy(getParam(REPORT_PARAM.groupBy), memberReporting);

  const groupByOptions = groupByOptionsFor(memberReporting);

  const dimensionOption =
    groupByOptions.find((option) => option.id === groupBy) ?? groupByOptions[0];
  const dimension = tc(dimensionOption.labelKey);

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
          money: f.money,
          fallbackCurrency: fmt.currency,
          locale: f.locale,
        }),
      ]),
    );
    return (groupKey) => views.get(groupKey) ?? null;
  }, [groupBy, projectsQuery.data, fmt.durationShort, fmt.currency, f]);

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
    const percent = (part: number, whole: number): string =>
      whole > 0 ? t("kpi.shareOfTracked", { percent: f.percent(part / whole) }) : "";
    return [
      {
        label: t("kpi.totalTracked"),
        value: fmt.duration(totalSec),
        hint: fmt.durationShort(totalSec),
        icon: Clock,
        testId: "kpi-total",
      },
      {
        label: tc("fields.billable"),
        value: fmt.duration(billableSec),
        hint: percent(billableSec, totalSec),
        icon: Receipt,
        testId: "kpi-billable",
      },
      {
        label: tc("fields.nonBillable"),
        value: fmt.duration(nonBillableSec),
        hint: percent(nonBillableSec, totalSec),
        icon: Clock,
        testId: "kpi-non-billable",
      },
      {
        label: t("kpi.amountEarned"),
        value:
          result && result.totalAmount === null
            ? MONEY_WITHHELD
            : fmt.money(result?.totalAmount ?? 0),
        hint: result?.currency ?? fmt.currency,
        icon:
          currencyIcon(result?.currency ?? fmt.currency) ??
          CURRENCY_FALLBACK_ICON,
        testId: "kpi-amount",
      },
    ];
  }, [fmt, result, t, tc, f]);

  const isLoading = query.isPending;
  const isEmpty = result !== undefined && result.totalSec === 0;

  return (
    <div className="space-y-4" data-testid="summary-report">
      {isLoading ? <KpiRowSkeleton /> : <KpiRow items={kpis} />}
      <MoneyHiddenNote moneyVisible={result?.moneyVisible} />

      {/*
        Budgets sit under the KPIs and above the group-by switch: they are a
        property of the projects in view, not of the grouping, so re-grouping
        the report must not look like it changed them. Renders null until any
        project has a budget set.
      */}

      <div
        className="flex flex-wrap items-center gap-1 rounded-lg border border-border bg-card p-1"
        role="group"
        aria-label={t("groupBy.label")}
        data-testid="groupby-switch"
      >
        <span className="px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("groupBy.label")}
        </span>
        {groupByOptions.map((option) => (
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
            {tc(option.labelKey)}
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
            groupBy={groupBy}
          />
        </div>
      ) : null}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">
            {t("groupBy.totalsTitle", { groupBy })}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <TableSkeleton rows={6} columns={5} testId="summary-table-skeleton" />
          ) : isEmpty || result === undefined ? (
            <EmptyState
              icon={BarChart3}
              title={t("summary.emptyTitle")}
              description={t("summary.emptyDescription")}
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
              // which is translated and so cannot identify the grouping.
              groupsOverlap={groupBy === "tag"}
            />
          )}
        </CardContent>
      </Card>

      {query.isError ? (
        <p className="text-sm text-destructive" data-testid="summary-error">
          {userErrorMessage(query.error, undefined, tc)}
        </p>
      ) : null}
    </div>
  );
}
