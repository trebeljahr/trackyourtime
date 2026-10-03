import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, it } from "node:test";
import { createJobRegistry } from "../services/scheduler/registry.js";
import { createScheduler } from "../services/scheduler/scheduler.js";

type Leases = NonNullable<Parameters<typeof createScheduler>[0]>["leases"];
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve: (value) => resolve(value) };
}
function storage(overrides: Partial<NonNullable<Leases>> = {}): NonNullable<Leases> {
  return {
    ensure: async () => {},
    claim: async ({ name, owner, now, leaseMs }) => ({ name, lockedBy: owner,
      lockedUntil: new Date(now.getTime() + leaseMs), nextRunAt: now, lastRunAt: now, lastError: null }),
    renew: async () => true,
    release: async () => true,
    ...overrides,
  };
}
const logger = { log: () => {}, error: () => {} };

describe("scheduler shutdown and lease ownership", { timeout: 3000 }, () => {
  it("stops the next unit, awaits real work, and renews until it finishes", async () => {
    const started = deferred<void>();
    const finish = deferred<void>();
    let renewals = 0, releases = 0, secondUnit = 0;
    let signal!: AbortSignal;
    const registry = createJobRegistry();
    registry.register("slow", 1000, async (context) => {
      signal = context.signal;
      started.resolve();
      await finish.promise;
      signal.throwIfAborted();
      secondUnit += 1;
    }, { leaseMs: 150 });
    const scheduler = createScheduler({ registry, logger, leases: storage({
      renew: async () => { renewals += 1; return true; },
      release: async () => { releases += 1; return true; },
    }) });
    const tick = scheduler.tick();
    await started.promise;
    let stopped = false;
    const stopping = scheduler.stop().then(() => { stopped = true; });
    assert.equal(signal.aborted, true);
    await sleep(220);
    assert.equal(stopped, false);
    assert.equal(releases, 0, "the running operation must still hold its lease");
    assert.ok(renewals >= 2, "shutdown retains ownership while accepted work finishes");
    finish.resolve();
    await Promise.all([tick, stopping]);
    assert.equal(secondUnit, 0);
    assert.equal(releases, 1);
    await scheduler.tick();
    assert.equal(releases, 1, "a stopped scheduler never claims again");
  });

  it("aborts the handler when a renewal loses ownership", async () => {
    const registry = createJobRegistry();
    let reason = "", released = false;
    registry.register("lost", 1000, async ({ signal }) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      reason = String(signal.reason);
      signal.throwIfAborted();
    }, { leaseMs: 90 });
    const scheduler = createScheduler({ registry, logger, leases: storage({
      renew: async () => false,
      release: async () => { released = true; return false; },
    }) });
    await scheduler.tick();
    assert.match(reason, /lease lost/);
    assert.equal(released, true);
  });

  it("expires a stalled renewal and waits for it before releasing", async () => {
    const renewal = deferred<boolean>();
    const aborted = deferred<void>();
    let released = false;
    const registry = createJobRegistry();
    registry.register("stalled", 1000, async ({ signal }) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      aborted.resolve();
      signal.throwIfAborted();
    }, { leaseMs: 90 });
    const scheduler = createScheduler({ registry, logger, leases: storage({
      renew: async () => renewal.promise,
      release: async () => { released = true; return true; },
    }) });
    const tick = scheduler.tick();
    // Keep the test alive while production's intentionally unref'ed timers run.
    await Promise.all([aborted.promise, sleep(110)]);
    assert.equal(released, false);
    renewal.resolve(true);
    await tick;
    assert.equal(released, true);
  });

  it("does not enter a handler when a claim resolves after shutdown", async () => {
    const claimed = deferred<void>();
    const finishClaim = deferred<void>();
    let runs = 0, releases = 0;
    const registry = createJobRegistry();
    registry.register("late", 1000, async () => { runs += 1; });
    const base = storage();
    const scheduler = createScheduler({ registry, logger, leases: storage({
      claim: async (args) => { claimed.resolve(); await finishClaim.promise; return base.claim(args); },
      release: async () => { releases += 1; return true; },
    }) });
    const tick = scheduler.tick();
    await claimed.promise;
    const stopping = scheduler.stop();
    finishClaim.resolve();
    await Promise.all([tick, stopping]);
    assert.equal(runs, 0);
    assert.equal(releases, 1);
  });
});
