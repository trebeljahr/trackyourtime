"use client";

import * as React from "react";

import {
  rangeForPreset,
  type DateRange,
} from "@/components/date-range-picker";
import {
  DEVICE_TIME_ZONE,
  REPORT_PARAM,
} from "@/components/reports/use-report-filters";
import { useFormatSettings } from "@/lib/format";
import { trpc } from "@/lib/trpc";

/** The catalog dimensions an entry log can be narrowed to. */
export type EntryFilterDimension = "client" | "project" | "task" | "tag";

const PARAM_FOR_DIMENSION: Record<EntryFilterDimension, string> = {
  client: REPORT_PARAM.clients,
  project: REPORT_PARAM.projects,
  task: REPORT_PARAM.tasks,
  tag: REPORT_PARAM.tags,
};

const DETAILED_REPORT_PATH = "/reports/detailed";

export type EntriesLinkTarget = {
  dimension: EntryFilterDimension;
  id: string;
};

/**
 * The detailed report, filtered to one catalog row over `range`.
 *
 * The report reads its whole state from the query string, so linking into it
 * needs no new plumbing: the same URL a user could have built with the filter
 * bar is the one a click on a catalog row produces, and it stays shareable.
 */
export const entriesHref = (
  target: EntriesLinkTarget,
  range: DateRange,
): string => {
  const params = new URLSearchParams({
    [REPORT_PARAM.from]: range.from,
    [REPORT_PARAM.to]: range.to,
    [PARAM_FOR_DIMENSION[target.dimension]]: target.id,
  });

  return `${DETAILED_REPORT_PATH}?${params.toString()}`;
};

/**
 * The range covering every entry the workspace has, for links whose row shows
 * a LIFETIME total. Clicking "40h tracked" and landing on a report showing
 * this week's two hours reads as a broken link, not as a date filter.
 *
 * Falls back to this year until the span is known, and for a workspace with
 * nothing tracked yet — an empty report either way, but never a nonsense
 * range. The bounds come from the data rather than from a fixed epoch,
 * because the summary report zero-fills a timeline point per day in range.
 */
export const useAllTimeRange = (): DateRange => {
  const { weekStartsOn } = useFormatSettings();
  const span = useTrackedSpan();

  const fallback = React.useMemo(
    () => rangeForPreset("thisYear", weekStartsOn),
    [weekStartsOn],
  );

  return span ?? fallback;
};

/**
 * The first and last day the workspace has tracked time on, or null while
 * that is unknown or when nothing is tracked. Unlike `useAllTimeRange` there
 * is no fallback, so a caller can tell "all time" from "this year".
 */
export const useTrackedSpan = (): DateRange | null => {
  const spanQuery = trpc.reports.trackedSpan.useQuery(
    { timeZone: DEVICE_TIME_ZONE },
    { staleTime: 5 * 60_000 },
  );

  const span = spanQuery.data;

  return React.useMemo(() => {
    if (!span || span.from === null || span.to === null) return null;
    return { from: span.from, to: span.to };
  }, [span]);
};
