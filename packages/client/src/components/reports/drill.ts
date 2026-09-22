import { addDaysToKey, type ReportGroupBy } from "@starter/shared";

import type { DateRange } from "@/components/date-range-picker";
import { PARAM_FOR_GROUP_BY } from "@/components/reports/group-by";
import type { TimelineGranularity } from "@/components/reports/timeline-buckets";
import {
  REPORT_PARAM,
  type ReportFilterState,
} from "@/components/reports/use-report-filters";

/**
 * Drilling: one click on a slice, a bar or a legend row narrows the report to
 * what that mark stands for, and re-groups it by the next dimension down so
 * the screen answers the next question instead of showing one 100 % slice.
 *
 * Everything here is pure and works on the URL parameter patch the filter hook
 * applies, so the charts, the legend and the table cannot disagree about what
 * a click does. The step trail and the Back button live in
 * `use-report-filters.ts` (`DrillStep`, `drill`, `drillBackTo`).
 */

/**
 * The group key the server uses for "no project" / "no client" / "no task" /
 * "no tag". There is no filter that means "entries without one", so such a
 * group cannot be drilled into.
 */
export const UNASSIGNED_GROUP_KEY = "none";

/** The pie's synthetic slice that folds the smallest groups together. */
export const OTHER_SLICE_KEY = "__other";

export const TIME_GROUPINGS: readonly ReportGroupBy[] = ["day", "week", "month"];

export const isTimeGrouping = (
  groupBy: ReportGroupBy
): groupBy is TimelineGranularity =>
  groupBy === "day" || groupBy === "week" || groupBy === "month";

/** Whether a group with this key can be narrowed to. */
export const isDrillableKey = (key: string): boolean =>
  key !== UNASSIGNED_GROUP_KEY && key !== OTHER_SLICE_KEY && key !== "";

const DAYS_PER_WEEK = 7;

const lastDayOfMonth = (year: number, month: number): number =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

/**
 * The calendar days a bucket covers, clipped to the range on screen.
 *
 * `key` is the bucket's first day ("2026-09-07"), or for a month bucket the
 * server's "2026-09". Clipped, because a week bucket at the edge of the range
 * holds fewer than seven days, and drilling into it must not widen the report
 * to days that were never in it.
 */
export const bucketRange = (
  key: string,
  granularity: TimelineGranularity,
  within: DateRange
): DateRange => {
  const start = key.length === 7 ? `${key}-01` : key;
  let end: string;
  switch (granularity) {
    case "day":
      end = start;
      break;
    case "week":
      end = addDaysToKey(start, DAYS_PER_WEEK - 1);
      break;
    case "month": {
      const year = Number(start.slice(0, 4));
      const month = Number(start.slice(5, 7));
      end = `${start.slice(0, 7)}-${String(lastDayOfMonth(year, month)).padStart(2, "0")}`;
      break;
    }
  }
  // Day keys are ISO, so string order is date order.
  const from = start > within.from ? start : within.from;
  const to = end < within.to ? end : within.to;
  return from > to ? { from: start, to: end } : { from, to };
};

/**
 * Where to re-group after narrowing by `groupBy`: the next dimension down
 * that the report is not already narrowed to. A client opens into its
 * projects, a project into its tasks, a month into its weeks, a week into its
 * days, a day into the projects worked on it. When every catalog dimension is
 * already pinned, the time dimensions remain — a report narrowed to one
 * project and one task still has something to say per day.
 */
export const nextGroupByAfterDrill = (
  groupBy: ReportGroupBy,
  state: ReportFilterState,
  memberReporting = false
): ReportGroupBy => {
  const narrowed: Record<ReportGroupBy, boolean> = {
    client: state.clientIds.length > 0,
    project: state.projectIds.length > 0,
    task: state.taskIds.length > 0,
    tag: state.tagIds.length > 0,
    member: !memberReporting || (state.memberIds ?? []).length > 0,
    day: state.range.from === state.range.to,
    week: false,
    month: false,
  };
  // The dimension being drilled is about to be narrowed, whatever the state
  // says now.
  narrowed[groupBy] = true;

  const candidates: Record<ReportGroupBy, readonly ReportGroupBy[]> = {
    client: ["project", "task", "tag", "day"],
    project: ["task", "tag", "client", "day"],
    task: ["project", "tag", "client", "day"],
    tag: ["project", "task", "client", "day"],
    member: ["project", "task", "tag", "day"],
    month: ["week", "day"],
    week: ["day", "project", "task", "tag"],
    day: ["project", "task", "tag", "client"],
  };

  for (const candidate of candidates[groupBy]) {
    if (!narrowed[candidate]) return candidate;
  }
  return groupBy === "day" ? "day" : "week";
};

const RANK: Record<TimelineGranularity, number> = { month: 0, week: 1, day: 2 };

/**
 * The grouping after a timeline bar was drilled into. A report grouped by a
 * time unit at least as coarse as the bar's steps down one unit (months →
 * weeks, weeks → days); any other grouping is kept — narrowing the days does
 * not change what the question was about.
 */
export const groupByAfterBucketDrill = (
  groupBy: ReportGroupBy,
  granularity: TimelineGranularity,
  state: ReportFilterState,
  memberReporting = false
): ReportGroupBy => {
  if (!isTimeGrouping(groupBy) || RANK[groupBy] > RANK[granularity]) {
    return groupBy;
  }
  return nextGroupByAfterDrill(granularity, state, memberReporting);
};

/** A URL patch — `null` deletes the key — the filter hook applies as one write. */
export type ParamPatch = Record<string, string | null>;

const groupParam = (groupBy: ReportGroupBy): string | null =>
  groupBy === "project" ? null : groupBy;

/**
 * The patch that narrows the report to `key` of the `groupBy` dimension, and
 * re-groups it. Narrowing REPLACES the dimension's selection rather than
 * adding to it: a report of two projects drilled into one is about that one.
 * Returns null for a group that cannot be narrowed to.
 */
export const drillIntoGroupPatch = (
  groupBy: ReportGroupBy,
  key: string,
  state: ReportFilterState,
  memberReporting = false
): ParamPatch | null => {
  if (!isDrillableKey(key)) return null;

  if (isTimeGrouping(groupBy)) {
    const range = bucketRange(key, groupBy, state.range);
    return {
      [REPORT_PARAM.from]: range.from,
      [REPORT_PARAM.to]: range.to,
      [REPORT_PARAM.groupBy]: groupParam(
        nextGroupByAfterDrill(groupBy, state, memberReporting)
      ),
    };
  }

  const param = PARAM_FOR_GROUP_BY[groupBy];
  if (param === undefined) return null;
  return {
    [param]: key,
    [REPORT_PARAM.groupBy]: groupParam(
      nextGroupByAfterDrill(groupBy, state, memberReporting)
    ),
  };
};

/** The patch that narrows the report to one timeline bar. */
export const drillIntoBucketPatch = (
  bucketKey: string,
  granularity: TimelineGranularity,
  groupBy: ReportGroupBy,
  state: ReportFilterState,
  memberReporting = false
): ParamPatch => {
  const range = bucketRange(bucketKey, granularity, state.range);
  return {
    [REPORT_PARAM.from]: range.from,
    [REPORT_PARAM.to]: range.to,
    [REPORT_PARAM.groupBy]: groupParam(
      groupByAfterBucketDrill(groupBy, granularity, state, memberReporting)
    ),
  };
};
