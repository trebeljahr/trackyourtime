"use client";

import * as React from "react";
import {
  addDays,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  isSameDay,
  isSameMonth,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import type { DetailedEntry, WeekStart } from "@starter/shared";

import { Skeleton } from "@/components/ui/skeleton";
import { useFormat } from "@/i18n/use-format";
import { useT } from "@/i18n/use-t";
import { useFormatSettings } from "@/lib/format";
import { cn } from "@/lib/utils";
import { toDateKey } from "@/components/date-range-picker";
import { daySegment } from "./calendar-math";
import { NO_PROJECT_COLOR } from "./entry-color";
import { useNow } from "./use-now";

/** A project's share of one day, used for the stacked day bar. */
type ProjectShare = {
  key: string;
  label: string;
  color: string;
  seconds: number;
};

type MonthDay = {
  date: Date;
  key: string;
  inMonth: boolean;
  totalSec: number;
  /** Top three projects of the day, by tracked seconds. */
  top: ProjectShare[];
};

export type MonthViewProps = {
  /** Any date inside the month to render. */
  month: Date;
  entries: DetailedEntry[];
  isLoading: boolean;
  weekStartsOn: WeekStart;
  /** Clicking a day jumps to that week. */
  onSelectDay: (date: Date) => void;
};

/**
 * Month overview: one cell per day with the day's total, a bar scaled against
 * the busiest day of the month and the day's top three projects by color.
 */
export function MonthView({
  month,
  entries,
  isLoading,
  weekStartsOn,
  onSelectDay,
}: MonthViewProps): React.JSX.Element {
  const format = useFormatSettings();
  const f = useFormat();
  const tc = useT("common");
  const monthMs = startOfMonth(month).getTime();
  const nowMs = useNow(60_000);
  const nowDate = React.useMemo(() => new Date(nowMs), [nowMs]);

  const days = React.useMemo<MonthDay[]>(() => {
    const first = startOfWeek(new Date(monthMs), { weekStartsOn });
    const last = endOfWeek(endOfMonth(new Date(monthMs)), { weekStartsOn });

    return eachDayOfInterval({ start: first, end: last }).map((date) => {
      const dayStartMs = startOfDay(date).getTime();
      const dayEndMs = startOfDay(addDays(date, 1)).getTime();
      const byProject = new Map<string, ProjectShare>();
      let totalSec = 0;

      for (const entry of entries) {
        const startMs = Date.parse(entry.start);
        const endMs =
          entry.end === null
            ? Math.max(nowMs, startMs)
            : Date.parse(entry.end);
        const segment = daySegment(startMs, endMs, dayStartMs, dayEndMs);
        if (!segment) continue;

        const seconds = Math.max(0, segment.endMin - segment.startMin) * 60;
        totalSec += seconds;

        const key = entry.projectId ?? "none";
        const existing = byProject.get(key);
        if (existing) {
          existing.seconds += seconds;
        } else {
          byProject.set(key, {
            key,
            label: entry.projectName ?? tc("empty.noProject"),
            color: entry.projectColor ?? NO_PROJECT_COLOR,
            seconds,
          });
        }
      }

      return {
        date,
        key: toDateKey(date),
        inMonth: isSameMonth(date, new Date(monthMs)),
        totalSec,
        top: [...byProject.values()]
          .sort((a, b) => b.seconds - a.seconds)
          .slice(0, 3),
      };
    });
  }, [entries, monthMs, nowMs, tc, weekStartsOn]);

  const busiestSec = days.reduce((max, day) => Math.max(max, day.totalSec), 0);

  const weekdayLabels = React.useMemo<string[]>(
    () =>
      Array.from({ length: 7 }, (_, index) =>
        f.weekday(weekStartsOn + index, "short")
      ),
    [f, weekStartsOn]
  );

  if (isLoading) {
    return (
      <div className="grid grid-cols-7 gap-2" data-testid="calendar-month">
        {Array.from({ length: 35 }, (_, index) => (
          <Skeleton key={index} className="h-24 w-full" />
        ))}
      </div>
    );
  }

  return (
    <div data-testid="calendar-month" className="space-y-2">
      <div className="text-muted-foreground grid grid-cols-7 gap-2 text-xs tracking-wide uppercase">
        {weekdayLabels.map((label) => (
          <span key={label} className="px-1">
            {label}
          </span>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-2">
        {days.map((day) => {
          const isToday = isSameDay(day.date, nowDate);
          const barPct =
            busiestSec > 0 ? Math.round((day.totalSec / busiestSec) * 100) : 0;
          const topSec = day.top.reduce((sum, share) => sum + share.seconds, 0);

          return (
            <button
              key={day.key}
              type="button"
              data-testid={`calendar-month-day-${day.key}`}
              onClick={() => {
                onSelectDay(day.date);
              }}
              className={cn(
                "border-border hover:bg-accent/40 focus-visible:ring-ring flex h-24 flex-col gap-1.5 rounded-md border p-2 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none",
                !day.inMonth && "opacity-45",
                isToday && "border-primary"
              )}
            >
              <span className="flex items-center justify-between">
                <span
                  className={cn(
                    "text-sm font-medium tabular-nums",
                    isToday && "text-primary"
                  )}
                >
                  {f.number(day.date.getDate())}
                </span>
                <span
                  className="text-muted-foreground text-[0.7rem] tabular-nums"
                  data-testid={`calendar-month-total-${day.key}`}
                >
                  {day.totalSec > 0 ? format.durationShort(day.totalSec) : ""}
                </span>
              </span>

              <span className="bg-muted mt-auto flex h-1.5 w-full overflow-hidden rounded-full">
                <span
                  className="flex h-full overflow-hidden rounded-full"
                  style={{ width: `${barPct}%` }}
                >
                  {day.top.map((share) => (
                    <span
                      key={share.key}
                      className="h-full"
                      style={{
                        width:
                          topSec > 0
                            ? `${(share.seconds / topSec) * 100}%`
                            : "0%",
                        background: share.color,
                      }}
                    />
                  ))}
                </span>
              </span>

              <span className="flex items-center gap-1 overflow-hidden">
                {day.top.map((share) => (
                  <span
                    key={share.key}
                    title={share.label}
                    className="size-2 shrink-0 rounded-full"
                    style={{ background: share.color }}
                  />
                ))}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
