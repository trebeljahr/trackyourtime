/**
 * The one snapshot every "what is running right now" surface renders.
 *
 * The menu bar and the Timer command show the same four things — the running
 * entry, the pins, what is worth resuming, and today's total — so they load
 * them the same way. Keeping it here means the two can never drift into
 * disagreeing about which entries count as recent or where the day starts.
 */
import {
  entryDurationSec,
  quickStartKey,
  reconcileRunning,
  toQuickStart,
  type DetailedEntry,
  type DetailedFavorite,
} from "@starter/core";
import type { ProjectWithStats, TrackYourTime } from "./api.js";
import { isoDaysAgo } from "./format.js";
import { pendingCounts } from "./offline.js";
import { loadTimerEcho } from "./storage.js";

/** How far back the "continue" shortlist looks. */
export const RECENT_DAYS = 7;

export type TimerSnapshot = {
  running: DetailedEntry | null;
  recent: DetailedEntry[];
  favorites: DetailedFavorite[];
  projects: ProjectWithStats[];
  todaySec: number;
  /** When this was read, so a later local transition can override it. */
  fetchedAt: number;
  /** The echo knows a timer this snapshot does not — load again shortly. */
  refetch: boolean;
  /**
   * Mutations this account made that no server has seen yet.
   *
   * Surfaced rather than kept quiet: what is queued is time the user tracked,
   * and a client that holds it silently is indistinguishable from one that
   * lost it.
   */
  pending: number;
  /**
   * Rows queued by a different account on this Mac. Never replayed under this
   * session and never deleted — somebody tracked that time.
   */
  foreign: number;
};

const startOfToday = (): number => {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

/**
 * Distinct recent work, newest first — what the user would plausibly resume.
 * Two entries that share a description, project and task are the same job
 * done twice, so only the newest of them earns a slot.
 */
const shortlist = (
  entries: DetailedEntry[],
  limit: number,
): DetailedEntry[] => {
  const seen = new Set<string>();
  const out: DetailedEntry[] = [];

  for (const entry of entries) {
    if (entry.end === null) continue;
    const key = `${entry.description}|${entry.projectId ?? ""}|${entry.taskId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
    if (out.length === limit) break;
  }

  return out;
};

/**
 * One round trip for the entries: the running entry is in this window too,
 * and it arrives with its project and client names already joined. The pins
 * and the projects are separate, small reads — the pins because they are the
 * section people actually aim for and must not depend on the entry window
 * happening to contain them, the projects because filing a running timer
 * needs the whole catalog, not just the projects it was recently used with.
 */
export const loadTimerSnapshot = async (
  api: TrackYourTime,
  { recentLimit }: { recentLimit: number },
): Promise<TimerSnapshot> => {
  const now = Date.now();

  // Drain before reading, not after: a queued start that replays here is in
  // the window this read is about to ask for, so the snapshot comes back
  // already carrying it instead of showing the local copy for one more cycle.
  // Failures are the queue's own business — it keeps the rows and the reads
  // below fall back to what this Mac already knows.
  await api.sync().catch(() => undefined);

  const [{ entries }, favorites, projects] = await Promise.all([
    api.list({
      from: isoDaysAgo(RECENT_DAYS),
      to: new Date(now + 60_000).toISOString(),
      limit: 100,
    }),
    api.favorites(),
    api.projects(),
  ]);

  const dayStart = startOfToday();
  const todaySec = entries.reduce((total, entry) => {
    const startMs = Date.parse(entry.start);
    if (!Number.isFinite(startMs) || startMs < dayStart) return total;
    return total + entryDurationSec(entry, now);
  }, 0);

  // A read that started before a stop can still land after it, and would then
  // put the stopped timer back on screen. The echo settles that by time: a
  // transition recorded after `now` outranks anything in this response.
  const { running, refetch } = reconcileRunning(
    {
      running: entries.find((entry) => entry.end === null) ?? null,
      fetchedAt: now,
    },
    await loadTimerEcho(),
  );

  const { mine, foreign } = await pendingCounts();

  return {
    running,
    recent: shortlist(entries, recentLimit),
    favorites,
    projects,
    todaySec,
    fetchedAt: now,
    refetch,
    pending: mine,
    foreign,
  };
};

/** Never a blank row and never a raw id — the same fallback order as core. */
export const entryLabel = (entry: DetailedEntry): string =>
  entry.description.trim() || entry.projectName || "No description";

/** "Client · Project › Task", or nothing when the entry is unfiled. */
export const entryHint = (entry: DetailedEntry): string | undefined => {
  const filed = [entry.projectName, entry.taskName].filter(Boolean).join(" › ");
  if (!filed) return undefined;
  return entry.clientName ? `${entry.clientName} · ${filed}` : filed;
};

/**
 * The pin matching an entry, if it is already pinned.
 *
 * Compared by `quickStartKey` rather than by id: a pin is a description /
 * project / task / billable combination, so continuing a pinned entry produces
 * a new entry that is still the same pin.
 */
export const favoriteFor = (
  entry: DetailedEntry,
  favorites: readonly DetailedFavorite[],
): DetailedFavorite | undefined => {
  const key = quickStartKey(toQuickStart(entry));
  return favorites.find((favorite) => quickStartKey(favorite) === key);
};
