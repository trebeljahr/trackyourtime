import { addDaysToKey, weekStartKey, type WeekStart } from "@starter/shared";

/**
 * Where Reports lives, and how to link into one of its two views.
 *
 * Pure on purpose: `components/reports/use-report-filters.ts` imports the
 * view parameter from here, and it is a client module with React and
 * next/navigation behind it. So this file spells the handful of query keys it
 * rewrites (`view`, `week`, `group`, `from`, `to`) as its own literals rather
 * than reaching back into that module.
 */

export const REPORTS_PATH = "/app/reports";
export const REPORT_VIEW_PARAM = "view";

export type ReportView = "totals" | "entries";
export const DEFAULT_REPORT_VIEW: ReportView = "totals";

/** The old weekly report's own week parameter. Reports no longer reads it. */
const LEGACY_WEEK_PARAM = "week";
const GROUP_PARAM = "group";
const FROM_PARAM = "from";
const TO_PARAM = "to";

const DAYS_PER_WEEK = 7;
const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The filters a weekly report link carries over into Totals. */
const WEEKLY_KEPT_PARAMS = [
  "projects",
  "clients",
  "tasks",
  "tags",
  "billable",
  "q",
] as const;

/** "entries" is the only other view; anything else, absent included, is Totals. */
export function parseReportView(raw: string | null): ReportView {
  return raw === "entries" ? "entries" : DEFAULT_REPORT_VIEW;
}

const toSearchParams = (
  params: URLSearchParams | Record<string, string> | string | undefined,
): URLSearchParams => {
  if (params === undefined) return new URLSearchParams();
  if (typeof params === "string") {
    return new URLSearchParams(params.startsWith("?") ? params.slice(1) : params);
  }
  // Copy, so a caller's URLSearchParams is never mutated underneath it.
  return new URLSearchParams(params);
};

/**
 * `/app/reports` in the given view, carrying `params` along.
 *
 * Totals is the default and writes no `view` at all, so the plain Reports
 * link and a Totals link are the same URL. A `view` already in `params` is
 * replaced rather than duplicated, and the retired `week` parameter is dropped.
 */
export function reportsHref(
  view: ReportView,
  params?: URLSearchParams | Record<string, string> | string,
): string {
  const next = toSearchParams(params);
  next.delete(REPORT_VIEW_PARAM);
  next.delete(LEGACY_WEEK_PARAM);
  if (view !== DEFAULT_REPORT_VIEW) next.set(REPORT_VIEW_PARAM, view);

  const query = next.toString();
  return query === "" ? REPORTS_PATH : `${REPORTS_PATH}?${query}`;
}

/** True for a real calendar date written as YYYY-MM-DD (so not 2026-02-30). */
const isValidDayKey = (value: string): boolean => {
  const match = DAY_KEY.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
};

/** The device-local calendar day of `date`, as YYYY-MM-DD. */
const localDayKey = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;

/**
 * Where a bookmark to one of the retired report routes lands now.
 *
 * - `summary` is Totals, unchanged.
 * - `detailed` is Entries; `group` is dropped because Entries has no grouping.
 * - `weekly` is Totals for that week grouped by day, which is what the grid
 *   added up. The week comes from its `week` parameter snapped to
 *   `weekStartsOn` (a mid-week date still means that week), else the week
 *   containing `today`. Only the catalogue filters survive: the weekly report
 *   ignored `from`/`to` and had no sorting of its own.
 */
export function legacyReportRedirect(
  kind: "summary" | "detailed" | "weekly",
  search: string,
  weekStartsOn: WeekStart,
  today: Date = new Date(),
): string {
  const source = toSearchParams(search);

  if (kind === "summary") return reportsHref("totals", source);

  if (kind === "detailed") {
    source.delete(GROUP_PARAM);
    return reportsHref("entries", source);
  }

  const weekParam = source.get(LEGACY_WEEK_PARAM);
  const anchor =
    weekParam !== null && isValidDayKey(weekParam) ? weekParam : localDayKey(today);
  const from = weekStartKey(anchor, weekStartsOn);
  const to = addDaysToKey(from, DAYS_PER_WEEK - 1);

  const next = new URLSearchParams({
    [FROM_PARAM]: from,
    [TO_PARAM]: to,
    [GROUP_PARAM]: "day",
  });
  for (const key of WEEKLY_KEPT_PARAMS) {
    for (const value of source.getAll(key)) next.append(key, value);
  }

  return reportsHref("totals", next);
}
