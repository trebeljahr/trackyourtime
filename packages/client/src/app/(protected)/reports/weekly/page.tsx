"use client";

import * as React from "react";

import { LegacyReportRedirect } from "@/components/legacy-report-redirect";

/** Retired route: Reports is one page at /reports now. Kept for bookmarks. */
export default function WeeklyReportRedirectPage(): React.JSX.Element {
  return <LegacyReportRedirect kind="weekly" />;
}
