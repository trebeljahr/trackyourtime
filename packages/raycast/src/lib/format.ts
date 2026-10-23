import { Color, Icon } from "@raycast/api";
import {
  entryDurationSec,
  formatDuration,
  formatDurationShort,
  type DurationFormat,
  type TimeEntry,
} from "../vendor/index.js";

export { entryDurationSec, formatDuration, formatDurationShort };

/** Elapsed seconds of an entry right now. */
export const elapsedSec = (entry: TimeEntry): number => entryDurationSec(entry, Date.now());

/**
 * Menu bar title for a total that is not moving — today's tracked time while
 * nothing runs.
 *
 * "36m", never "0:36". An explicit unit avoids confusing minutes with
 * seconds. Minutes are all a total nobody is adding to needs.
 * Seconds only appear below a minute, where "0m" would read as nothing
 * tracked at all.
 */
export const formatMenuBarTotal = (seconds: number): string => formatDurationShort(Math.max(0, seconds));

/**
 * Minute precision survives Raycast unloading the command between scheduled
 * refreshes. Seconds in an unloaded item's title would look like a frozen clock.
 */
export const formatMenuBarClock = (seconds: number): string => {
  const total = Math.max(0, Math.floor(seconds / 60));
  if (total === 0) return "<1m";
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return hours === 0 ? `${minutes}m` : `${hours}h ${String(minutes).padStart(2, "0")}m`;
};

/** Respects the workspace's hms/decimal preference when one is loaded. */
export const formatEntryDuration = (entry: TimeEntry, format: DurationFormat = "hms"): string =>
  formatDuration(elapsedSec(entry), format);

/** "14:32" in the user's locale — entry list subtitles. */
export const formatClock = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
};

/** "Today" / "Yesterday" / "Mon, 3 Feb" — entry list section headings. */
export const formatDayHeading = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Unknown day";

  const startOfDay = (value: Date): number =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();

  const dayDelta = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86_400_000);
  if (dayDelta === 0) return "Today";
  if (dayDelta === 1) return "Yesterday";

  return date.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
};

/** ISO datetime at local midnight `daysAgo` days back — list window bounds. */
export const isoDaysAgo = (daysAgo: number): string => {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - daysAgo);
  return date.toISOString();
};

/** A project's dot, so a list row is scannable without reading the name. */
export const projectIcon = (color: string | null): { source: Icon; tintColor: Color.ColorLike } => ({
  source: Icon.CircleFilled,
  tintColor: color ?? Color.SecondaryText,
});
