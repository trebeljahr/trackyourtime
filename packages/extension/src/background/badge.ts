/**
 * The toolbar badge — the only part of this extension that is visible without
 * opening the popup, and therefore the one piece of UI that has to keep
 * working while the worker is being evicted and revived underneath it.
 *
 * Elapsed time is recomputed from `entry.start` on every render rather than
 * incremented. An incrementing counter is wrong the moment anything pauses it:
 * a worker eviction, a sleeping laptop, an alarm that fires late. Deriving from
 * the wall clock is right in all three cases and costs nothing.
 */
import { entryDurationSec, type TimeEntry } from "@starter/core";
import type { ExtensionTranslator } from "../i18n";
import { backgroundT } from "./locale";

const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;

/**
 * Indigo with white text. Chrome's default badge colour is red, which reads as
 * an error, and picks up the toolbar's own contrast in only one of the two
 * themes — so both colours are set explicitly rather than half-inherited.
 */
const BADGE_BACKGROUND = "#4f46e5";
const BADGE_TEXT_COLOR = "#ffffff";

/** Keep one unambiguous hours:minutes scale, including the first hour. */
export const badgeTextFor = (
  entry: TimeEntry | null,
  t: ExtensionTranslator<"background">,
  nowMs: number = Date.now(),
): string => {
  if (entry === null) return "";
  const minutes = Math.floor(entryDurationSec(entry, nowMs) / SECONDS_PER_MINUTE);
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  // Very long timers cannot fit a clock in the toolbar. Hover retains precision.
  if (hours >= 100) return t("badge.hours", { hours });
  return `${hours}:${String(minutes % MINUTES_PER_HOUR).padStart(2, "0")}`;
};

let running: TimeEntry | null = null;
let ticker: ReturnType<typeof setInterval> | undefined;
let revision = 0;

/**
 * Paint the badge for `entry`, or clear it when nothing is running.
 *
 * Failures are swallowed: `chrome.action` can be gone mid-teardown, and a
 * badge that could not be drawn must never take down the mutation that asked
 * for it.
 */
export async function renderBadge(entry: TimeEntry | null): Promise<void> {
  running = entry;
  const currentRevision = ++revision;
  if (entry && ticker === undefined) {
    // Local paint only: no network polling or accumulated seconds. The alarm
    // restores this ticker after worker eviction; stopping releases it.
    ticker = setInterval(() => { void renderBadge(running); }, 1000);
  } else if (!entry && ticker !== undefined) {
    clearInterval(ticker);
    ticker = undefined;
  }
  const action = (globalThis as { chrome?: typeof chrome }).chrome?.action;
  if (!action) return;

  try {
    const t = await backgroundT();
    if (currentRevision !== revision) return;
    const now = Date.now();
    const seconds = entry ? Math.floor(entryDurationSec(entry, now)) : 0;
    const clock = `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
    await Promise.all([
      action.setBadgeText({ text: badgeTextFor(entry, t, now) }),
      action.setTitle({ title: entry ? t("badge.elapsed", { time: clock }) : "Track Your Time" }),
      action.setBadgeBackgroundColor({ color: BADGE_BACKGROUND }),
      action.setBadgeTextColor({ color: BADGE_TEXT_COLOR }),
    ]);
  } catch {
    /* the worker is going away — the next alarm repaints it */
  }
}
