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

/**
 * A badge is roughly four characters wide, so the unit steps down as the
 * number grows: "7m", "59m", "1h". Precision below the minute would only
 * flicker — the alarm cannot fire more often than every 30 seconds anyway.
 * The unit letters come from the `background` catalog, so a translation can
 * pick its own shortest recognisable unit.
 */
export const badgeTextFor = (
  entry: TimeEntry | null,
  t: ExtensionTranslator<"background">,
  nowMs: number = Date.now(),
): string => {
  if (entry === null) return "";

  const minutes = Math.floor(
    entryDurationSec(entry, nowMs) / SECONDS_PER_MINUTE,
  );
  if (minutes < MINUTES_PER_HOUR) return t("badge.minutes", { minutes });
  return t("badge.hours", { hours: Math.floor(minutes / MINUTES_PER_HOUR) });
};

/**
 * Paint the badge for `entry`, or clear it when nothing is running.
 *
 * Failures are swallowed: `chrome.action` can be gone mid-teardown, and a
 * badge that could not be drawn must never take down the mutation that asked
 * for it.
 */
export async function renderBadge(entry: TimeEntry | null): Promise<void> {
  const action = (globalThis as { chrome?: typeof chrome }).chrome?.action;
  if (!action) return;

  try {
    await action.setBadgeText({ text: badgeTextFor(entry, await backgroundT()) });
    await action.setBadgeBackgroundColor({ color: BADGE_BACKGROUND });
    await action.setBadgeTextColor({ color: BADGE_TEXT_COLOR });
  } catch {
    /* the worker is going away — the next alarm repaints it */
  }
}
