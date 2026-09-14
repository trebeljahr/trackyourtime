// The scheduler's public surface. Later jobs register through
// `registerRecurringJob`; index.ts registers the built-in ones and starts the
// loop.
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
}
