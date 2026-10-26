import { z } from "zod";
import { addDaysToKey, isValidTimeZone, wallClockInZone } from "./timezone.js";
const day = z.iso.date(), instant = z.iso.datetime({ offset: true });
const DAY = 86400000;
/** Native Date's local-midnight rules, in an explicit zone. Exact candidates
 * choose the earlier repeated midnight; a skipped midnight/day moves forward
 * by the gap. Offset samples cover both sides of DST and date-line changes. */
function legacyDayStart(key: string, zone: string): number {
  const [year, month, date] = key.split("-").map(Number);
  // The existing server's numeric Date constructor maps years 00–99 to
  // 1900–1999. Preserve that rule rather than changing historical inputs here.
  const naive = Date.UTC(year!, month! - 1, date!);
  const offsets = new Set<number>();
  for (const delta of [-2 * DAY, -DAY, -DAY / 4, 0, DAY / 4, DAY, 2 * DAY]) {
    const sample = naive + delta, wall = wallClockInZone(sample, zone);
    const clock = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
    offsets.add(clock - sample);
  }
  const exact: number[] = [], forward: { at: number; gap: number }[] = [];
  for (const offset of offsets) {
    const at = naive - offset, wall = wallClockInZone(at, zone);
    const actual = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second), gap = actual - naive;
    if (gap === 0) exact.push(at); else if (gap > 0) forward.push({ at, gap });
  }
  if (exact.length) return Math.min(...exact);
  forward.sort((a, b) => a.gap - b.gap || a.at - b.at);
  if (forward[0]) return forward[0].at;
  throw new Error("Report calendar bound could not be resolved");
}
export function reportRangeBoundInTimeZone(raw: string, upper: boolean, rangeTimeZone: string): number {
  if (typeof rangeTimeZone !== "string" || !rangeTimeZone || rangeTimeZone.length > 64 || !isValidTimeZone(rangeTimeZone)) throw new Error("A verified report-range timezone is required");
  if (typeof raw !== "string" || raw.length > 100) throw new Error("Invalid report range bound");
  if (day.safeParse(raw).success) return legacyDayStart(upper ? addDaysToKey(raw, 1) : raw, rangeTimeZone);
  const value = instant.parse(raw); return Date.parse(value);
}
/** Date-only upper bounds include that day; full timestamps are exclusive.
 * The explicit range zone represents the old server clock, independently of
 * the caller timezone used for report day/week/month buckets. */
export function reportRangeInTimeZone(input: { from: string; to: string }, rangeTimeZone: string) {
  if (typeof rangeTimeZone !== "string" || !rangeTimeZone || rangeTimeZone.length > 64 || !isValidTimeZone(rangeTimeZone)) throw new Error("A verified report-range timezone is required");
  const fromMs = reportRangeBoundInTimeZone(input.from, false, rangeTimeZone), toMs = reportRangeBoundInTimeZone(input.to, true, rangeTimeZone);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) throw new Error("Report end must be after its start");
  return { from: new Date(fromMs), to: new Date(toMs), fromMs, toMs };
}
