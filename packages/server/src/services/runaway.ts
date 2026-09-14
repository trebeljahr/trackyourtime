/**
 * The runaway-timer guard, evaluated on the server.
 *
 * ── Evaluated twice: on read, and on a schedule ───────────────────────
 *
 * The guard is evaluated LAZILY, whenever something resolves "what is
 * running": `entries.current`, opening a timer by starting another one, and
 * joining the sync room on a fresh socket. The read that would have shown a
 * stale 63-hour timer is the read that fixes it.
 *
 * Lazy evaluation cannot act while nobody looks, so the `runaway-reminder`
 * job (services/scheduler/runaway-reminder.ts) calls the same function every
 * five minutes for everyone with a timer running. A cap then lands within
 * minutes of the limit with no client open, connected devices receive the
 * stop over sync, and the job can email a reminder the lazy path never could.
 *
 * Both callers go through `enforceMaxEntryDuration` and nothing else, so they
 * cannot disagree, and neither can double-act: a cap goes through
 * `finalizeStop`, whose filter requires `end: null`, and a flag's write
 * requires `runaway: null`. Whichever caller comes second finds nothing to do.
 * The lazy path stays as the fallback for an instance with
 * SCHEDULER_ENABLED=false, and between two polls.
 *
 * ── Why it cannot live in a client ───────────────────────────────────
 *
 * Idle detection runs on a device, watching that device's input. The failure
 * THIS guard catches is the one where the laptop was shut all weekend and no
 * client was running at all. A client-side guard is structurally unable to see
 * it.
 *
 * ── Author-scoped, like every other running-timer path ───────────────
 *
 * For a PERSON the running entry is found by `authorId` with no workspace
 * filter, for the same reason `entries.stop` does: one running timer per HUMAN
 * across every workspace they belong to. The maximum therefore comes from the
 * person's preferences (see MaxDurationSettings), while the rate snapshot on a
 * cap comes from the ENTRY's workspace — `finalizeStop` already gets that
 * right — and the event is published into that workspace, which may not be the
 * one whose read triggered the guard.
 *
 * A workspace-bound API token is NOT the person, so it hands in the workspace
 * it is confined to and the guard looks no further. This is a MUTATING path —
 * it caps or flags an entry and publishes into that entry's workspace — so
 * left author-scoped it would let a workspace-A token end a workspace-B
 * client's billable time through the back door, on an entry the same token is
 * answered 400 workspace-not-addressable for the moment it names it. The
 * parameter is required and has no default, because the value that would have
 * to be the default is the permissive one and the failure being prevented is
 * precisely a new call site inheriting it by silence. See `TimerReach` in
 * services/entries/timer.ts, which is where the callers get the value.
 *
 * ── How it and idle stay out of each other's way ─────────────────────
 *
 * Whichever sets `end` first wins, and neither has to know the other exists:
 *
 *  - The guard only ever considers an entry with `end === null`, and both of
 *    its acting behaviours go through `finalizeStop`, whose filter includes
 *    `end: null`. If idle already stopped or paused the entry, the guard finds
 *    nothing running (or finds the fresh entry a pause-and-resume opened,
 *    whose start is recent and therefore under the limit).
 *  - In the other direction, an idle watcher that wakes up after a cap calls
 *    `entries.stop`, which rejects an entry that is no longer running.
 *  - The `ask` behaviour writes a marker and nothing else. It never sets
 *    `end`, so it does not race at all: idle stays free to act, and it is the
 *    better-informed of the two, because it knows when input actually stopped.
 */
import {
  evaluateRunaway,
  type MaxDurationSettings,
  type SyncEvent,
  type TimeEntry as TimeEntryWire,
} from "@starter/shared";
import { getOrCreateUserPreferences } from "../models/Settings.js";
import {
  TimeEntry,
  toClientTimeEntry,
  type RunawayDoc,
} from "../models/TimeEntry.js";
import { publishSync } from "../ws/sync.js";
import { finalizeStop } from "./entry-stop.js";
import { emitWebhookEvent } from "./webhooks/emit.js";

export type GuardOutcome =
  | { kind: "none" }
  | { kind: "flagged"; entry: TimeEntryWire }
  | { kind: "ended"; entry: TimeEntryWire };

/**
 * Look at whatever this person has running and act on it if it has run away.
 *
 * `confineToWorkspaceId` is `null` for a person (look wherever their timer
 * runs) and a workspace id for a token bound to one, which then cannot reach
 * an entry outside it — see the header. A confined call whose timer runs
 * elsewhere is simply `{ kind: "none" }`: nothing capped, nothing flagged,
 * nothing published, and no hint that anything was there.
 *
 * Deliberately never takes an `originId`. A server-initiated cap has no
 * originating client, and passing the originId of whoever happened to trigger
 * the read would make exactly that one device — usually the device sitting in
 * front of the person — the only one that ignores the event. Publishing with
 * no originId means every connected device updates, which is the correct
 * meaning of "this did not come from any of you".
 *
 * Never throws: a read of the running entry must not fail because the guard
 * could not write. A guard that breaks `entries.current` is worse than a
 * runaway timer.
 */
export async function enforceMaxEntryDuration(
  userId: string,
  confineToWorkspaceId: string | null,
  now: Date = new Date(),
): Promise<GuardOutcome> {
  try {
    return await run(userId, confineToWorkspaceId, now);
  } catch {
    return { kind: "none" };
  }
}

const run = async (
  userId: string,
  confineToWorkspaceId: string | null,
  now: Date,
): Promise<GuardOutcome> => {
  const preferences = await getOrCreateUserPreferences(userId);
  const maxDuration: MaxDurationSettings = preferences.maxDuration;

  // Cheapest possible exit, and the common one: read no entry at all when the
  // guard is switched off.
  if (maxDuration.maxHours <= 0) return { kind: "none" };

  // No workspace filter for a person, on purpose — see the header. For a
  // confined caller the filter is the whole point: it is what makes this
  // mutation unable to reach another workspace's entry even if one is opened
  // between the caller's own check and this read.
  const running = await TimeEntry.findOne({
    authorId: userId,
    end: null,
    ...(confineToWorkspaceId === null
      ? {}
      : { workspaceId: confineToWorkspaceId }),
  }).lean();
  if (!running) return { kind: "none" };

  const decision = evaluateRunaway({
    startMs: running.start.getTime(),
    nowMs: now.getTime(),
    settings: maxDuration,
    existing: running.runaway
      ? {
          detectedAt: running.runaway.detectedAt.toISOString(),
          elapsedSec: running.runaway.elapsedSec,
          limitSec: running.runaway.limitSec,
          action: running.runaway.action,
          resolvedAt: running.runaway.resolvedAt
            ? running.runaway.resolvedAt.toISOString()
            : null,
        }
      : null,
  });

  if (decision.kind === "none") return { kind: "none" };

  const mark: RunawayDoc = {
    detectedAt: new Date(decision.mark.detectedAt),
    elapsedSec: decision.mark.elapsedSec,
    limitSec: decision.mark.limitSec,
    action: decision.mark.action,
    resolvedAt: null,
  };

  if (decision.kind === "flag") {
    // Still running, still occupying the one-running-timer slot. The only
    // thing that changed is that the entry now knows it is suspicious, and
    // `entry.upserted` is the event for "this entry changed but the timer did
    // not stop" — no new protocol kind is needed for any of this.
    const flagged = await TimeEntry.findOneAndUpdate(
      { _id: String(running._id), authorId: userId, end: null, runaway: null },
      { $set: { runaway: mark } },
      { returnDocument: "after" },
    ).lean();
    if (!flagged) return { kind: "none" };

    const entry = toClientTimeEntry(flagged);
    publish(running.workspaceId, { kind: "entry.upserted", entry });
    emitWebhookEvent(running.workspaceId, "entry.updated", {
      kind: "entry",
      entry,
    });
    return { kind: "flagged", entry };
  }

  const stopped = await finalizeStop(running, new Date(decision.endMs), mark);
  // Lost the race with an idle watcher, a Stop tap or a concurrent guard on
  // another request. The other write is just as valid an ending as ours.
  if (!stopped) return { kind: "none" };

  publish(running.workspaceId, { kind: "timer.stopped", entry: stopped });
  // Every other stop tells integrations; a cap made by the scheduler, with
  // nobody at a client, is the stop they are least likely to learn of
  // otherwise.
  emitWebhookEvent(running.workspaceId, "entry.stopped", {
    kind: "entry",
    entry: stopped,
  });
  return { kind: "ended", entry: stopped };
};

// ── the reminder email ───────────────────────────────────────────────

/**
 * With the guard off, a timer this old still earns one reminder. Eight hours
 * is a working day: past it, a timer is far more often forgotten than meant.
 */
export const UNGUARDED_REMINDER_AFTER_SEC = 8 * 3600;

export type RunawayReminderDue =
  | { kind: "none" }
  /** The guard flagged it (behaviour `ask`); `limitSec` is what it saw. */
  | { kind: "limit"; limitSec: number }
  /** The guard is off and the entry is past {@link UNGUARDED_REMINDER_AFTER_SEC}. */
  | { kind: "unguarded" };

/** The fields of an entry the reminder decision reads. */
export type RunawayReminderEntry = {
  start: Date;
  end: Date | null;
  runaway?: RunawayDoc | null;
  reminderSentAt?: Date | null;
};

/**
 * Whether this entry is owed its one reminder email. Pure: the job reads the
 * entry and the person's settings, and this decides.
 *
 * With the guard on, only an entry the guard FLAGGED and nobody has answered
 * yet is owed one. `cap` and `stop` end the entry, and an ended entry needs no
 * reminder to stop it. A flag answered with "keep running" (`resolvedAt` set)
 * was a decision, not an oversight. With the guard off, the fixed threshold
 * stands in for the missing limit.
 */
export function runawayReminderDue(
  entry: RunawayReminderEntry,
  settings: MaxDurationSettings,
  nowMs: number,
): RunawayReminderDue {
  if (entry.end !== null || entry.reminderSentAt) return { kind: "none" };

  if (settings.maxHours > 0) {
    const mark = entry.runaway;
    return mark && mark.action === "flagged" && !mark.resolvedAt
      ? { kind: "limit", limitSec: mark.limitSec }
      : { kind: "none" };
  }

  return nowMs - entry.start.getTime() >= UNGUARDED_REMINDER_AFTER_SEC * 1000
    ? { kind: "unguarded" }
    : { kind: "none" };
}

/**
 * The Mongo filter that claims an entry's reminder, as one atomic write.
 *
 * It repeats the decision's conditions, so the claim fails when the entry was
 * stopped, answered or already reminded about between the read and the write,
 * in this process or another. `reminderSentAt: null` also matches the absent
 * field every older entry has.
 */
export function runawayReminderClaimFilter(
  entryId: string,
  due: Exclude<RunawayReminderDue, { kind: "none" }>,
  now: Date,
): Record<string, unknown> {
  const base = { _id: entryId, end: null, reminderSentAt: null };
  return due.kind === "limit"
    ? { ...base, "runaway.action": "flagged", "runaway.resolvedAt": null }
    : {
        ...base,
        start: {
          $lte: new Date(now.getTime() - UNGUARDED_REMINDER_AFTER_SEC * 1000),
        },
      };
}

/** Into the entry's OWN workspace, which may not be the one that asked. */
const publish = (workspaceId: string, event: SyncEvent): void => {
  void publishSync(workspaceId, event);
};
