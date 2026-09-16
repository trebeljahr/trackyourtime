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
 * "36m", never "0:36". The running clock counts in `m:ss`, so a colon in the
 * menu bar means a timer is going, and a total that borrowed that shape read
 * as one: 36 minutes tracked today and a timer 36 seconds in are the same
 * four characters. Minutes are also all a total nobody is adding to needs.
 * Seconds only appear below a minute, where "0m" would read as nothing
 * tracked at all.
 */
export const formatMenuBarTotal = (seconds: number): string => formatDurationShort(Math.max(0, seconds));

/**
 * Menu bar clock for the running timer, ticking: `m:ss` under an hour and
 * `h:mm:ss` above it.
 *
 * The elapsed time is derived from the entry's start, not from the server, so
 * the second only needs the command's own process to still be alive — the
 * interval refetch is about *which* entry is running, never about the clock.
 * The hour is dropped below 60 minutes so the item stays about as wide as the
 * clock beside it in the menu bar.
 */
export const formatMenuBarClock = (seconds: number): string => {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = String(total % 60).padStart(2, "0");
  if (hours === 0) return `${minutes}:${secs}`;
  return `${hours}:${String(minutes).padStart(2, "0")}:${secs}`;
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
