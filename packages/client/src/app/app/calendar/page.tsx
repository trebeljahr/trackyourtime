"use client";

import * as React from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { CalendarScreen } from "@/components/calendar/calendar-screen";

/**
 * `/app/calendar` — week and month views of tracked time. The visible week/month
 * lives in `?view=` / `?date=`, so a Suspense boundary is required around
 * `useSearchParams` for the static export.
 */
export default function CalendarPage(): React.JSX.Element {
  return (
    <React.Suspense
      fallback={
        <div className="space-y-4" data-testid="calendar-loading">
          <Skeleton className="h-9 w-64" />
          <Skeleton className="h-[26rem] w-full" />
        </div>
      }
    >
      <CalendarScreen />
    </React.Suspense>
  );
}
