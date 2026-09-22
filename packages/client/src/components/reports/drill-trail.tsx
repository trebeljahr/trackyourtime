"use client";

import * as React from "react";
import { ArrowLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useT } from "@/i18n/use-t";
import type { UseReportFiltersResult } from "@/components/reports/use-report-filters";

export type DrillTrailProps = {
  filters: Pick<UseReportFiltersResult, "drillTrail" | "drillBack" | "drillBackTo">;
};

/**
 * The way back out of a drill-down: a Back button that undoes the last step,
 * and the steps taken as crumbs, each of which returns to the report as it
 * was right after it. Renders nothing until something was drilled into, so
 * a report opened from a link or a bookmark shows the plain filter bar.
 *
 * Under the filter bar rather than inside a view: a table row drills from
 * Totals into Entries, and the way back must be on the screen it lands on.
 */
export function DrillTrail({ filters }: DrillTrailProps): React.JSX.Element | null {
  const { drillTrail, drillBack, drillBackTo } = filters;
  const t = useT("reports");
  const tc = useT("common");

  if (drillTrail.length === 0) return null;

  const crumbClass =
    "max-w-[14rem] truncate rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

  return (
    <nav
      aria-label={t("drill.trail")}
      className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground"
      data-testid="drill-trail"
    >
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mr-1"
        onClick={drillBack}
        data-testid="drill-back"
      >
        <ArrowLeft className="size-4" />
        {tc("actions.back")}
      </Button>

      <button
        type="button"
        className={crumbClass}
        title={t("drill.returnTo", { name: t("drill.root") })}
        onClick={() => drillBackTo(0)}
        data-testid="drill-crumb-root"
      >
        {t("drill.root")}
      </button>

      {drillTrail.map((step, index) => {
        const isCurrent = index === drillTrail.length - 1;
        return (
          <React.Fragment key={`${index}-${step.query}`}>
            <ChevronRight aria-hidden="true" className="size-3.5 shrink-0" />
            {isCurrent ? (
              <span
                aria-current="page"
                className="max-w-[14rem] truncate px-1.5 py-0.5 font-medium text-foreground"
                data-testid={`drill-crumb-${index}`}
              >
                {step.label}
              </span>
            ) : (
              <button
                type="button"
                className={crumbClass}
                title={t("drill.returnTo", { name: step.label })}
                // Crumb `index` is the report right after step `index`, which
                // is the query step `index + 1` started from.
                onClick={() => drillBackTo(index + 1)}
                data-testid={`drill-crumb-${index}`}
              >
                {step.label}
              </button>
            )}
          </React.Fragment>
        );
      })}
    </nav>
  );
}
