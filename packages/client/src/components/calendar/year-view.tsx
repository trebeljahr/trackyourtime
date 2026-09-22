"use client";

import * as React from "react";
import {
  endOfMonth,
  endOfYear,
  getDay,
  isSameDay,
  startOfMonth,
  startOfYear,
} from "date-fns";
import type {
  SummaryGroup,
  SummaryTimelinePoint,
  WeekStart,
} from "@starter/shared";

import { Skeleton } from "@/components/ui/skeleton";
import { toDateKey } from "@/components/date-range-picker";
import { DEVICE_TIME_ZONE } from "@/components/reports/use-report-filters";
import { useFormat } from "@/i18n/use-format";
import { useT } from "@/i18n/use-t";
import { useFormatSettings } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { NO_PROJECT_COLOR } from "./entry-color";
import { daySharesOf, heatFill, intensityOf, type DayShare } from "./year-heat";

/**
 * The hue of a day whose server sent no per-project split (one from before
 * `SummaryTimelinePoint.shares`): the old single-color heatmap.
 */
const FALLBACK_HUE = "hsl(var(--primary))";

/** How many projects a day's tooltip names. */
const TOOLTIP_SHARES = 3;

type YearDay = {
  date: Date;
  key: string;
  seconds: number;
  /**
   * The day's projects, biggest first; the first one paints the cell.
   * `null` when the server sent no split.
   */
  shares: DayShare[] | null;
};

type YearMonth = {
  index: number;
  label: string;
  totalSec: number;
  /** Empty cells before the first of the month, so weekdays line up. */
  lead: number;
  days: YearDay[];
};

export type YearViewProps = {
  /** Any date inside the year to render. */
  year: Date;
  weekStartsOn: WeekStart;
  /** Clicking a day opens it in the day view. */
  onSelectDay: (date: Date) => void;
};

/**
 * The reporting view: one heatmap per month for a whole year, plus the year's
 * totals and its project split.
 *
 * Unlike the other views this one never loads entries — a year of them would
 * blow past the list limit and there is nothing to drag here anyway. It reads
 * `reports.summary`, whose per-day timeline is exactly what a heatmap needs.
 */
export function YearView({
  year,
  weekStartsOn,
  onSelectDay,
}: YearViewProps): React.JSX.Element {
  const format = useFormatSettings();
  const f = useFormat();
  const t = useT("calendar");
  const tc = useT("common");
  const yearNumber = year.getFullYear();

  const summary = trpc.reports.summary.useQuery(
    {
      from: toDateKey(startOfYear(new Date(yearNumber, 0, 1))),
      to: toDateKey(endOfYear(new Date(yearNumber, 0, 1))),
      groupBy: "project",
      timeZone: DEVICE_TIME_ZONE,
    },
    { staleTime: 60_000 }
  );

  const pointsByDay = React.useMemo<Map<string, SummaryTimelinePoint>>(() => {
    const map = new Map<string, SummaryTimelinePoint>();
    for (const point of summary.data?.timeline ?? []) {
      map.set(point.date, point);
    }
    return map;
  }, [summary.data]);

  const groupsByKey = React.useMemo<Map<string, SummaryGroup>>(() => {
    const map = new Map<string, SummaryGroup>();
    for (const group of summary.data?.groups ?? []) {
      map.set(group.key, group);
    }
    return map;
  }, [summary.data]);

  const noProjectLabel = tc("empty.noProject");

  const months = React.useMemo<YearMonth[]>(() => {
    return Array.from({ length: 12 }, (_, index) => {
      const first = startOfMonth(new Date(yearNumber, index, 1));
      const last = endOfMonth(first);
      const lead = (getDay(first) - weekStartsOn + 7) % 7;

      const days: YearDay[] = [];
      let totalSec = 0;
      for (let day = 1; day <= last.getDate(); day += 1) {
        const date = new Date(yearNumber, index, day);
        const key = toDateKey(date);
        const point = pointsByDay.get(key);
        const seconds = point?.seconds ?? 0;
        totalSec += seconds;
        days.push({
          date,
          key,
          seconds,
          shares: daySharesOf(point, groupsByKey, noProjectLabel),
        });
      }

      return {
        index,
        label: f.date(first, { month: "long" }),
        totalSec,
        lead,
        days,
      };
    });
  }, [f, groupsByKey, noProjectLabel, pointsByDay, weekStartsOn, yearNumber]);

  const stats = React.useMemo(() => {
    let busiest: YearDay | null = null;
    let trackedDays = 0;
    let totalSec = 0;

    for (const month of months) {
      for (const day of month.days) {
        if (day.seconds <= 0) continue;
        trackedDays += 1;
        totalSec += day.seconds;
        if (!busiest || day.seconds > busiest.seconds) busiest = day;
      }
    }

    return {
      totalSec,
      trackedDays,
      busiest,
      averageSec: trackedDays > 0 ? totalSec / trackedDays : 0,
    };
  }, [months]);

  const weekdayInitials = React.useMemo<string[]>(
    () =>
      Array.from({ length: 7 }, (_, index) =>
        f.weekday(weekStartsOn + index, "narrow").slice(0, 1)
      ),
    [f, weekStartsOn]
  );

  const today = new Date();

  if (summary.isPending) {
    return (
      <div
        className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
        data-testid="calendar-year"
      >
        {Array.from({ length: 12 }, (_, index) => (
          <Skeleton key={index} className="h-44 w-full" />
        ))}
      </div>
    );
  }

  const projects = summary.data?.groups ?? [];
  const projectTotal = projects.reduce((sum, group) => sum + group.seconds, 0);

  return (
    <div className="space-y-4" data-testid="calendar-year">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          {
            id: "total",
            label: t("year.trackedThisYear"),
            value: format.durationShort(stats.totalSec),
          },
          {
            id: "days",
            label: t("year.daysTracked"),
            value: f.number(stats.trackedDays),
          },
          {
            id: "average",
            label: t("year.averagePerDay"),
            value: format.durationShort(Math.round(stats.averageSec)),
          },
          {
            id: "busiest",
            label: t("year.busiestDay"),
            value: stats.busiest
              ? `${f.date(stats.busiest.date, "dayMonth")} · ${format.durationShort(
                  stats.busiest.seconds
                )}`
              : "–",
          },
        ].map((stat) => (
          <div
            key={stat.id}
            data-testid={`calendar-year-stat-${stat.id}`}
            className="border-border rounded-md border p-3"
          >
            <div className="text-muted-foreground text-xs">{stat.label}</div>
            <div className="mt-1 text-lg font-semibold tabular-nums">
              {stat.value}
            </div>
          </div>
        ))}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {months.map((month) => {
          // Scale each month against its own busiest day: a heatmap scaled to
          // the whole year washes out every quiet month into one flat tone.
          const busiestSec = month.days.reduce(
            (max, day) => Math.max(max, day.seconds),
            0
          );

          return (
            <div
              key={month.index}
              data-testid={`calendar-year-month-${month.index + 1}`}
              className="border-border rounded-md border p-3"
            >
              <div className="mb-2 flex items-baseline justify-between">
                <span className="text-sm font-medium">{month.label}</span>
                <span className="text-muted-foreground text-xs tabular-nums">
                  {month.totalSec > 0
                    ? format.durationShort(month.totalSec)
                    : "–"}
                </span>
              </div>

              <div className="text-muted-foreground grid grid-cols-7 gap-1 text-center text-[0.6rem] uppercase">
                {weekdayInitials.map((initial, index) => (
                  <span key={`${initial}-${index}`}>{initial}</span>
                ))}
              </div>

              <div className="mt-1 grid grid-cols-7 gap-1">
                {Array.from({ length: month.lead }, (_, index) => (
                  <span key={`lead-${index}`} aria-hidden />
                ))}
                {month.days.map((day) => {
                  // Painted in the project that took most of the day, as
                  // strongly as the day was busy — so a month reads as
                  // "mostly the rebrand, two days of support" at a glance,
                  // where one hue only said "busy" or "quiet".
                  const dominant = day.shares?.[0];
                  const fill = heatFill(
                    dominant?.color ?? FALLBACK_HUE,
                    intensityOf(day.seconds, busiestSec)
                  );
                  const split = day.shares
                    ?.slice(0, TOOLTIP_SHARES)
                    .map(
                      (share) =>
                        `${share.label} ${format.durationShort(share.seconds)}`
                    )
                    .join(", ");
                  const title = [
                    f.date(day.date, "dayLabel"),
                    day.seconds > 0
                      ? format.durationShort(day.seconds)
                      : t("year.nothingTracked"),
                    split || null,
                  ]
                    .filter((part) => part !== null)
                    .join(" · ");

                  return (
                    <button
                      key={day.key}
                      type="button"
                      data-testid={`calendar-year-day-${day.key}`}
                      data-project={dominant?.key}
                      title={title}
                      onClick={() => {
                        onSelectDay(day.date);
                      }}
                      style={fill ? { background: fill } : undefined}
                      className={cn(
                        "focus-visible:ring-ring aspect-square rounded-[3px] text-[0.6rem] tabular-nums transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:outline-none",
                        fill ? "text-foreground" : "bg-muted text-transparent",
                        isSameDay(day.date, today) && "ring-primary ring-1"
                      )}
                    >
                      {f.number(day.date.getDate())}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {projects.length > 0 ? (
        <div className="border-border rounded-md border p-3">
          <div className="mb-2 text-sm font-medium">
            {t("year.projectsThisYear")}
          </div>
          <ul className="space-y-1.5">
            {projects.slice(0, 8).map((group) => (
              <li
                key={group.key}
                className="flex items-center gap-2 text-xs"
                data-testid={`calendar-year-project-${group.key}`}
              >
                <span
                  aria-hidden
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ background: group.color ?? NO_PROJECT_COLOR }}
                />
                <span className="w-40 truncate">{group.label}</span>
                <span className="bg-muted h-1.5 flex-1 overflow-hidden rounded-full">
                  <span
                    className="block h-full rounded-full"
                    style={{
                      width:
                        projectTotal > 0
                          ? `${(group.seconds / projectTotal) * 100}%`
                          : "0%",
                      background: group.color ?? NO_PROJECT_COLOR,
                    }}
                  />
                </span>
                <span className="text-muted-foreground w-16 text-right tabular-nums">
                  {format.durationShort(group.seconds)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
