import type { ReportGroupBy } from "@starter/shared";

import { REPORT_PARAM } from "@/components/reports/use-report-filters";

/**
 * The dimensions Totals can be grouped by, in switch order. Lives beside the
 * report filters rather than inside the Totals view because the screen needs
 * the grouping too: the export sends it along with the summary report.
 */
export const GROUP_BY_OPTIONS: { id: ReportGroupBy; label: string }[] = [
  { id: "project", label: "Project" },
  { id: "client", label: "Client" },
  { id: "task", label: "Task" },
  { id: "tag", label: "Tag" },
  { id: "day", label: "Day" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
];

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
};
