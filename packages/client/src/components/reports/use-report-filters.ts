"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { ReportFilters, WeekStart } from "@starter/shared";

import {
  rangeForPreset,
  type DateRange,
} from "@/components/date-range-picker";
import { useFormatSettings } from "@/lib/format";
import {
  parseReportView,
  REPORT_VIEW_PARAM,
  type ReportView,
} from "@/lib/report-links";

/**
 * Query-string parameter names. Both views of `/app/reports` read and write the
 * same keys, so switching between Totals and Entries carries the filters along
 * and any report URL is shareable and survives a reload.
 */
export const REPORT_PARAM = {
  from: "from",
  to: "to",
  projects: "projects",
  clients: "clients",
  tasks: "tasks",
  tags: "tags",
  members: "members",
  billable: "billable",
  search: "q",
  groupBy: "group",
  sort: "sort",
  dir: "dir",
  view: REPORT_VIEW_PARAM,
} as const;

/** Billable is a tri-state: absent = all, "yes" = billable, "no" = not. */
export type BillableFilter = "all" | "yes" | "no";

export type ReportFilterState = {
  range: DateRange;
  projectIds: string[];
  clientIds: string[];
  taskIds: string[];
  tagIds: string[];
  /**
   * Authors to narrow to. Optional so a state built before members existed
   * still type-checks; absent and empty both mean "everyone the caller may see".
   */
  memberIds?: string[];
  billable: BillableFilter;
  search: string;
};

/** Which id list a multi-select writes to. */
export type IdFilterKey =
  | "projectIds"
  | "clientIds"
  | "taskIds"
  | "tagIds"
  | "memberIds";

const PARAM_FOR_IDS: Record<IdFilterKey, string> = {
  projectIds: REPORT_PARAM.projects,
  clientIds: REPORT_PARAM.clients,
  taskIds: REPORT_PARAM.tasks,
  tagIds: REPORT_PARAM.tags,
  memberIds: REPORT_PARAM.members,
};

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

const parseIds = (raw: string | null): string[] => {
  if (raw === null) return [];
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
};

const parseBillable = (raw: string | null): BillableFilter =>
  raw === "yes" || raw === "no" ? raw : "all";

const parseDateKey = (raw: string | null): string | null =>
  raw !== null && DATE_KEY.test(raw) ? raw : null;

/**
 * The device's IANA zone, e.g. "Europe/Berlin".
 *
 * Read once: it is stable for the session, and a value that changed identity
 * between renders would churn every report's query key. Falls back to UTC where
 * the runtime cannot say (and on the server during prerender).
 */
export const DEVICE_TIME_ZONE: string = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
})();

/**
 * The server-side filter payload — empty selections are omitted entirely.
 *
 * `timeZone` travels with every report so days, weeks and months are bucketed
 * in the zone the user is actually in. Without it the server answers in its own
 * zone (UTC on a deployment) and files after-midnight work under the previous
 * day, disagreeing with the tracker list.
 */
export const toReportFilters = (state: ReportFilterState): ReportFilters => ({
  from: state.range.from,
  to: state.range.to,
  timeZone: DEVICE_TIME_ZONE,
  ...(state.projectIds.length > 0 ? { projectIds: state.projectIds } : {}),
  ...(state.clientIds.length > 0 ? { clientIds: state.clientIds } : {}),
  ...(state.taskIds.length > 0 ? { taskIds: state.taskIds } : {}),
  ...(state.tagIds.length > 0 ? { tagIds: state.tagIds } : {}),
  ...((state.memberIds ?? []).length > 0 ? { memberIds: state.memberIds } : {}),
  ...(state.billable === "all" ? {} : { billable: state.billable === "yes" }),
  ...(state.search.trim().length > 0 ? { search: state.search.trim() } : {}),
});

export type UseReportFiltersResult = {
  state: ReportFilterState;
  /** Ready to spread into `reports.*` / `entries.list` inputs. */
  filters: ReportFilters;
  weekStartsOn: WeekStart;
  /** Totals or Entries, from the `view` param. */
  view: ReportView;
  /**
   * Switches the view and nothing else. Sort, direction and grouping stay in
   * the URL even while the other view ignores them, so switching back finds
   * the report exactly as it was left.
   */
  setView: (view: ReportView) => void;
  /** True when anything beyond the date range narrows the report. */
  isFiltered: boolean;
  setRange: (range: DateRange) => void;
  setIds: (key: IdFilterKey, ids: string[]) => void;
  setBillable: (value: BillableFilter) => void;
  setSearch: (value: string) => void;
  getParam: (key: string) => string | null;
  setParam: (key: string, value: string | null) => void;
  setParams: (
    patch: Record<string, string | null>,
    options?: SetParamsOptions
  ) => void;
  clearFilters: () => void;
};

/**
 * How a URL change lands in history. Filter edits `replace` (the default), so
 * typing a search does not leave one Back step per keystroke.
 */
export type SetParamsOptions = { history?: "push" | "replace" };

/** What the screen hands each report view. */
export type ReportViewProps = {
  /** Owned by the screen, which renders the filter bar above the view. */
  filters: UseReportFiltersResult;
  /** Whether the export has anything to describe yet. */
  onExportReady: (ready: boolean) => void;
  /** Whether "group by member" is offered — see `useMemberReporting`. */
  memberReporting?: boolean;
};

/**
 * Report filter state, stored in the URL rather than component state.
 *
 * Nothing is written until the user actually changes something, so a bare
 * `/app/reports` keeps a clean URL while still defaulting to this week.
 */
export type UseReportFiltersOptions = {
  /**
   * Whether this viewer is offered the member filter. When they are not, a
   * `members` param in the URL (a link an admin shared, say) is ignored rather
   * than applied: a filter nobody can see or clear is a report that silently
   * shows less than the screen claims. The server intersects it with what the
   * caller may see either way, so this is about honesty, not access.
   */
  memberFilter?: boolean;
};

export const useReportFilters = (
  options: UseReportFiltersOptions = {}
): UseReportFiltersResult => {
  const memberFilter = options.memberFilter === true;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { weekStartsOn } = useFormatSettings();

  const fromParam = parseDateKey(searchParams.get(REPORT_PARAM.from));
  const toParam = parseDateKey(searchParams.get(REPORT_PARAM.to));

  // Recomputed only when the calendar day rolls over, so "this week" cannot
  // produce a new object on every render and thrash the query key.
  const defaultRange = React.useMemo(
    () => rangeForPreset("thisWeek", weekStartsOn),
    [weekStartsOn]
  );

  const range = React.useMemo<DateRange>(() => {
    if (fromParam === null && toParam === null) return defaultRange;
    const from = fromParam ?? toParam ?? defaultRange.from;
    const to = toParam ?? fromParam ?? defaultRange.to;
    return from > to ? { from: to, to: from } : { from, to };
  }, [defaultRange, fromParam, toParam]);

  const projectsParam = searchParams.get(REPORT_PARAM.projects);
  const clientsParam = searchParams.get(REPORT_PARAM.clients);
  const tasksParam = searchParams.get(REPORT_PARAM.tasks);
  const tagsParam = searchParams.get(REPORT_PARAM.tags);
  const membersParam = memberFilter
    ? searchParams.get(REPORT_PARAM.members)
    : null;
  const billableParam = searchParams.get(REPORT_PARAM.billable);
  const searchParam = searchParams.get(REPORT_PARAM.search);

  const state = React.useMemo<ReportFilterState>(
    () => ({
      range,
      projectIds: parseIds(projectsParam),
      clientIds: parseIds(clientsParam),
      taskIds: parseIds(tasksParam),
      tagIds: parseIds(tagsParam),
      memberIds: parseIds(membersParam),
      billable: parseBillable(billableParam),
      search: searchParam ?? "",
    }),
    [
      range,
      projectsParam,
      clientsParam,
      tasksParam,
      tagsParam,
      membersParam,
      billableParam,
      searchParam,
    ]
  );

  const filters = React.useMemo(() => toReportFilters(state), [state]);

  const searchString = searchParams.toString();

  const setParams = React.useCallback(
    (
      patch: Record<string, string | null>,
      options?: SetParamsOptions
    ): void => {
      const next = new URLSearchParams(searchString);
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === "") next.delete(key);
        else next.set(key, value);
      }
      const query = next.toString();
      const href = query === "" ? pathname : `${pathname}?${query}`;
      if (options?.history === "push") router.push(href, { scroll: false });
      else router.replace(href, { scroll: false });
    },
    [pathname, router, searchString]
  );

  const setParam = React.useCallback(
    (key: string, value: string | null): void => {
      setParams({ [key]: value });
    },
    [setParams]
  );

  const setRange = React.useCallback(
    (next: DateRange): void => {
      setParams({
        [REPORT_PARAM.from]: next.from,
        [REPORT_PARAM.to]: next.to,
      });
    },
    [setParams]
  );

  const setIds = React.useCallback(
    (key: IdFilterKey, ids: string[]): void => {
      setParams({ [PARAM_FOR_IDS[key]]: ids.length > 0 ? ids.join(",") : null });
    },
    [setParams]
  );

  const setBillable = React.useCallback(
    (value: BillableFilter): void => {
      setParams({ [REPORT_PARAM.billable]: value === "all" ? null : value });
    },
    [setParams]
  );

  const setSearch = React.useCallback(
    (value: string): void => {
      setParams({ [REPORT_PARAM.search]: value.trim() === "" ? null : value });
    },
    [setParams]
  );

  const view = parseReportView(searchParams.get(REPORT_PARAM.view));

  const setView = React.useCallback(
    (next: ReportView): void => {
      // Totals is the default, so it is the absence of the param: the clean
      // `/app/reports` URL and the Totals view are the same page.
      //
      // A view switch pushes, where a filter edit replaces: Totals and Entries
      // are two places, and Back from Entries returns to Totals — the way it
      // did when they were separate routes, and the way it does after the
      // drill-down link, which is a push too.
      setParams(
        { [REPORT_PARAM.view]: next === "entries" ? next : null },
        { history: "push" }
      );
    },
    [setParams]
  );

  const clearFilters = React.useCallback((): void => {
    setParams({
      [REPORT_PARAM.projects]: null,
      [REPORT_PARAM.clients]: null,
      [REPORT_PARAM.tasks]: null,
      [REPORT_PARAM.tags]: null,
      [REPORT_PARAM.members]: null,
      [REPORT_PARAM.billable]: null,
      [REPORT_PARAM.search]: null,
    });
  }, [setParams]);

  const getParam = React.useCallback(
    (key: string): string | null => searchParams.get(key),
    [searchParams]
  );

  const isFiltered =
    state.projectIds.length > 0 ||
    state.clientIds.length > 0 ||
    state.taskIds.length > 0 ||
    state.tagIds.length > 0 ||
    (state.memberIds ?? []).length > 0 ||
    state.billable !== "all" ||
    state.search.trim().length > 0;

  return {
    state,
    filters,
    weekStartsOn,
    view,
    setView,
    isFiltered,
    setRange,
    setIds,
    setBillable,
    setSearch,
    getParam,
    setParam,
    setParams,
    clearFilters,
  };
};
