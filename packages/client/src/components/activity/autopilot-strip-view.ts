import type { DesktopAutopilotState, DesktopAutopilotWatch, TimeEntry } from "@starter/shared";

import { isAutopilotTimer } from "@/components/activity/autopilot-data";

/** Unfiled work is asked about only once it has lasted this long. */
export const ASK_AFTER_MS = 2 * 60_000;

export type AutopilotStripView =
  | { kind: "owned"; at: number; filingKey: string; app: string | null; logId: string }
  | { kind: "warming"; watch: DesktopAutopilotWatch; progress: number }
  | { kind: "ask"; watch: DesktopAutopilotWatch }
  | { kind: "held"; watch: DesktopAutopilotWatch };

/**
 * What the strip under the tracker shows, if anything. Pure:
 *
 * - the running entry is Autopilot's → who started it, and Undo;
 * - nothing running, Autopilot can name the work → how close it is to starting;
 * - nothing running, it cannot → after {@link ASK_AFTER_MS}, the question;
 * - on hold → that it is waiting for a break, so silence is not a mystery.
 *
 * A timer the person started gets nothing at all.
 */
export const autopilotStripView = (
  state: DesktopAutopilotState | undefined,
  running: Pick<TimeEntry, "start"> | null,
  startAfterMinutes: number,
): AutopilotStripView | null => {
  if (state === undefined || !state.active) return null;
  if (running !== null) {
    const owned = state.owned;
    if (owned === null || !isAutopilotTimer(state, running)) return null;
    return { kind: "owned", at: owned.start, filingKey: owned.filingKey, app: owned.app?.name ?? null, logId: owned.logId };
  }
  const watch = state.watch;
  if (watch === null) return null;
  if (watch.held) return watch.creditedMs >= ASK_AFTER_MS ? { kind: "held", watch } : null;
  if (watch.filing !== null) {
    return { kind: "warming", watch, progress: Math.min(1, watch.creditedMs / (startAfterMinutes * 60_000)) };
  }
  return watch.creditedMs >= ASK_AFTER_MS ? { kind: "ask", watch } : null;
};
