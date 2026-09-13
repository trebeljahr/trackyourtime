import {
  format,
  parseISO,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import type { SummaryTimelinePoint, WeekStart } from "@starter/shared";

export type TimelineGranularity = "day" | "week" | "month";

export type TimelineBucket = {
  /** "YYYY-MM-DD" of the first day of the bucket. */
  date: string;
  billableSec: number;
  nonBillableSec: number;
};

/**
 * A quarter still reads as days; up to two years as weeks; anything longer as
 * months. The server answers one point per day whatever the range, so "Last 5
 * years" is ~1,800 of them — sub-pixel bars nobody can hover.
 */
const MAX_DAY_BUCKETS = 92;
const MAX_WEEK_BUCKETS_IN_DAYS = 731;

export const granularityForDays = (days: number): TimelineGranularity => {
  if (days <= MAX_DAY_BUCKETS) return "day";
  if (days <= MAX_WEEK_BUCKETS_IN_DAYS) return "week";
  return "month";
};

const bucketKey = (
  day: string,
  granularity: TimelineGranularity,
  weekStartsOn: WeekStart,
): string => {
  if (granularity === "day") return day;
  const parsed = parseISO(day);
  if (Number.isNaN(parsed.getTime())) return day;
  const start =
    granularity === "week"
      ? startOfWeek(parsed, { weekStartsOn })
      : startOfMonth(parsed);
  return format(start, "yyyy-MM-dd");
};

/**
 * Roll the server's daily points up into buckets a chart can draw. Totals are
 * sums of the daily points, so the chart still re-sums to the report total.
 * A week bucket at either edge of the range can hold fewer than seven days.
 */
export const bucketTimeline = (
  timeline: SummaryTimelinePoint[],
  weekStartsOn: WeekStart,
): { granularity: TimelineGranularity; buckets: TimelineBucket[] } => {
  const granularity = granularityForDays(timeline.length);
  const buckets = new Map<string, TimelineBucket>();

  for (const point of timeline) {
    const key = bucketKey(point.date, granularity, weekStartsOn);
    const bucket = buckets.get(key) ?? {
      date: key,
      billableSec: 0,
      nonBillableSec: 0,
    };
    bucket.billableSec += point.billableSec;
    bucket.nonBillableSec += Math.max(0, point.seconds - point.billableSec);
    buckets.set(key, bucket);
  }

  return { granularity, buckets: [...buckets.values()] };
};

/** Axis tick ("Mon 21", "7 Sep", "Sep 2026") or tooltip heading (`long`). */
export const formatBucketLabel = (
  date: string,
  granularity: TimelineGranularity,
  long = false,
): string => {
  const parsed = parseISO(date);
  if (Number.isNaN(parsed.getTime())) return date;
  switch (granularity) {
    case "day":
      return format(parsed, long ? "EEEE, d MMM yyyy" : "EEE d");
    case "week":
      return long
        ? `Week of ${format(parsed, "d MMM yyyy")}`
        : format(parsed, "d MMM");
    case "month":
      return format(parsed, long ? "MMMM yyyy" : "MMM yyyy");
  }
};
