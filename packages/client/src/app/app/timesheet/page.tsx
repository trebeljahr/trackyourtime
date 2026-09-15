"use client";

import * as React from "react";

import { TimesheetScreen } from "@/components/timesheet/timesheet-screen";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * The week being shown lives in the query string, so the screen reads
 * `useSearchParams` and has to sit under a Suspense boundary — Next refuses to
 * prerender a static page that reads search params without one.
 */
export default function TimesheetPage(): React.JSX.Element {
  return (
    <React.Suspense
      fallback={
        <div className="space-y-4">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-96 w-full" />
        </div>
      }
    >
      <TimesheetScreen />
    </React.Suspense>
  );
}
