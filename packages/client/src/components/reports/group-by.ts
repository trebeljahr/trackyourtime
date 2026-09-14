import type { ReportGroupBy } from "@starter/shared";

import { REPORT_PARAM } from "@/components/reports/use-report-filters";

/**
 * The dimensions Totals can be grouped by, in switch order. Lives beside the
 * report filters rather than inside the Totals view because the screen needs
 * the grouping too: the export sends it along with the summary report.
 *
 * Each carries the `common` key that names it. The label is looked up at
 * render, never stored here, so it follows the language.
 */
export const GROUP_BY_OPTIONS = [
  { id: "project", labelKey: "fields.project" },
  { id: "client", labelKey: "fields.client" },
  { id: "task", labelKey: "fields.task" },
  { id: "tag", labelKey: "fields.tag" },
  { id: "member", labelKey: "fields.member" },
  { id: "day", labelKey: "time.day" },
  { id: "week", labelKey: "time.week" },
  { id: "month", labelKey: "time.month" },
] as const satisfies readonly { id: ReportGroupBy; labelKey: string }[];

export type GroupByOption = (typeof GROUP_BY_OPTIONS)[number];

export const DEFAULT_GROUP_BY: ReportGroupBy = "project";

export const isGroupBy = (value: string | null): value is ReportGroupBy =>
  GROUP_BY_OPTIONS.some((option) => option.id === value);

/** The `group` param as a grouping; anything unrecognised is by project. */
export const parseGroupBy = (raw: string | null): ReportGroupBy =>
  isGroupBy(raw) ? raw : DEFAULT_GROUP_BY;

/**
 * The report param each grouping's keys are ids for. The time buckets are
 * absent on purpose: a "Week 12" row has no catalog row to filter by.
 */
export const PARAM_FOR_GROUP_BY: Partial<Record<ReportGroupBy, string>> = {
  project: REPORT_PARAM.projects,
  client: REPORT_PARAM.clients,
  task: REPORT_PARAM.tasks,
  tag: REPORT_PARAM.tags,
  member: REPORT_PARAM.members,
};

/**
 * The groupings this viewer is offered. "Member" only when Reports offers the
 * member filter at all (`canReportByMember`): for somebody who sees only their
 * own time it is a one-row table with their own name in it.
 */
export const groupByOptionsFor = (
  memberReporting: boolean
): readonly GroupByOption[] =>
  memberReporting
    ? GROUP_BY_OPTIONS
    : GROUP_BY_OPTIONS.filter((option) => option.id !== "member");

/**
 * The grouping in effect: the URL's, unless it names one this viewer is not
 * offered, in which case the default. A shared `group=member` link must never
 * leave a report grouped by a switch that is not on screen.
 */
export const effectiveGroupBy = (
  raw: string | null,
  memberReporting: boolean
): ReportGroupBy => {
  const parsed = parseGroupBy(raw);
  return parsed === "member" && !memberReporting ? DEFAULT_GROUP_BY : parsed;
};
