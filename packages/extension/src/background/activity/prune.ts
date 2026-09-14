/**
 * Forgetting captured activity once it is older than the retention window.
 *
 * Retention is counted back from now in whole days of real time — 24h each,
 * not calendar days — because a prune that ran on a zone's clock would keep a
 * different amount of activity for somebody who travels. Rules are never
 * pruned: they are decisions, not activity.
 */
import { loadActivitySettings } from "./settings";
import { deleteEndedBefore } from "./store";

const DAY_MS = 86_400_000;

/** Delete what ended before the retention window. Returns how many rows went. */
export async function runPrune(now: number): Promise<number> {
  const { retentionDays } = await loadActivitySettings();
  return deleteEndedBefore(now - retentionDays * DAY_MS);
}
