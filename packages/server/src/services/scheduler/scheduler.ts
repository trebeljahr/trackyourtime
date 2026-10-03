// The background loop that runs registered jobs.
//
// A timer over one indexed collection rather than a job runner, for the same
// reason as the webhook sweeper (which keeps its own loop): the workload is a
// handful of jobs every few minutes, and a broker would be a second thing to
// operate. What a broker would buy, several processes never running the same
// job at once, the lease in lease.ts buys with one atomic update.
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import {
  claimScheduledJob,
  ensureScheduledJob,
  releaseScheduledJob,
  renewScheduledJob,
} from "./lease.js";
import { jobRegistry, type JobRegistry, type RecurringJob } from "./registry.js";

/** How often this process asks whether any job is due. */
export const SCHEDULER_POLL_INTERVAL_MS = 30_000;

export type SchedulerLogger = Pick<Console, "log" | "error">;

export type Scheduler = {
  /** The name this process writes into `lockedBy`. */
  owner: string;
  /**
   * One pass: claim every due job this process is not already running, and
   * run the ones it won. Resolves when those runs finish. Never rejects: a
   * handler's failure is recorded on its row, a database failure is logged,
   * and the next poll tries again either way.
   */
  tick: (now?: Date) => Promise<void>;
  /** Abort between units of work, then wait until handlers really finish. */
  stop: () => Promise<void>;
};

/**
 * A scheduler over a registry. Exported for tests, which drive `tick` with a
 * clock of their own instead of waiting on the interval.
 */
export function createScheduler(options: {
  registry?: JobRegistry;
  owner?: string;
  logger?: SchedulerLogger;
  /** Injectable storage for lifecycle tests without a database. */
  leases?: {
    ensure: typeof ensureScheduledJob;
    claim: typeof claimScheduledJob;
    renew: typeof renewScheduledJob;
    release: typeof releaseScheduledJob;
  };
} = {}): Scheduler {
  const registry = options.registry ?? jobRegistry;
  const owner = options.owner ?? `${hostname()}:${process.pid}:${randomUUID()}`;
  const logger = options.logger ?? console;
  const leases = options.leases ?? {
    ensure: ensureScheduledJob, claim: claimScheduledJob,
    renew: renewScheduledJob, release: releaseScheduledJob,
  };
  let stopped = false;
  const controllers = new Set<AbortController>();
  const passes = new Set<Promise<void>>();

  // Jobs this process has in flight. The interval keeps firing while a slow
  // run is going; without this the process would try to claim a job it is
  // already running, which the lease refuses anyway, at the cost of a query
  // per job per poll.
  const running = new Set<string>();

  const runOne = async (job: RecurringJob, now: Date): Promise<void> => {
    running.add(job.name);
    const controller = new AbortController();
    controllers.add(controller);
    // Each claim has a different owner, including successive runs by this process.
    const claimOwner = `${owner}:${randomUUID()}`;
    let renewal: NodeJS.Timeout | undefined;
    let expiry: NodeJS.Timeout | undefined;
    let renewing: Promise<void> | undefined;
    let finished = false;
    let leaseLost = false;
    const started = performance.now();
    const clock = (): Date => new Date(now.getTime() + performance.now() - started);
    const lost = (): void => {
      leaseLost = true;
      controller.abort(new Error("Scheduled job lease lost"));
    };
    const armExpiry = (until: number): void => {
      clearTimeout(expiry);
      expiry = setTimeout(lost, Math.max(1, until - clock().getTime()));
      expiry.unref();
    };
    const scheduleRenewal = (): void => {
      if (finished || leaseLost) return;
      renewal = setTimeout(() => {
        const renewedAt = clock();
        renewing = leases.renew({
          name: job.name, owner: claimOwner, leaseMs: job.leaseMs, now: renewedAt,
        }).then((owned) => {
          if (!owned) lost();
          else if (!finished && !leaseLost) {
            armExpiry(renewedAt.getTime() + job.leaseMs);
          }
        }).catch(lost).finally(() => {
          renewing = undefined;
          scheduleRenewal();
        });
      }, Math.max(1, Math.min(30_000, job.leaseMs / 3)));
      renewal.unref();
    };
    try {
      if (stopped) return;
      await leases.ensure(job.name, job.intervalMs, now);
      if (stopped) return;
      const claimed = await leases.claim({
        name: job.name, owner: claimOwner, intervalMs: job.intervalMs,
        leaseMs: job.leaseMs, now,
      });
      if (!claimed) return;
      if (clock().getTime() >= now.getTime() + job.leaseMs) lost();
      armExpiry(now.getTime() + job.leaseMs);
      scheduleRenewal();
      let error: string | null = null;
      try {
        controller.signal.throwIfAborted();
        await job.handler({ now, signal: controller.signal });
      } catch (caught) {
        if (!stopped) {
          error = caught instanceof Error ? caught.message : String(caught);
          logger.error(`[scheduler] Job "${job.name}" failed:`, caught);
        }
      } finally {
        finished = true;
        clearTimeout(renewal);
        clearTimeout(expiry);
        // Do not let a late renewal extend a released or subsequently re-claimed job.
        await renewing;
      }
      await leases.release({ name: job.name, owner: claimOwner, error });
    } catch (caught) {
      // Never release while work is still running. On storage failure the
      // existing claim remains fenced by owner and eventually expires.
      logger.error(`[scheduler] Could not run job "${job.name}":`, caught);
    } finally {
      finished = true;
      clearTimeout(renewal);
      clearTimeout(expiry);
      controllers.delete(controller);
      running.delete(job.name);
    }
  };

  return {
    owner,
    tick: (now = new Date()) => {
      if (stopped) return Promise.resolve();
      const due = registry.list().filter((job) => !running.has(job.name));
      const pass = Promise.all(due.map((job) => runOne(job, now))).then(() => {});
      passes.add(pass);
      void pass.finally(() => passes.delete(pass));
      return pass;
    },
    stop: async () => {
      stopped = true;
      for (const controller of controllers) controller.abort(new Error("Scheduler stopping"));
      await Promise.all(passes);
    },
  };
}

/** Whether `startScheduler` starts a loop in this environment. */
export function shouldStartScheduler(source: {
  enabled: boolean;
  isTest: boolean;
}): boolean {
  return source.enabled && !source.isTest;
}

let timer: NodeJS.Timeout | null = null;
let ticking: Promise<void> | null = null;
let activeScheduler: Scheduler | null = null;

/**
 * Start polling. Call after the database connects.
 *
 * Returns false without starting anything when SCHEDULER_ENABLED is off, and
 * under NODE_ENV=test, where a background timer keeps the event loop alive and
 * hangs the suite. `.unref()` otherwise, so a shutdown never waits on a poll.
 * Idempotent: a second call does not start a second loop.
 *
 * The first poll runs straight away rather than one interval after boot, so a
 * deploy does not push every due job back by 30 seconds.
 */
export function startScheduler(
  config: { enabled: boolean; isTest: boolean },
  scheduler: Scheduler = createScheduler(),
): boolean {
  if (!shouldStartScheduler(config)) return false;
  if (timer) return true;

  activeScheduler = scheduler;
  const poll = (): void => {
    if (ticking) return;
    ticking = scheduler.tick().finally(() => {
      ticking = null;
    });
  };
  timer = setInterval(poll, SCHEDULER_POLL_INTERVAL_MS);
  timer.unref();
  poll();
  return true;
}

/** Stop polling. Resolves once a pass already in flight has finished. */
export async function stopScheduler(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  const active = activeScheduler;
  activeScheduler = null;
  await active?.stop();
  if (ticking) await ticking;
}

/** Whether a loop is running in this process. */
export function isSchedulerRunning(): boolean {
  return timer !== null;
}
