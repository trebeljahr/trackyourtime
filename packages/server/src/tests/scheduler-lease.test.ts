// The scheduler's lease against a real MongoDB: several scheduler instances
// (standing in for several server processes) sharing one database must run
// each job exactly once per interval.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import mongoose from "mongoose";
import { parseBooleanDefaultOn } from "../config/env.js";
import { ScheduledJob } from "../models/ScheduledJob.js";
import {
  claimScheduledJob,
  ensureScheduledJob,
  releaseScheduledJob,
  renewScheduledJob,
} from "../services/scheduler/lease.js";
import {
  createJobRegistry,
  type ScheduledJobHandler,
} from "../services/scheduler/registry.js";
import {
  createScheduler,
  isSchedulerRunning,
  shouldStartScheduler,
  startScheduler,
  type Scheduler,
} from "../services/scheduler/scheduler.js";
import {
  clearTestDatabase,
  connectTestDatabase,
  dropTestDatabase,
  skipWithoutDatabase,
} from "./support/test-database.js";

const MINUTE = 60_000;
const T0 = new Date("2026-09-12T08:00:00.000Z");
const at = (ms: number): Date => new Date(T0.getTime() + ms);

const silent = { log: () => {}, error: () => {} };

/**
 * A promise and the function that resolves it. The slow-run tests wait on one
 * for "the run has begun" instead of polling a fixed window: a claim is a few
 * database round trips, and on a loaded machine those outlast any window.
 */
function signal(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Fail, not hang, when a run that should start never does. */
const SLOW_RUN_TEST = { timeout: 30_000 };

/** N schedulers, each with its own registry holding the same job name. */
function processes(
  count: number,
  handler: (process: number) => ScheduledJobHandler,
  intervalMs = 5 * MINUTE,
  leaseMs?: number,
): Scheduler[] {
  return Array.from({ length: count }, (_, i) => {
    const registry = createJobRegistry();
    registry.register("test-job", intervalMs, handler(i), { leaseMs });
    return createScheduler({ registry, owner: `process-${i}`, logger: silent });
  });
}

// ── no database needed ───────────────────────────────────────────────

describe("scheduler configuration", () => {
  it("SCHEDULER_ENABLED is on unless it says off", () => {
    assert.equal(parseBooleanDefaultOn(""), true);
    assert.equal(parseBooleanDefaultOn("true"), true);
    assert.equal(parseBooleanDefaultOn("yes"), true);
    for (const off of ["false", "FALSE", " 0 ", "no", "off"]) {
      assert.equal(parseBooleanDefaultOn(off), false, off);
    }
  });

  it("SCHEDULER_ENABLED=false starts no loop", () => {
    let ticks = 0;
    const scheduler: Scheduler = {
      owner: "never",
      stop: async () => {},
      tick: async () => {
        ticks += 1;
      },
    };
    assert.equal(shouldStartScheduler({ enabled: false, isTest: false }), false);
    assert.equal(startScheduler({ enabled: false, isTest: false }, scheduler), false);
    assert.equal(isSchedulerRunning(), false);
    assert.equal(ticks, 0);
  });

  it("starts nothing under NODE_ENV=test either", () => {
    assert.equal(shouldStartScheduler({ enabled: true, isTest: true }), false);
    assert.equal(shouldStartScheduler({ enabled: true, isTest: false }), true);
  });

  it("refuses a duplicate name, a bad name and a too-short interval", async () => {
    const registry = createJobRegistry();
    const noop: ScheduledJobHandler = async () => {};
    registry.register("runaway-reminder", 5 * MINUTE, noop);
    assert.throws(() => registry.register("runaway-reminder", MINUTE, noop), /already registered/);
    assert.throws(() => registry.register("Bad Name", MINUTE, noop), /lowercase/);
    assert.throws(() => registry.register("fast", 10, noop), /at least/);
    assert.deepEqual(
      registry.list().map((job) => job.name),
      ["runaway-reminder"],
    );
  });
});

// ── against MongoDB ──────────────────────────────────────────────────

describe("scheduler lease", { skip: skipWithoutDatabase }, () => {
  before(async () => {
    await connectTestDatabase("scheduler-lease", [
      ScheduledJob as unknown as mongoose.Model<never>,
    ]);
  });
  after(dropTestDatabase);
  beforeEach(clearTestDatabase);

  it("runs a job exactly once per interval across concurrent processes", async () => {
    const runs: { process: number; now: string }[] = [];
    const schedulers = processes(8, (process) => async ({ now }) => {
      runs.push({ process, now: now.toISOString() });
    });

    // Three intervals, each polled several times by every process at once,
    // including polls that land exactly on the boundary.
    const polls = [0, 1, 30_000, 5 * MINUTE, 5 * MINUTE + 30_000, 10 * MINUTE, 10 * MINUTE + 1];
    for (const offset of polls) {
      await Promise.all(schedulers.map((scheduler) => scheduler.tick(at(offset))));
    }

    assert.deepEqual(
      runs.map((run) => run.now),
      [at(0), at(5 * MINUTE), at(10 * MINUTE)].map((d) => d.toISOString()),
    );
    assert.equal(await ScheduledJob.countDocuments({ name: "test-job" }), 1);
  });

  it("does not start a second run beside a slow one", SLOW_RUN_TEST, async () => {
    const slowRunDone = signal();
    const started = signal();
    const release = slowRunDone.resolve;
    let runs = 0;
    const [slow, other] = processes(
      2,
      (process) => async () => {
        runs += 1;
        if (process === 0) {
          started.resolve();
          await slowRunDone.promise;
        }
      },
      MINUTE,
      10 * MINUTE,
    );

    const slowTick = slow.tick(at(0));
    // Process 0 holds the lease once its run has begun.
    await started.promise;
    assert.equal(runs, 1);

    // Two intervals later the job is due, but the lease is still held.
    await other.tick(at(2 * MINUTE));
    assert.equal(runs, 1);

    release();
    await slowTick;
    const row = await ScheduledJob.findOne({ name: "test-job" }).lean();
    assert.equal(row?.lockedBy, null);
    await other.tick(at(2 * MINUTE));
    assert.equal(runs, 2);
  });

  it("frees a job held by a process that died once its lease lapses", async () => {
    await ensureScheduledJob("test-job", MINUTE, at(0));
    const dead = await claimScheduledJob({
      name: "test-job",
      owner: "dead-process",
      intervalMs: MINUTE,
      leaseMs: 3 * MINUTE,
      now: at(0),
    });
    assert.ok(dead);

    const claim = (now: Date) =>
      claimScheduledJob({ name: "test-job", owner: "survivor", intervalMs: MINUTE, leaseMs: MINUTE, now });
    assert.equal(await claim(at(2 * MINUTE)), null, "lease still live");
    const taken = await claim(at(3 * MINUTE));
    assert.equal(taken?.lockedBy, "survivor");

    // The dead process's late release must not clear the survivor's lease.
    assert.equal(
      await releaseScheduledJob({ name: "test-job", owner: "dead-process", error: null }),
      false,
    );
    const row = await ScheduledJob.findOne({ name: "test-job" }).lean();
    assert.equal(row?.lockedBy, "survivor");
  });

  it("keeps a slow live run leased when another process reaches the next interval", SLOW_RUN_TEST, async () => {
    let runs = 0;
    const running = signal();
    const started = signal();
    const finish = running.resolve;
    // The lease is shorter than the run, so only renewal keeps it held.
    const [first, second] = processes(2, (process) => async () => {
      runs += 1;
      if (process === 0) { started.resolve(); await running.promise; }
    }, 1000, 600);
    const tick = first.tick();
    try {
      await started.promise;
      // Past the next interval, measured from after the claim.
      await new Promise((resolve) => setTimeout(resolve, 1100));
      await second.tick();
      assert.equal(runs, 1);
    } finally { finish(); await tick; await first.stop(); await second.stop(); }
  });

  it("renews only an owned live lease, never a successor or expired claim", async () => {
    await ensureScheduledJob("test-job", MINUTE, at(0));
    await claimScheduledJob({ name: "test-job", owner: "first", intervalMs: MINUTE, leaseMs: MINUTE, now: at(0) });
    assert.equal(await renewScheduledJob({ name: "test-job", owner: "other", leaseMs: MINUTE, now: at(30_000) }), false);
    assert.equal(await renewScheduledJob({ name: "test-job", owner: "first", leaseMs: MINUTE, now: at(30_000) }), true);
    assert.equal(await claimScheduledJob({ name: "test-job", owner: "second", intervalMs: MINUTE, leaseMs: MINUTE, now: at(MINUTE) }), null);
    assert.equal(await renewScheduledJob({ name: "test-job", owner: "first", leaseMs: MINUTE, now: at(90_000) }), false);
    assert.ok(await claimScheduledJob({ name: "test-job", owner: "second", intervalMs: MINUTE, leaseMs: MINUTE, now: at(90_000) }));
    assert.equal(await renewScheduledJob({ name: "test-job", owner: "first", leaseMs: MINUTE, now: at(90_001) }), false);
    assert.equal(await releaseScheduledJob({ name: "test-job", owner: "first", error: null }), false);
  });

  it("records a failure on the row and clears it after a success", async () => {
    let fail = true;
    const [scheduler] = processes(1, () => async () => {
      if (fail) throw new Error("boom");
    });

    await scheduler.tick(at(0));
    let row = await ScheduledJob.findOne({ name: "test-job" }).lean();
    assert.equal(row?.lastError, "boom");
    assert.equal(row?.lockedBy, null);
    assert.equal(row?.lastRunAt?.toISOString(), at(0).toISOString());
    assert.equal(row?.nextRunAt.toISOString(), at(5 * MINUTE).toISOString());

    fail = false;
    await scheduler.tick(at(5 * MINUTE));
    row = await ScheduledJob.findOne({ name: "test-job" }).lean();
    assert.equal(row?.lastError, null);
  });

  it("pulls a far-future next run back when the interval shrinks", async () => {
    await ensureScheduledJob("test-job", 60 * MINUTE, at(0));
    await ScheduledJob.updateOne({ name: "test-job" }, { $set: { nextRunAt: at(60 * MINUTE) } });
    await ensureScheduledJob("test-job", 5 * MINUTE, at(0));
    const row = await ScheduledJob.findOne({ name: "test-job" }).lean();
    assert.equal(row?.nextRunAt.toISOString(), at(5 * MINUTE).toISOString());
  });

  it("seeds one row when processes boot at the same instant", async () => {
    await Promise.all(
      Array.from({ length: 10 }, () => ensureScheduledJob("test-job", MINUTE, at(0))),
    );
    assert.equal(await ScheduledJob.countDocuments({ name: "test-job" }), 1);
  });
});
