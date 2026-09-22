// The arithmetic behind the year heatmap's cells: which project a day is
// painted in, and how strongly. Pure, so it is tested without React.
import type { SummaryGroup, SummaryTimelinePoint } from "@starter/shared";

import { NO_PROJECT_COLOR } from "./entry-color";

/** Fill strength per intensity bucket, as a percentage of the hue. */
const FILL_PERCENT = [0, 28, 48, 68, 90] as const;

/**
 * Which bucket a day falls into, measured against the busiest day: 0 means
 * "nothing tracked", 4 is the busiest day itself.
 */
export const intensityOf = (seconds: number, busiestSec: number): number => {
  if (seconds <= 0 || busiestSec <= 0) return 0;
  const share = seconds / busiestSec;
  if (share <= 0.25) return 1;
  if (share <= 0.5) return 2;
  if (share <= 0.75) return 3;
  return 4;
};

export type DayShare = {
  key: string;
  label: string;
  color: string;
  seconds: number;
};

/**
 * A day's split across the report's groups, biggest first, resolved to the
 * group's label and color. `null` when the server sent no split — a server
 * from before `shares` existed — so the caller can fall back to one hue.
 */
export const daySharesOf = (
  point: SummaryTimelinePoint | undefined,
  groups: ReadonlyMap<string, SummaryGroup>,
  noProjectLabel: string
): DayShare[] | null => {
  if (!point?.shares) return null;
  return point.shares.map((share) => {
    const group = groups.get(share.key);
    return {
      key: share.key,
      label:
        share.key === "none" ? noProjectLabel : (group?.label ?? share.key),
      color: group?.color ?? NO_PROJECT_COLOR,
      seconds: share.seconds,
    };
  });
};

/**
 * The cell's background: the dominant group's hue at the day's intensity.
 * `color-mix` keeps it translucent, so the same value reads on the light and
 * the dark surface, and the day number stays in the foreground color on top.
 * `null` for a day with nothing tracked, which keeps the muted background.
 */
export const heatFill = (
  color: string,
  intensity: number
): string | null => {
  const percent = FILL_PERCENT[intensity] ?? 0;
  if (percent === 0) return null;
  return `color-mix(in srgb, ${color} ${percent}%, transparent)`;
};
