"use client";

import * as React from "react";
import {
  addDays,
  endOfMonth,
  endOfWeek,
  endOfYear,
  format,
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

import type { ClientLocale } from "@/i18n/config";
import { DATE_STYLES, intlLocale } from "@/i18n/format";
import { getActiveLocale, useLocale } from "@/i18n/locale-store";
import { getTranslator } from "@/i18n/translator";
import { useT } from "@/i18n/use-t";
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

/** The presets, in the order the picker lists them. */
export const DATE_RANGE_PRESETS: { id: DateRangePresetId }[] = [
  { id: "today" },
  { id: "yesterday" },
  { id: "thisWeek" },
  { id: "lastWeek" },
  { id: "thisMonth" },
  { id: "lastMonth" },
  { id: "thisYear" },
  { id: "last5Years" },
];

/**
 * A preset's name in `locale`. Read at call time, never stored in a constant:
 * a label computed at import would stay English after the switch.
 */
export const presetLabel = (
  id: DateRangePickerPresetId,
  locale: ClientLocale = getActiveLocale()
): string => {
  if (id === "allTime") return getTranslator(locale, "reports")("rangePicker.allTime");
  if (id === "last5Years") return getTranslator(locale, "reports")("rangePicker.last5Years");
  return getTranslator(locale, "common")(`time.${id}`);
};

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

/**
 * "21 Aug 2026" or "1–7 Aug 2026" / "1.–7. Aug. 2026" — a compact, unambiguous
 * label. `Intl.DateTimeFormat#formatRange` drops the parts both ends share, in
 * the order and punctuation the locale expects.
 */
export const formatRangeLabel = (
  range: DateRange,
  locale: ClientLocale = getActiveLocale()
): string => {
  const from = parseDateKey(range.from);
  const to = parseDateKey(range.to);
  if (!from || !to) return getTranslator(locale, "reports")("rangePicker.selectDates");
  const formatter = new Intl.DateTimeFormat(intlLocale(locale), DATE_STYLES.medium);
  const [start, end] = from.getTime() <= to.getTime() ? [from, to] : [to, from];
  try {
    return formatter.formatRange(start, end);
  } catch {
    return `${formatter.format(start)} – ${formatter.format(end)}`;
  }
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
  const locale = useLocale();
  const t = useT("reports");

  // The two fields are edited as a draft and only committed once they describe
  // an ordered range. A native date input fires `change` on every keystroke, so
  // retyping the year of `to` walks through 0002, 0020, 0202 before 2025 — each
  // an intermediate that is earlier than `from`. Committing those collapsed the
  // range onto the half-typed year and took the other bound with it.
  const [draft, setDraft] = React.useState<DateRange>(value);

  // Adjusted during render rather than in an effect — the same reseed pattern
  // as `useEntryFields`, and for the same reason: an effect would paint the
  // previous range for one frame before correcting itself. The two bounds are
  // tracked as primitives, so a parent that rebuilds `value` each render must
  // not wipe an edit in progress.
  const [seen, setSeen] = React.useState({ from: value.from, to: value.to });
  if (seen.from !== value.from || seen.to !== value.to) {
    setSeen({ from: value.from, to: value.to });
    setDraft({ from: value.from, to: value.to });
  }

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
            {active ? presetLabel(active, locale) : formatRangeLabel(value, locale)}
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
              {presetLabel(preset.id, locale)}
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
              {t("rangePicker.allTime")}
            </Button>
          ) : null}
        </div>

        <Separator className="my-2" />

        <div className="grid grid-cols-2 gap-2">
          <div className="grid min-w-0 gap-1">
            <Label htmlFor={`${testId}-from`} className="text-xs">
              {t("rangePicker.from")}
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
              {t("rangePicker.to")}
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
            {t("rangePicker.invalid")}
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
