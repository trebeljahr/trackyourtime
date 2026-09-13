"use client";

import * as React from "react";
import {
  addDays,
  endOfMonth,
  endOfWeek,
  endOfYear,
  format,
  isSameDay,
  parseISO,
  startOfMonth,
  startOfWeek,
  startOfYear,
  subDays,
  subMonths,
  subWeeks,
  subYears,
} from "date-fns";
import { CalendarDays } from "lucide-react";
import type { WeekStart } from "@starter/shared";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/** Inclusive range of local calendar dates, both "YYYY-MM-DD". */
export type DateRange = {
  from: string;
  to: string;
};

export type DateRangePresetId =
  | "today"
  | "yesterday"
  | "thisWeek"
  | "lastWeek"
  | "thisMonth"
  | "lastMonth"
  | "thisYear"
  | "last5Years";

/**
 * "All time" is not a `DateRangePresetId`: its bounds come from the data (the
 * workspace's first and last tracked day), so it cannot be resolved from `now`
 * alone. Callers that know the span pass it to the picker as `allTime`.
 */
export type DateRangePickerPresetId = DateRangePresetId | "allTime";

const ALL_TIME_LABEL = "All time";

export const DATE_RANGE_PRESETS: {
  id: DateRangePresetId;
  label: string;
}[] = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "thisWeek", label: "This week" },
  { id: "lastWeek", label: "Last week" },
  { id: "thisMonth", label: "This month" },
  { id: "lastMonth", label: "Last month" },
  { id: "thisYear", label: "This year" },
  { id: "last5Years", label: "Last 5 years" },
];

/** Local "YYYY-MM-DD" — never `toISOString()`, which shifts across timezones. */
export const toDateKey = (date: Date): string => format(date, "yyyy-MM-dd");

const parseDateKey = (key: string): Date | null => {
  const parsed = parseISO(key.length > 10 ? key.slice(0, 10) : key);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

/** Resolve a preset against `now`, honouring the workspace week start. */
export const rangeForPreset = (
  preset: DateRangePresetId,
  weekStartsOn: WeekStart = 1,
  now: Date = new Date()
): DateRange => {
  const weekOptions = { weekStartsOn } as const;

  switch (preset) {
    case "today":
      return { from: toDateKey(now), to: toDateKey(now) };
    case "yesterday": {
      const day = subDays(now, 1);
      return { from: toDateKey(day), to: toDateKey(day) };
    }
    case "thisWeek":
      return {
        from: toDateKey(startOfWeek(now, weekOptions)),
        to: toDateKey(endOfWeek(now, weekOptions)),
      };
    case "lastWeek": {
      const day = subWeeks(now, 1);
      return {
        from: toDateKey(startOfWeek(day, weekOptions)),
        to: toDateKey(endOfWeek(day, weekOptions)),
      };
    }
    case "thisMonth":
      return {
        from: toDateKey(startOfMonth(now)),
        to: toDateKey(endOfMonth(now)),
      };
    case "lastMonth": {
      const day = subMonths(now, 1);
      return {
        from: toDateKey(startOfMonth(day)),
        to: toDateKey(endOfMonth(day)),
      };
    }
    case "thisYear":
      return {
        from: toDateKey(startOfYear(now)),
        to: toDateKey(endOfYear(now)),
      };
    case "last5Years":
      // Rolling, ending today: five years back from tomorrow, so the range
      // holds exactly five years of days rather than five years and one.
      return {
        from: toDateKey(subYears(addDays(now, 1), 5)),
        to: toDateKey(now),
      };
  }
};

/**
 * The preset a range corresponds to, or null when it is a custom range.
 *
 * The fixed presets win over `allTime`: a workspace whose whole history is
 * this week is better labelled "This week" than "All time".
 */
export const matchPreset = (
  range: DateRange,
  weekStartsOn: WeekStart = 1,
  now: Date = new Date(),
  allTime: DateRange | null = null
): DateRangePickerPresetId | null => {
  for (const { id } of DATE_RANGE_PRESETS) {
    const candidate = rangeForPreset(id, weekStartsOn, now);
    if (candidate.from === range.from && candidate.to === range.to) return id;
  }
  if (allTime && allTime.from === range.from && allTime.to === range.to) {
    return "allTime";
  }
  return null;
};

const presetLabel = (id: DateRangePickerPresetId): string =>
  id === "allTime"
    ? ALL_TIME_LABEL
    : (DATE_RANGE_PRESETS.find((preset) => preset.id === id)?.label ?? "");

/** "21 Aug 2026" or "1 – 7 Aug 2026" — a compact, unambiguous label. */
export const formatRangeLabel = (range: DateRange): string => {
  const from = parseDateKey(range.from);
  const to = parseDateKey(range.to);
  if (!from || !to) return "Select dates";
  if (isSameDay(from, to)) return format(from, "d MMM yyyy");
  if (from.getFullYear() === to.getFullYear()) {
    if (from.getMonth() === to.getMonth()) {
      return `${format(from, "d")} – ${format(to, "d MMM yyyy")}`;
    }
    return `${format(from, "d MMM")} – ${format(to, "d MMM yyyy")}`;
  }
  return `${format(from, "d MMM yyyy")} – ${format(to, "d MMM yyyy")}`;
};

export type DateRangePickerProps = {
  value: DateRange;
  onChange: (range: DateRange) => void;
  weekStartsOn?: WeekStart;
  /**
   * The span of everything tracked. When given, an "All time" preset is
   * offered; null (unknown yet, or nothing tracked) leaves it out.
   */
  allTime?: DateRange | null;
  className?: string;
  align?: "start" | "center" | "end";
  testId?: string;
};

/**
 * Preset-first range picker. Presets cover the ranges a time tracker asks for
 * daily; the custom fields exist for everything else.
 */
export function DateRangePicker({
  value,
  onChange,
  weekStartsOn = 1,
  allTime = null,
  className,
  align = "start",
  testId = "date-range-picker",
}: DateRangePickerProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false);

  // The two fields are edited as a draft and only committed once they describe
  // an ordered range. A native date input fires `change` on every keystroke, so
  // retyping the year of `to` walks through 0002, 0020, 0202 before 2025 — each
  // an intermediate that is earlier than `from`. Committing those collapsed the
  // range onto the half-typed year and took the other bound with it.
  const [draft, setDraft] = React.useState<DateRange>(value);

  React.useEffect(() => {
    // Primitive deps: a parent that rebuilds `value` each render must not wipe
    // an edit in progress.
    setDraft({ from: value.from, to: value.to });
  }, [value.from, value.to]);

  const active = React.useMemo(
    () => matchPreset(value, weekStartsOn, new Date(), allTime),
    [value, weekStartsOn, allTime]
  );

  const applyPreset = React.useCallback(
    (preset: DateRangePresetId): void => {
      onChange(rangeForPreset(preset, weekStartsOn));
      setOpen(false);
    },
    [onChange, weekStartsOn]
  );

  const applyAllTime = React.useCallback((): void => {
    if (!allTime) return;
    onChange({ from: allTime.from, to: allTime.to });
    setOpen(false);
  }, [allTime, onChange]);

  const setBound = React.useCallback(
    (bound: "from" | "to", next: string): void => {
      const candidate: DateRange = { ...draft, [bound]: next };
      setDraft(candidate);

      // Incomplete or out of order: keep it on screen so the other bound can be
      // fixed, but do not report it upwards.
      if (candidate.from === "" || candidate.to === "") return;
      if (candidate.from > candidate.to) return;
      if (candidate.from === value.from && candidate.to === value.to) return;

      onChange(candidate);
    },
    [draft, onChange, value.from, value.to]
  );

  const invalid = draft.from !== "" && draft.to !== "" && draft.from > draft.to;

  const handleOpenChange = React.useCallback(
    (next: boolean): void => {
      // Discard an unfinished edit rather than reopening onto it.
      if (!next) setDraft({ from: value.from, to: value.to });
      setOpen(next);
    },
    [value.from, value.to]
  );

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className={cn("justify-start gap-2 font-normal", className)}
          data-testid={testId}
        >
          <CalendarDays className="size-4 opacity-70" />
          <span className="truncate">
            {active ? presetLabel(active) : formatRangeLabel(value)}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align={align}
        className="w-80 p-2"
        data-testid={`${testId}-content`}
      >
        <div className="grid gap-1">
          {DATE_RANGE_PRESETS.map((preset) => (
            <Button
              key={preset.id}
              type="button"
              variant={active === preset.id ? "secondary" : "ghost"}
              size="sm"
              className="justify-start font-normal"
              onClick={() => applyPreset(preset.id)}
              data-testid={`${testId}-preset-${preset.id}`}
            >
              {preset.label}
            </Button>
          ))}
          {allTime ? (
            <Button
              type="button"
              variant={active === "allTime" ? "secondary" : "ghost"}
              size="sm"
              className="justify-start font-normal"
              onClick={applyAllTime}
              data-testid={`${testId}-preset-allTime`}
            >
              {ALL_TIME_LABEL}
            </Button>
          ) : null}
        </div>

        <Separator className="my-2" />

        <div className="grid grid-cols-2 gap-2">
          <div className="grid min-w-0 gap-1">
            <Label htmlFor={`${testId}-from`} className="text-xs">
              From
            </Label>
            <Input
              id={`${testId}-from`}
              type="date"
              value={draft.from}
              max={draft.to || undefined}
              onChange={(event) => setBound("from", event.target.value)}
              className="h-8 min-w-0 px-2"
              data-testid={`${testId}-from`}
            />
          </div>
          <div className="grid min-w-0 gap-1">
            <Label htmlFor={`${testId}-to`} className="text-xs">
              To
            </Label>
            <Input
              id={`${testId}-to`}
              type="date"
              value={draft.to}
              min={draft.from || undefined}
              onChange={(event) => setBound("to", event.target.value)}
              className="h-8 min-w-0 px-2"
              data-testid={`${testId}-to`}
            />
          </div>
        </div>

        {invalid ? (
          <p
            className="mt-2 text-xs text-destructive"
            data-testid={`${testId}-invalid`}
          >
            From is after To — the range is not applied yet.
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
