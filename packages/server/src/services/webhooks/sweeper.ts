// The background loop that drains the delivery queue.
//
// Deliberately a timer over an indexed query rather than a job runner: the
// queue is one collection with a `{ status, nextAttemptAt }` index, and adding
// a broker to this would be a second thing to operate for a workload measured
// in events per minute.
import { env } from "../../config/env.js";
import { runWebhookSweep } from "./delivery.js";

/** How often the queue is checked. Cheap: it is one indexed query. */
export const WEBHOOK_SWEEP_INTERVAL_MS = 10_000;

let timer: NodeJS.Timeout | null = null;

/**
 * The pass currently in flight, also awaited during graceful shutdown.
 *
 * The interval keeps firing while a sweep is waiting on a slow endpoint, and
 * without this guard those passes stack up: each one claims its own batch and
 * the process ends up holding far more concurrent requests than
 * `WEBHOOK_SWEEP_BATCH` implies.
 */
let sweeping: Promise<void> | null = null;

/**
 * Start the delivery loop.
 *
 * Returns immediately under NODE_ENV=test: a background timer in a test
 * process keeps the event loop alive and turns a passing suite into one that
 * hangs. `.unref()` for the same reason in every other environment — a
 * shutdown must not wait on the next tick of this.
 *
 * Idempotent, so a double call cannot start two loops racing for the same
 * pending rows.
 */
export function startWebhookSweeper({
  isTest = env.isTest,
  runSweep = runWebhookSweep,
}: { isTest?: boolean; runSweep?: () => Promise<unknown> } = {}): void {
  if (isTest || timer) return;
  timer = setInterval(() => {
    void sweepOnce(runSweep);
  }, WEBHOOK_SWEEP_INTERVAL_MS);
  timer.unref();
}

/**
 * One guarded pass.
 *
 * Swallows its own errors: a database blip must reschedule the next tick, not
 * kill the interval and silently stop every webhook in the deployment until
 * somebody restarts the process.
 */
function sweepOnce(runSweep: () => Promise<unknown>): Promise<void> {
  if (sweeping) return sweeping;
  sweeping = Promise.resolve().then(runSweep).then(() => undefined).catch(() => {
    // Next tick tries again. See the doc comment.
  }).finally(() => { sweeping = null; });
  return sweeping;
}

/** Stop polling and wait for the already claimed pass before closing the DB. */
export async function stopWebhookSweeper(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (sweeping) await sweeping;
}
