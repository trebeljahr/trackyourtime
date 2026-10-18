export const HOUR_MS = 60 * 60 * 1000;
/** The window a quiet day still shows, in local hours. */
const DEFAULT_FIRST_HOUR = 8;
const DEFAULT_LAST_HOUR = 18;

export type TimelineWindow = { start: number; end: number; ticks: number[] };

/**
 * The part of the day worth drawing: whole hours around everything there is,
 * never less than 08:00–18:00, clipped to the day itself. `hourStart(n)` maps
 * a local hour of the shown day to an instant, so a DST day keeps its real
 * hours.
 */
export const timelineWindow = (input: {
  day: { start: number; end: number };
  spans: readonly { start: number; end: number }[];
  now: number | null;
  hourStart: (hour: number) => number;
}): TimelineWindow => {
  const { day } = input;
  let first = input.hourStart(DEFAULT_FIRST_HOUR);
  let last = input.hourStart(DEFAULT_LAST_HOUR);
  for (const span of input.spans) {
    first = Math.min(first, span.start);
    last = Math.max(last, span.end);
  }
  if (input.now !== null && input.now > day.start && input.now < day.end) last = Math.max(last, input.now);

  const ticks: number[] = [];
  for (let hour = 0; hour <= 24; hour += 1) {
    const at = input.hourStart(hour);
    if (at >= day.start && at <= day.end) ticks.push(at);
  }
  const start = Math.max(day.start, [...ticks].reverse().find((tick) => tick <= first) ?? day.start);
  const end = Math.min(day.end, ticks.find((tick) => tick >= last) ?? day.end);
  return { start, end, ticks: ticks.filter((tick) => tick >= start && tick <= end) };
};
