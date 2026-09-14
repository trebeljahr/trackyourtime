"use client";

import * as React from "react";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Loading placeholders sized to the real layout, so nothing on the report
 * screens jumps when the data lands.
 */

export function FilterBarSkeleton(): React.JSX.Element {
  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-2"
      data-testid="report-filters-skeleton"
    >
      {[10, 9.5, 9.5, 9.5, 9.5].map((width, index) => (
        <Skeleton
          key={index}
          className="h-9 rounded-md"
          style={{ width: `${width}rem` }}
        />
      ))}
      <Skeleton className="h-9 w-56 rounded-md" />
    </div>
  );
}

export function KpiRowSkeleton(): React.JSX.Element {
  return (
    <div
      className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
      data-testid="kpi-row-skeleton"
    >
      {[0, 1, 2, 3].map((index) => (
        <Card key={index}>
          <CardHeader className="pb-2">
            <Skeleton className="h-3 w-24" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-8 w-28" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export function ChartSkeleton({
  height = 280,
  testId = "chart-skeleton",
}: {
  height?: number;
  testId?: string;
}): React.JSX.Element {
  return (
    <Skeleton
      className="w-full rounded-md"
      style={{ height: `${height}px` }}
      data-testid={testId}
    />
  );
}

export function TableSkeleton({
  rows = 8,
  columns = 5,
  testId = "table-skeleton",
}: {
  rows?: number;
  columns?: number;
  testId?: string;
}): React.JSX.Element {
  return (
    <div className="space-y-2" data-testid={testId}>
      <Skeleton className="h-9 w-full rounded-md" />
      {Array.from({ length: rows }, (_, rowIndex) => (
        <div
          key={rowIndex}
          className="grid gap-3"
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
        >
          {Array.from({ length: columns }, (_, columnIndex) => (
            <Skeleton key={columnIndex} className="h-8" />
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * Whole-page fallback for the /reports Suspense boundary and the legacy
 * redirect pages.
 */
export function ReportPageSkeleton(): React.JSX.Element {
  return (
    <div className="space-y-4" data-testid="report-page-skeleton">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-9 w-40 rounded-md" />
      </div>
      <FilterBarSkeleton />
      <KpiRowSkeleton />
      <ChartSkeleton />
    </div>
  );
}
