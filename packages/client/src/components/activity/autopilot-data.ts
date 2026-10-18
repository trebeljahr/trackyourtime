import type {
  DesktopActivityInterval,
  DesktopActivityProposal,
  DesktopAutopilotHistoryEntry,
  DesktopAutopilotRunning,
  DesktopAutopilotState,
  DetailedEntry,
  TimeEntry,
} from "@starter/shared";

import type { AcceptFields } from "@/components/activity/accept-suggestion";
import { queuedIntervals } from "@/components/activity/tracked-intervals";
import { isOwnEntry } from "@/components/tracker/own-entries";
import type { OfflineMutation } from "@/lib/offline";

/**
 * What the Autopilot driver hands the main process, built from what the
 * renderer already holds. Pure, so the rules below are unit tests.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** How far back a plan reads tracked time: the decision's own window, and then some. */
export const AUTOPILOT_TRACKED_LOOKBACK_MS = 5 * HOUR_MS;
/** How far back the entries Autopilot learns from reach. Capped by the activity retention. */
export const AUTOPILOT_HISTORY_MAX_DAYS = 14;

/**
 * The window a plan's `entries.list` read covers, aligned to the hour so the
 * query key — and React Query's cache — holds for an hour rather than
 * changing on every tick.
 */
export const autopilotTrackedRange = (now: number): DesktopActivityInterval => {
  const hour = Math.floor(now / HOUR_MS) * HOUR_MS;
  return { start: hour - AUTOPILOT_TRACKED_LOOKBACK_MS, end: hour + 2 * HOUR_MS };
};

/** The learning window, aligned to UTC days for the same reason. */
export const autopilotHistoryRange = (now: number, retentionDays: number): DesktopActivityInterval => {
  const days = Math.max(1, Math.min(AUTOPILOT_HISTORY_MAX_DAYS, retentionDays));
  const day = Math.floor(now / DAY_MS) * DAY_MS;
  return { start: day - days * DAY_MS, end: day + 2 * DAY_MS };
};

const interval = (start: string, end: string | null, now: number): DesktopActivityInterval | null => {
  const from = Date.parse(start);
  const to = end === null ? now : Date.parse(end);
  return Number.isFinite(from) && Number.isFinite(to) && to > from ? { start: from, end: to } : null;
};

type EntryLike = Pick<DetailedEntry, "id" | "authorId" | "start" | "end">;

/**
 * Everything tracked in `range` EXCEPT the running entry, which the plan
 * describes on its own — Autopilot reads the activity inside its own timer
 * to decide whether to switch or stop it, so that time must not be a hole.
 *
 * The running entry is left out three ways: by id from the list, as any
 * other row with no end (a second open row is the running one seen before a
 * refetch), and as the queued start that opened it offline.
 */
export const trackedWithoutRunning = (input: {
  entries: readonly EntryLike[];
  viewerId: string | null;
  running: Pick<TimeEntry, "id"> | null;
  queued: readonly OfflineMutation[];
  range: DesktopActivityInterval;
  now: number;
}): DesktopActivityInterval[] => {
  const runningId = input.running?.id ?? null;
  const out: DesktopActivityInterval[] = [];
  for (const entry of input.entries) {
    if (entry.end === null || entry.id === runningId) continue;
    if (!isOwnEntry(entry, input.viewerId)) continue;
    const span = interval(entry.start, entry.end, input.now);
    if (span !== null) out.push(span);
  }
  const queued = input.queued.filter(
    (mutation) => runningId === null || mutation.tempId === undefined || mutation.tempId !== runningId,
  );
  out.push(...queuedIntervals(queued, input.now));
  return out.filter((span) => span.end > input.range.start && span.start < input.range.end);
};

/** The running entry as Autopilot reads it. */
export const describeRunning = (running: TimeEntry | null): DesktopAutopilotRunning | null => {
  if (running === null) return null;
  const start = Date.parse(running.start);
  if (!Number.isFinite(start)) return null;
  return { start, description: running.description, projectId: running.projectId, taskId: running.taskId };
};

/** This person's entries in `range`, in the shape Autopilot learns from. */
export const historyFrom = (input: {
  entries: readonly DetailedEntry[];
  viewerId: string | null;
  now: number;
}): DesktopAutopilotHistoryEntry[] => {
  const out: DesktopAutopilotHistoryEntry[] = [];
  for (const entry of input.entries) {
    if (!isOwnEntry(entry, input.viewerId)) continue;
    const span = interval(entry.start, entry.end, input.now);
    if (span === null) continue;
    out.push({
      ...span,
      description: entry.description,
      projectId: entry.projectId,
      taskId: entry.taskId,
      tagIds: [...(entry.tagIds ?? [])],
      billable: entry.billable,
    });
  }
  return out;
};

/** What a filing writes, before the catalog check (`withKnownCatalog`). */
export const fieldsOfProposal = (proposal: DesktopActivityProposal): AcceptFields => ({
  description: proposal.description ?? "",
  projectId: proposal.projectId ?? null,
  taskId: proposal.taskId ?? null,
  tagIds: proposal.tagIds ?? [],
  ...(proposal.billable !== undefined ? { billable: proposal.billable } : {}),
});

/** Two starts this close are one start; the server may round. */
const SAME_START_MS = 1_000;

/** Whether the running entry is the one Autopilot opened. */
export const isAutopilotTimer = (
  state: Pick<DesktopAutopilotState, "owned"> | null | undefined,
  running: Pick<TimeEntry, "start"> | null,
): boolean => {
  const owned = state?.owned ?? null;
  if (owned === null || running === null) return false;
  const start = Date.parse(running.start);
  return Number.isFinite(start) && Math.abs(start - owned.start) < SAME_START_MS;
};
