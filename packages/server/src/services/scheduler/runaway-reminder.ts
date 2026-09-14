// The `runaway-reminder` job: the runaway guard, run proactively, plus the
// one reminder email per entry that only a proactive run can send.
//
// Enforcement goes through `enforceMaxEntryDuration`, exactly as the lazy
// path in services/entries/timer.ts and ws/handler.ts does. That function is
// per PERSON, so the job asks for the people with a timer running rather than
// for the entries. A cap or stop therefore has the same outcome and publishes
// the same sync event whichever caller got there first, and the second caller
// finds nothing left to do. See the header of services/runaway.ts.
//
// The email is the part the lazy path cannot do. Three rules:
//
//  - Enforcement never depends on email. Notifications off, no transport, no
//    address on file: the cap and the stop still happen.
//  - One email per entry. `reminderSentAt` is claimed with an atomic write
//    BEFORE sending, so two processes (or a job run racing a slow previous
//    one) cannot both send. A send that throws gives the claim back, so the
//    next run retries rather than the reminder being lost.
//  - Without a transport the reminder is logged instead, and still claimed:
//    a log line every five minutes for one forgotten timer helps nobody.
import mongoose from "mongoose";
import { env } from "../../config/env.js";
import { getOrCreateUserPreferences } from "../../models/Settings.js";
import { Profile } from "../../models/Profile.js";
import { TimeEntry } from "../../models/TimeEntry.js";
import {
  buildRunawayReminderEmail,
  isEmailDeliveryConfigured,
  sendEmail,
} from "../email.js";
import {
  enforceMaxEntryDuration,
  runawayReminderClaimFilter,
  runawayReminderDue,
} from "../runaway.js";
import { preferredLocale } from "../user-locale.js";
import { jobRegistry, type JobRegistry } from "./registry.js";

export const RUNAWAY_REMINDER_JOB = "runaway-reminder";

/** Five minutes: a cap lands at most this long after its limit passes. */
export const RUNAWAY_REMINDER_INTERVAL_MS = 5 * 60 * 1000;

export type RunawayReminderDeps = {
  enforce: typeof enforceMaxEntryDuration;
  sendEmail: typeof sendEmail;
  isEmailDeliveryConfigured: () => boolean;
  findUserEmail: (userId: string) => Promise<string | null>;
  notificationsEnabled: (userId: string) => Promise<boolean>;
  trackUrl: string | null;
  log: (message: string) => void;
};

export type RunawayReminderSummary = {
  /** People with a timer running when the run started. */
  people: number;
  /** Timers the guard capped or stopped in this run. */
  ended: number;
  /** Reminder emails handed to the transport. */
  emailed: number;
  /** Reminders logged because no transport is configured. */
  logged: number;
  /** Reminders owed but not sent because the person turned emails off. */
  suppressed: number;
  /** People whose run threw. */
  failed: number;
};

/**
 * The better-auth user's address. The mongodb adapter stores the user under
 * an ObjectId `_id` whose hex string is the id everywhere else in the app.
 */
async function findUserEmail(userId: string): Promise<string | null> {
  const db = mongoose.connection.db;
  if (!db) return null;
  const filter = mongoose.Types.ObjectId.isValid(userId)
    ? { _id: new mongoose.Types.ObjectId(userId) }
    : { id: userId };
  const user = await db
    .collection<{ email?: unknown }>("user")
    .findOne(filter as Record<string, unknown>, { projection: { email: 1 } });
  return typeof user?.email === "string" && user.email ? user.email : null;
}

/**
 * Profile.preferences.notifications, which defaults to on. No profile at all
 * means the person never changed it.
 */
async function notificationsEnabled(userId: string): Promise<boolean> {
  const profile = await Profile.findOne({ userId })
    .select({ "preferences.notifications": 1 })
    .lean<{ preferences?: { notifications?: boolean } } | null>();
  return profile?.preferences?.notifications !== false;
}

const trackUrlFromEnv = (): string | null =>
  env.FRONTEND_URL ? `${env.FRONTEND_URL.replace(/\/+$/, "")}/track` : null;

const defaultDeps = (): RunawayReminderDeps => ({
  enforce: enforceMaxEntryDuration,
  sendEmail,
  isEmailDeliveryConfigured,
  findUserEmail,
  notificationsEnabled,
  trackUrl: trackUrlFromEnv(),
  log: (message) => console.log(message),
});

/**
 * One run of the job. Exported so tests drive it with a clock and fakes for
 * everything that leaves the process.
 *
 * Throws after every person has been processed when any of them failed, so
 * the scheduler records `lastError` without one bad row starving the rest.
 */
export async function runRunawayReminders(
  now: Date,
  overrides: Partial<RunawayReminderDeps> = {},
): Promise<RunawayReminderSummary> {
  const deps = { ...defaultDeps(), ...overrides };
  const authorIds = (await TimeEntry.distinct("authorId", {
    end: null,
  })) as string[];

  const summary: RunawayReminderSummary = {
    people: authorIds.length,
    ended: 0,
    emailed: 0,
    logged: 0,
    suppressed: 0,
    failed: 0,
  };
  let firstError: unknown = null;

  for (const authorId of authorIds) {
    try {
      await remindOne(authorId, now, deps, summary);
    } catch (error) {
      summary.failed += 1;
      firstError ??= error;
    }
  }

  if (firstError !== null) {
    const reason =
      firstError instanceof Error ? firstError.message : String(firstError);
    throw new Error(
      `runaway-reminder failed for ${summary.failed} of ${summary.people} people: ${reason}`,
      { cause: firstError },
    );
  }
  return summary;
}

async function remindOne(
  authorId: string,
  now: Date,
  deps: RunawayReminderDeps,
  summary: RunawayReminderSummary,
): Promise<void> {
  // Person-scoped, never confined to a workspace: this is the person's own
  // guard, run on their behalf, and it publishes into the entry's workspace.
  const outcome = await deps.enforce(authorId, null, now);
  if (outcome.kind === "ended") {
    summary.ended += 1;
    return;
  }

  const running = await TimeEntry.findOne({ authorId, end: null }).lean();
  if (!running) return;

  const preferences = await getOrCreateUserPreferences(authorId);
  const due = runawayReminderDue(running, preferences.maxDuration, now.getTime());
  if (due.kind === "none") return;

  if (!(await deps.notificationsEnabled(authorId))) {
    summary.suppressed += 1;
    return;
  }

  const to = await deps.findUserEmail(authorId);
  if (!to) return;

  const entryId = String(running._id);
  const claimed = await TimeEntry.findOneAndUpdate(
    runawayReminderClaimFilter(entryId, due, now),
    { $set: { reminderSentAt: now } },
    { returnDocument: "after" },
  ).lean();
  if (!claimed) return;

  if (!deps.isEmailDeliveryConfigured()) {
    deps.log(
      `[runaway-reminder] Email delivery is not configured; not emailing user ${authorId} about running entry ${entryId}.`,
    );
    summary.logged += 1;
    return;
  }

  try {
    await deps.sendEmail(
      buildRunawayReminderEmail({
        to,
        description: claimed.description,
        start: claimed.start,
        now,
        limitSec: due.kind === "limit" ? due.limitSec : null,
        trackUrl: deps.trackUrl,
        locale: await preferredLocale([authorId]),
      }),
    );
    summary.emailed += 1;
  } catch (error) {
    // Give the claim back, but only our own: a later run that already
    // re-claimed it holds a different instant.
    await TimeEntry.updateOne(
      { _id: entryId, reminderSentAt: now },
      { $unset: { reminderSentAt: "" } },
    );
    throw error;
  }
}

/** Register the job on a registry, the process-wide one by default. */
export function registerRunawayReminderJob(
  registry: JobRegistry = jobRegistry,
): void {
  registry.register(RUNAWAY_REMINDER_JOB, RUNAWAY_REMINDER_INTERVAL_MS, async ({ now }) => {
    await runRunawayReminders(now);
  });
}
