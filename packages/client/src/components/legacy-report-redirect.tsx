"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { ReportPageSkeleton } from "@/components/reports/report-skeletons";
import { useFormatSettings } from "@/lib/format";
import { legacyReportRedirect } from "@/lib/report-links";

/**
 * How long the weekly redirect waits for the workspace's week start before
 * using the fallback. Long enough for a normal settings load, short enough
 * that a failed one does not strand a bookmark on a skeleton.
 */
const WEEK_START_WAIT_MS = 2_000;

export type LegacyReportRedirectProps = {
  kind: "summary" | "detailed" | "weekly";
};

/**
 * The page a retired report route renders: a skeleton, then a replace to the
 * matching `/reports` URL with the query string carried over.
 *
 * Client-side because the static export has no middleware or rewrites. It
 * reads `window.location.search` rather than `useSearchParams`, so the page
 * needs no Suspense boundary. `replace`, so browser back skips the old URL
 * instead of bouncing straight back into the redirect.
 *
 * Only `weekly` depends on a setting: its week has to be snapped to the
 * workspace's week start, and the fallback until settings load is Monday. A
 * Sunday-start workspace redirected on the fallback would land one day off,
 * so that kind waits for settings, with a timeout for when they never come.
 */
export function LegacyReportRedirect({
  kind,
}: LegacyReportRedirectProps): React.JSX.Element {
  const router = useRouter();
  const { isLoaded, weekStartsOn } = useFormatSettings();
  const [waitedOut, setWaitedOut] = React.useState(false);
  const redirected = React.useRef(false);

  const needsSettings = kind === "weekly";

  React.useEffect(() => {
    if (!needsSettings || isLoaded) return;
    const timer = window.setTimeout(() => setWaitedOut(true), WEEK_START_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [isLoaded, needsSettings]);

  React.useEffect(() => {
    if (redirected.current) return;
    if (needsSettings && !isLoaded && !waitedOut) return;

    redirected.current = true;
    router.replace(
      legacyReportRedirect(kind, window.location.search, weekStartsOn),
    );
  }, [isLoaded, kind, needsSettings, router, waitedOut, weekStartsOn]);

  return <ReportPageSkeleton />;
}
