"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { parseISO } from "date-fns";
import { CalendarRange, ChevronLeft, ChevronRight, Clock, Plus } from "lucide-react";
import { deviceTimeZone } from "@starter/core";
import {
  addDaysToKey,
  buildTimesheetGrid,
  dayKeyInZone,
  planCellEdit,
  timesheetWeekDays,
  weekStartKey,
  zonedDayStartMs,
  type EntryListInput,
  type TimesheetRow,
  type TimesheetRowSeed,
} from "@starter/shared";

import { EmptyState } from "@/components/empty-state";
import { useAuth } from "@/hooks/use-auth";
import { ProjectPicker } from "@/components/project-picker";
import { TaskPicker } from "@/components/task-picker";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDayRangeLabel } from "@/components/calendar/day-range-label";
import { useNow } from "@/components/calendar/use-now";
import { useFormat } from "@/i18n/use-format";
import { useT } from "@/i18n/use-t";
import { useFormatSettings } from "@/lib/format";
import { reportsHref } from "@/lib/report-links";
import { trpc } from "@/lib/trpc";
import { TimesheetGrid } from "./timesheet-grid";
import { useTimesheetMutations } from "./use-timesheet-mutations";
import { useTimesheetRows } from "./use-timesheet-rows";
import { userErrorMessage } from "@/lib/error-message";

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const WEEK_PARAM = "week";
const DAYS_PER_WEEK = 7;

/** One week of entries is well inside the server's page, but not unbounded. */
const ENTRY_LIMIT = 500;

/** How often a cell holding the running timer catches up with the clock. */
const RUNNING_TICK_MS = 30_000;

/**
 * The device's zone, read once.
 *
 * Days are bucketed here, in the BROWSER's zone, which is what the tracker
 * list does — the grid and the list must never disagree about which day an
 * entry belongs to. (Whether the reports should bucket the same way is a
 * separate question and deliberately not answered here.)
 *
 * Read once because a value with a new identity every render would churn the
 * query key of every request on the page.
 */
const TIME_ZONE: string = deviceTimeZone();

/** "2 – 8 Feb 2026" in the reader's language, from two "YYYY-MM-DD" keys. */
const rangeLabel = (from: string, to: string, intlTag: string): string => {
  const start = parseISO(from);
  const end = parseISO(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return `${from} – ${to}`;
  }
  return formatDayRangeLabel(start, end, intlTag);
};

export function TimesheetScreen(): React.JSX.Element {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const fmt = useFormatSettings();
  const f = useFormat();
  const t = useT("calendar");
  const tc = useT("common");
  const { user } = useAuth();
  const nowMs = useNow(RUNNING_TICK_MS);

  const todayKey = dayKeyInZone(nowMs, TIME_ZONE);
  const currentWeek = weekStartKey(todayKey, fmt.weekStartsOn);

  const weekParam = searchParams.get(WEEK_PARAM);
  const weekStart =
    weekParam !== null && DAY_KEY.test(weekParam) ? weekParam : currentWeek;

  const days = React.useMemo(() => timesheetWeekDays(weekStart), [weekStart]);
  const lastDay = days[DAYS_PER_WEEK - 1] ?? weekStart;

  const goToWeek = React.useCallback(
    (next: string | null): void => {
      const params = new URLSearchParams(searchParams.toString());
      if (next === null) params.delete(WEEK_PARAM);
      else params.set(WEEK_PARAM, next);
      const query = params.toString();
      router.replace(query === "" ? pathname : `${pathname}?${query}`, {
        scroll: false,
      });
    },
    [pathname, router, searchParams]
  );

  // ── the week's entries ─────────────────────────────────────────────
  //
  // The window is sent as explicit INSTANTS rather than as date-only bounds:
  // a bare "2026-02-02" is read as UTC midnight by the entry list, which in
  // any other zone is a couple of hours into the wrong day and would drop the
  // early hours of Monday out of the grid.
  const listInput = React.useMemo<EntryListInput>(
    () => ({
      from: new Date(zonedDayStartMs(weekStart, TIME_ZONE)).toISOString(),
      to: new Date(
        zonedDayStartMs(addDaysToKey(weekStart, DAYS_PER_WEEK), TIME_ZONE)
      ).toISOString(),
      limit: ENTRY_LIMIT,
    }),
    [weekStart]
  );

  const entriesQuery = trpc.entries.list.useQuery(listInput, {
    staleTime: 15_000,
    placeholderData: (previous) => previous,
  });

  const projectsQuery = trpc.projects.list.useQuery({});
  const tasksQuery = trpc.tasks.list.useQuery({});

  const { rows: pinnedRows, pin, unpin } = useTimesheetRows();
  const { applyPlan, isBusy } = useTimesheetMutations(listInput);

  const seeds = React.useMemo<TimesheetRowSeed[]>(() => {
    const projects = projectsQuery.data ?? [];
    const tasks = tasksQuery.data ?? [];
    return pinnedRows.map((row) => {
      const project = projects.find(
        (candidate) => candidate.id === row.projectId
      );
      const task = tasks.find((candidate) => candidate.id === row.taskId);
      const label = project?.name ?? tc("empty.noProject");
      return {
        projectId: row.projectId,
        taskId: row.taskId,
        label: task ? `${label} – ${task.name}` : label,
        color: project?.color ?? null,
      };
    });
  }, [pinnedRows, projectsQuery.data, tasksQuery.data, tc]);

  /**
   * A timesheet is the caller's OWN week.
   *
   * `entries.list` answers with the whole workspace when the member may see
   * other people's time, and mixing that into a row would be wrong twice over:
   * the cell total would not be the hours this person is filing, and a cell
   * holding a colleague's entry would look editable while `entries.update`
   * rightly refuses to touch it. The team's week is what Reports → Totals
   * grouped by day is for.
   */
  const myEntries = React.useMemo(
    () =>
      (entriesQuery.data?.entries ?? []).filter(
        (entry) => entry.authorId === user?.id
      ),
    [entriesQuery.data, user?.id]
  );

  const grid = React.useMemo(
    () =>
      buildTimesheetGrid({
        entries: myEntries,
        days,
        timeZone: TIME_ZONE,
        nowMs,
        seeds,
      }),
    [days, myEntries, nowMs, seeds]
  );

  /**
   * More entries than one page holds means the totals on screen are not the
   * whole week, and an edit resolved against an incomplete cell could rewrite
   * the wrong thing. The grid goes read-only rather than quietly guessing.
   */
  const truncated = entriesQuery.data?.nextCursor !== undefined;

  const handleCommitCell = React.useCallback(
    (row: TimesheetRow, dayIndex: number, seconds: number): void => {
      const cell = row.cells[dayIndex];
      if (cell === undefined) return;

      const plan = planCellEdit({
        cell,
        timeZone: TIME_ZONE,
        targetSeconds: seconds,
      });
      applyPlan(plan, { projectId: row.projectId, taskId: row.taskId });
    },
    [applyPlan]
  );

  const detailHref = React.useCallback(
    (row: TimesheetRow, day: string): string => {
      const params = new URLSearchParams({ from: day, to: day });
      if (row.projectId !== null) params.set("projects", row.projectId);
      if (row.taskId !== null) params.set("tasks", row.taskId);
      return reportsHref("entries", params);
    },
    []
  );

  // ── adding a row ───────────────────────────────────────────────────

  const [draftProject, setDraftProject] = React.useState<string | null>(null);
  const [draftTask, setDraftTask] = React.useState<string | null>(null);

  const addRow = React.useCallback((): void => {
    pin({ projectId: draftProject, taskId: draftTask });
    setDraftProject(null);
    setDraftTask(null);
  }, [draftProject, draftTask, pin]);

  // Without a user id every entry filters out, so the grid would flash empty
  // rather than merely unfilled.
  const isLoading = entriesQuery.isPending || user === null;

  return (
    <div className="space-y-4" data-testid="timesheet-page">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{t("timesheet.title")}</h1>
          <p className="text-sm text-muted-foreground">
            {rangeLabel(weekStart, lastDay, f.intlLocale)}
          </p>
        </div>

        <div className="flex items-center gap-1" data-testid="timesheet-week-nav">
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={t("timesheet.previousWeek")}
            onClick={() => goToWeek(addDaysToKey(weekStart, -DAYS_PER_WEEK))}
            data-testid="timesheet-week-prev"
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Button
            type="button"
            variant="outline"
            className="min-w-44 font-normal"
            onClick={() => goToWeek(null)}
            data-testid="timesheet-week-current"
          >
            {weekStart === currentWeek
              ? tc("time.thisWeek")
              : rangeLabel(weekStart, lastDay, f.intlLocale)}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={t("timesheet.nextWeek")}
            onClick={() => goToWeek(addDaysToKey(weekStart, DAYS_PER_WEEK))}
            data-testid="timesheet-week-next"
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </header>

      <Card>
        <CardContent className="space-y-4 pt-6">
          {truncated ? (
            <p
              className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
              data-testid="timesheet-truncated"
            >
              {t("timesheet.truncated")}
            </p>
          ) : null}

          {isLoading ? (
            <div className="grid gap-2" data-testid="timesheet-skeleton">
              {Array.from({ length: 5 }, (_unused, index) => (
                <Skeleton key={index} className="h-10 w-full" />
              ))}
            </div>
          ) : grid.rows.length === 0 ? (
            <EmptyState
              icon={CalendarRange}
              title={t("timesheet.emptyTitle")}
              description={t("timesheet.emptyDescription")}
              testId="timesheet-empty"
            />
          ) : (
            <TimesheetGrid
              grid={grid}
              durationFormat={fmt.durationFormat}
              duration={fmt.duration}
              clock={fmt.clock}
              detailHref={detailHref}
              onCommitCell={handleCommitCell}
              onUnpinRow={(row) =>
                unpin({ projectId: row.projectId, taskId: row.taskId })
              }
              disabled={truncated}
              todayKey={todayKey}
            />
          )}

          <div
            className="flex flex-wrap items-center gap-2 border-t border-border pt-4"
            data-testid="timesheet-add-row"
          >
            <ProjectPicker
              value={draftProject}
              onChange={setDraftProject}
              size="sm"
              className="w-56"
              testId="timesheet-row-project"
            />
            <TaskPicker
              value={draftTask}
              onChange={setDraftTask}
              size="sm"
              className="w-48"
              testId="timesheet-row-task"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={addRow}
              data-testid="timesheet-add-row-submit"
            >
              <Plus className="size-4" />
              {t("timesheet.addRow")}
            </Button>

            <span className="ml-auto flex items-center gap-1.5 text-sm text-muted-foreground">
              <Clock className="size-4" />
              {t("timesheet.weekTotal")}
              <span
                className="font-medium tabular-nums text-foreground"
                data-testid="timesheet-header-total"
              >
                {fmt.duration(grid.totalSec)}
              </span>
            </span>
          </div>
        </CardContent>
      </Card>

      {entriesQuery.isError ? (
        <p className="text-sm text-destructive" data-testid="timesheet-error">
          {userErrorMessage(entriesQuery.error, undefined, tc)}
        </p>
      ) : null}

      <p className="sr-only" aria-live="polite">
        {isBusy ? tc("status.saving") : tc("status.saved")}
      </p>
    </div>
  );
}
