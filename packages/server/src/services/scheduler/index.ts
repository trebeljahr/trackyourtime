// The scheduler's public surface. Later jobs register through
// `registerRecurringJob`; index.ts registers the built-in ones and starts the
// loop.
import mongoose from "mongoose";
import { env } from "../../config/env.js";
import { registerUpdateCheckJob, UPDATE_CHECK_JOB } from "../update-check.js";
import { jobRegistry } from "./registry.js";
import {
  registerRunawayReminderJob,
  RUNAWAY_REMINDER_JOB,
} from "./runaway-reminder.js";

export {
  registerRecurringJob,
  createJobRegistry,
  jobRegistry,
  type JobRegistry,
  type RecurringJob,
  type RecurringJobOptions,
  type ScheduledJobContext,
  type ScheduledJobHandler,
} from "./registry.js";
export {
  createScheduler,
  isSchedulerRunning,
  SCHEDULER_POLL_INTERVAL_MS,
  shouldStartScheduler,
  startScheduler,
  stopScheduler,
  type Scheduler,
} from "./scheduler.js";

/** Register every job this server ships with. Safe to call twice. */
export function registerBuiltInJobs(): void {
  const registered = new Set(jobRegistry.list().map((job) => job.name));
  if (!registered.has(RUNAWAY_REMINDER_JOB)) registerRunawayReminderJob();
  // Opt-in: without TRACKYOURTIME_UPDATE_CHECK no job exists to call GitHub.
  if (env.TRACKYOURTIME_UPDATE_CHECK && !registered.has(UPDATE_CHECK_JOB)) {
    registerUpdateCheckJob({ db: () => mongoose.connection.db, release: env.RELEASE });
  }
}
