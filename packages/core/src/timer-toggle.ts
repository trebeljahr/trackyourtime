/**
 * The one-key timer toggle, shared by Raycast's `toggle-timer` hotkey and the
 * desktop app's global shortcut, so the two resume the same entry.
 *
 * Stop what is running. Otherwise continue the newest finished entry inside
 * the recent window. Otherwise there is nothing to resume, and the caller
 * opens its composer — starting a nameless timer the person then has to fix
 * is worse than asking what to start.
 */

/** How far back "recent" looks for the toggle, in days, from local midnight. */
export const RECENT_TIMER_DAYS = 7;

export type TimerToggleDecision<T> =
  | { kind: "stop" }
  | { kind: "continue"; candidate: T }
  | { kind: "compose" };

/** Local midnight `days` days before `nowMs`, in epoch ms — the window's start. */
export function recentWindowStartMs(nowMs: number, days: number = RECENT_TIMER_DAYS): number {
  const date = new Date(nowMs);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - days);
  return date.getTime();
}

export function decideTimerToggle<T>(input: {
  running: boolean;
  /**
   * Entries (or recent combinations) belonging to the person pressing the
   * key. Filtering out colleagues' rows is the caller's job: in a shared
   * workspace the newest entry can be somebody else's.
   */
  candidates: readonly T[];
  /** ISO start of a candidate. */
  startOf: (candidate: T) => string;
  /** False for a running entry, which is never "continued". Defaults to true. */
  isFinished?: (candidate: T) => boolean;
  nowMs: number;
  days?: number;
}): TimerToggleDecision<T> {
  if (input.running) return { kind: "stop" };
  const since = recentWindowStartMs(input.nowMs, input.days);
  let newest: { candidate: T; startMs: number } | null = null;
  for (const candidate of input.candidates) {
    if (input.isFinished && !input.isFinished(candidate)) continue;
    const startMs = Date.parse(input.startOf(candidate));
    if (!Number.isFinite(startMs) || startMs < since) continue;
    // Strictly newer, so equal starts keep the caller's order.
    if (newest === null || startMs > newest.startMs) newest = { candidate, startMs };
  }
  return newest === null ? { kind: "compose" } : { kind: "continue", candidate: newest.candidate };
}
