import { transactional } from "./business-transaction.js";
/**
 * Writing the end of a time entry.
 *
 * Extracted from the entries router because it now has two callers that must
 * not diverge: the router's own `stop`, and the runaway guard, which closes an
 * entry with no client involved at all. Duplicating the rate snapshot would be
 * the kind of drift nobody notices until an invoice is wrong.
 */
import type {
  TimeEntry as TimeEntryWire,
  WorkspaceSettings,
} from "@starter/shared";
import { resolveHourlyRate } from "@starter/shared";
import { Project, type ProjectDocLike } from "../models/Project.js";
import { getAuthorBillingSettings } from "./member-rate.js";
import {
  TimeEntry,
  toClientTimeEntry,
  type RunawayDoc,
  type TimeEntryDocLike,
} from "../models/TimeEntry.js";

export type RateSnapshot = { hourlyRate: number | null; currency: string };

/** Absolute elapsed seconds. No calendar arithmetic is involved anywhere. */
export const durationBetween = (start: Date, end: Date): number =>
  Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000));

export const snapshotRate = (
  billable: boolean,
  project: ProjectDocLike | null,
  settings: WorkspaceSettings,
): RateSnapshot => ({
  hourlyRate: resolveHourlyRate({
    billable,
    projectRate: project?.hourlyRate ?? null,
    defaultRate: settings.defaultHourlyRate,
  }),
  currency: settings.currency,
});

/**
 * Write the stop of one running entry: end, duration and the rate snapshot.
 *
 * Takes the entry itself rather than a scope id, because the entry being
 * stopped is not necessarily in the workspace the request is addressed to —
 * see `stopRunningEntry`. Its rate snapshot must come from ITS workspace.
 *
 * The `end: null` in the filter is the whole concurrency story, and it is what
 * makes "whichever closes the entry first wins" true for free: the runaway
 * guard and an idle watcher racing on the same entry cannot both succeed,
 * because the loser's filter no longer matches.
 *
 * Returns `null` when the entry was already stopped by someone else.
 *
 * `runaway` is written in the same update as the stop, so a cap and the record
 * that explains it can never land apart.
 */
const finalizeStopImpl = async (
  running: TimeEntryDocLike,
  end: Date,
  runaway?: RunawayDoc,
): Promise<TimeEntryWire | null> => {
  const settings = await getAuthorBillingSettings(running.workspaceId, running.authorId, running);
  const project = running.projectId
    ? await Project.findOne({
        _id: running.projectId,
        workspaceId: running.workspaceId,
      }).lean()
    : null;
  const { hourlyRate, currency } = snapshotRate(
    running.billable,
    project,
    settings,
  );

  const stopped = await TimeEntry.findOneAndUpdate(
    { _id: String(running._id), authorId: running.authorId, end: null },
    {
      $set: {
        end,
        durationSec: durationBetween(running.start, end),
        hourlyRate,
        currency,
        ...(runaway ? { runaway } : {}),
      },
    },
    { returnDocument: "after" },
  ).lean();

  return stopped ? toClientTimeEntry(stopped) : null;
};

export const finalizeStop = transactional(finalizeStopImpl);
