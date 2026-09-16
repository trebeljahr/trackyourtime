// @vitest-environment jsdom
/**
 * The resume sequence, whose whole content is the ORDER.
 *
 * The obvious order is wrong. Invalidating `entries.current` before the queue
 * is flushed asks a server that has not yet heard about the start the user
 * made with no signal; it answers `null`, `useRunningEntry` sets the store to
 * null, and the running clock vanishes — reappearing seconds later when the
 * flush lands. A visible "my timer disappeared" on exactly the recovery path
 * this code exists to smooth.
 */
import { describe, expect, it, vi } from "vitest";

const { resumePlan, runResume } = await import("@/hooks/use-native-lifecycle");

const steps = (pending: number) => {
  const calls: string[] = [];
  return {
    calls,
    steps: {
      reconnect: vi.fn(() => {
        calls.push("reconnect");
      }),
      tick: vi.fn(() => {
        calls.push("tick");
      }),
      refreshLevel: vi.fn(async () => {
        calls.push("level");
      }),
      pending: vi.fn(async () => {
        calls.push("pending");
        return pending;
      }),
      flush: vi.fn(async () => {
        calls.push("flush");
      }),
      invalidateCurrent: vi.fn(async () => {
        calls.push("invalidate");
      }),
    },
  };
};

describe("resumePlan", () => {
  it("flushes when anything is queued, and refetches when nothing is", () => {
    expect(resumePlan(1)).toBe("flush");
    expect(resumePlan(0)).toBe("invalidate");
  });
});

describe("runResume", () => {
  it("reconnects and ticks before it touches the network", async () => {
    const { calls, steps: s } = steps(0);
    await runResume(s);
    expect(calls.slice(0, 2)).toEqual(["reconnect", "tick"]);
  });

  it("flushes instead of refetching when there is queued work", async () => {
    const { calls, steps: s } = steps(2);
    await runResume(s);

    expect(calls).toEqual(["reconnect", "tick", "level", "pending", "flush"]);
    // Not merely reordered — not run at all. The flush invalidates entries
    // itself once it has applied something, so an extra refetch here could
    // only race it back to the pre-flush state.
    expect(s.invalidateCurrent).not.toHaveBeenCalled();
  });

  it("refetches the running entry when the queue is empty", async () => {
    const { calls, steps: s } = steps(0);
    await runResume(s);

    expect(calls).toEqual(["reconnect", "tick", "level", "pending", "invalidate"]);
    expect(s.flush).not.toHaveBeenCalled();
  });

  it("ticks even when the flush is slow, so the clock is right immediately", async () => {
    const { calls, steps: s } = steps(1);
    let release = (): void => undefined;
    s.flush.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          calls.push("flush");
          release = resolve;
        }),
    );

    const done = runResume(s);
    await Promise.resolve();
    expect(calls).toContain("tick");

    // The flush starts a few microtasks later, after the level read settles.
    await vi.waitFor(() => expect(s.flush).toHaveBeenCalled());
    release();
    await done;
  });

  it("waits for the server's API level before a flush, never before an invalidate", async () => {
    const flushing = steps(1);
    let releaseLevel = (): void => undefined;
    flushing.steps.refreshLevel.mockImplementation(
      () => new Promise<void>((resolve) => {
        releaseLevel = resolve;
      }),
    );
    const run = runResume(flushing.steps);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(flushing.steps.flush).not.toHaveBeenCalled();
    releaseLevel();
    await run;
    expect(flushing.steps.flush).toHaveBeenCalledTimes(1);

    const idle = steps(0);
    idle.steps.refreshLevel.mockImplementation(() => new Promise<void>(() => undefined));
    await runResume(idle.steps);
    expect(idle.steps.invalidateCurrent).toHaveBeenCalledTimes(1);
  });

  it("a failed level read never blocks the flush", async () => {
    const { steps: s } = steps(1);
    s.refreshLevel.mockImplementation(async () => {
      throw new Error("offline");
    });
    await runResume(s);
    expect(s.flush).toHaveBeenCalledTimes(1);
  });
});
