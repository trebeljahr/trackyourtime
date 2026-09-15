"use client";

import * as React from "react";

import { formatRangeLabel } from "@/components/date-range-picker";
import { Button } from "@/components/ui/button";
import { useFormat } from "@/i18n/use-format";
import { useT } from "@/i18n/use-t";
import type { ReportView } from "@/lib/report-links";
import { cn } from "@/lib/utils";
import { EntriesView } from "@/components/reports/entries-view";
import { ExportMenu } from "@/components/reports/export-menu";
import { effectiveGroupBy } from "@/components/reports/group-by";
import { useMemberReporting } from "@/components/reports/member-reporting";
import { ReportFiltersBar } from "@/components/reports/report-filters";
import { ReportPageSkeleton } from "@/components/reports/report-skeletons";
import { TotalsView } from "@/components/reports/totals-view";
import {
  REPORT_PARAM,
  useReportFilters,
} from "@/components/reports/use-report-filters";

/** In switch order; each label is `reports.screen.views.<id>`. */
const VIEW_OPTIONS: readonly ReportView[] = ["totals", "entries"];

/**
 * The one Reports screen: a shared header and filter bar over either Totals
 * (grouped numbers) or Entries (the log behind them).
 *
 * The filter bar is rendered here, not inside each view, so it stays mounted
 * across a switch — a half-typed search, an open catalog dialog and the catalog
 * queries all survive it. Only the active view is mounted: both views carry
 * `kpi-total` / `kpi-amount`, and rendering one also means one report query.
 */
export function ReportsScreen(): React.JSX.Element {
  const memberReporting = useMemberReporting();
  const filters = useReportFilters({ memberFilter: memberReporting });
  const { state, filters: reportFilters, getParam, view, setView } = filters;
  const t = useT("reports");
  const f = useFormat();

  // Readiness is recorded against the view that reported it, so a switch reads
  // as "not ready" until the newly mounted view says otherwise — including a
  // switch made by browser back/forward rather than by the buttons. The views
  // report from a layout effect, so a cached report is ready before paint.
  const [readyView, setReadyView] = React.useState<ReportView | null>(null);
  const onExportReady = React.useCallback(
    (ready: boolean): void => {
      setReadyView((current) => {
        if (ready) return view;
        return current === view ? null : current;
      });
    },
    [view]
  );
  const exportReady = readyView === view;

  return (
    <div className="space-y-4" data-testid="reports-screen">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">{t("screen.title")}</h1>
          <p className="text-sm text-muted-foreground">
            {formatRangeLabel(state.range, f.locale)}
          </p>
        </div>

        <div
          className="flex items-center gap-1 rounded-lg border border-border bg-card p-1"
          role="tablist"
          aria-label={t("screen.viewLabel")}
          data-testid="report-view-switch"
        >
          {VIEW_OPTIONS.map((option) => (
            <Button
              key={option}
              type="button"
              size="sm"
              role="tab"
              variant={option === view ? "secondary" : "ghost"}
              aria-selected={option === view}
              className={cn("font-normal", option === view && "font-medium")}
              onClick={() => setView(option)}
              data-testid={`report-view-${option}`}
            >
              {t(`screen.views.${option}`)}
            </Button>
          ))}
        </div>
      </header>

      <ReportFiltersBar
        filters={filters}
        memberFilter={memberReporting}
        trailing={
          <ExportMenu
            report={view === "totals" ? "summary" : "detailed"}
            filters={reportFilters}
            groupBy={
              view === "totals"
                ? effectiveGroupBy(
                    getParam(REPORT_PARAM.groupBy),
                    memberReporting
                  )
                : undefined
            }
            disabled={!exportReady}
          />
        }
      />

      {view === "totals" ? (
        <TotalsView
          filters={filters}
          onExportReady={onExportReady}
          memberReporting={memberReporting}
        />
      ) : (
        <EntriesView filters={filters} onExportReady={onExportReady} />
      )}
    </div>
  );
}

/** What `/app/reports` renders: the screen reads search params, so it suspends. */
export function ReportsScreenPage(): React.JSX.Element {
  return (
    <React.Suspense fallback={<ReportPageSkeleton />}>
      <ReportsScreen />
    </React.Suspense>
  );
}
