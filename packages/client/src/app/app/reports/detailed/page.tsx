"use client";

import * as React from "react";

import { LegacyReportRedirect } from "@/components/legacy-report-redirect";

/** Retired route: Reports is one page at /app/reports now. Kept for bookmarks. */
export default function DetailedReportRedirectPage(): React.JSX.Element {
  return <LegacyReportRedirect kind="detailed" />;
}
