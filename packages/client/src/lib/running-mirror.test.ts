// @vitest-environment jsdom
/**
 * The running-timer mirror: what makes a cold offline launch show a clock
 * instead of an empty screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTimerStore } from "@starter/core";
import type { TimeEntry } from "@starter/shared";

const isNative = vi.fn(() => true);
const desktop = { value: false };
vi.mock("@/lib/shell", async () =>
  (await import("@/lib/shell-mock")).mockShellModule(() =>
    desktop.value ? "electron" : isNative() ? "capacitor" : "web",
  ),
);

const {
  __resetRunningMirrorForTests,
  readRunningMirror,
  seedRunningFromMirror,
  writeRunningMirror,
  isRunningProvisional,
} = await import("@/lib/running-mirror");

const running: TimeEntry = {
  id: "e1",
  workspaceId: "w1",
  authorId: "u1",
  description: "On the train",
  projectId: null,
  taskId: null,
  billable: false,
  start: "2026-08-21T09:00:00.000Z",
  end: null,
  durationSec: 0,
  hourlyRate: null,
  currency: "EUR",
  source: "mobile",
  timeZone: "Europe/Berlin",
  runaway: null,
  tagIds: [],
  invoiceId: null,
  importId: null,
  createdAt: "2026-08-21T09:00:00.000Z",
  updatedAt: "2026-08-21T09:00:00.000Z",
};

/**
 * A plain in-memory store, injected so the specs never depend on how
 * Capacitor's web fallback happens to name its keys.
 */
let backing = new Map<string, string>();

const fakeStorage = () => ({
  getItem: async (key: string) => backing.get(key) ?? null,
  setItem: async (key: string, value: string) => {
    backing.set(key, value);
  },
  removeItem: async (key: string) => {
    backing.delete(key);
  },
});

beforeEach(() => {
  desktop.value = false;
  isNative.mockReturnValue(true);
  window.localStorage.clear();
  backing = new Map();
  __resetRunningMirrorForTests(fakeStorage());
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("the mirror", () => {
  it("round-trips a running entry", async () => {
    await writeRunningMirror(running);
    expect(await readRunningMirror()).toEqual(running);
  });

  it("clears on null, so a timer stopped elsewhere stops coming back", async () => {
    await writeRunningMirror(running);
    await writeRunningMirror(null);
    expect(await readRunningMirror()).toBeNull();
  });

  it("refuses to restore an entry that is not running", async () => {
    // A finished entry, as an older build might have left it behind.
    backing.set(
      "trackyourtime.running-entry",
      JSON.stringify({ ...running, end: "2026-08-21T10:00:00.000Z" }),
    );
    expect(await readRunningMirror()).toBeNull();
  });

  it("treats an unreadable mirror as nothing running", async () => {
    backing.set("trackyourtime.running-entry", "{oops");
    expect(await readRunningMirror()).toBeNull();

    backing.set("trackyourtime.running-entry", JSON.stringify({ id: "e1" }));
    expect(await readRunningMirror()).toBeNull();
  });

  it("writes the versioned envelope", async () => {
    await writeRunningMirror(running);
    expect(JSON.parse(backing.get("trackyourtime.running-entry") ?? "")).toEqual({
      v: 1,
      data: running,
    });
  });

  it("restores a bare entry written before the envelope", async () => {
    backing.set("trackyourtime.running-entry", JSON.stringify(running));
    expect(await readRunningMirror()).toEqual(running);
  });

  it("restores an old shape missing fields, filling what the timer draws", async () => {
    // A build from before tags and time zones, as a phone left in a drawer has it.
    const { tagIds: _tags, timeZone: _zone, runaway: _runaway, ...old } = running;
    backing.set("trackyourtime.running-entry", JSON.stringify(old));
    const restored = await readRunningMirror();
    expect(restored?.id).toBe("e1");
    expect(restored?.description).toBe("On the train");
    expect(restored?.tagIds).toEqual([]);
    expect(restored?.timeZone).toBeNull();
  });

  it("keeps an entry carrying fields this build does not know", async () => {
    backing.set(
      "trackyourtime.running-entry",
      JSON.stringify({ v: 1, data: { ...running, somethingNew: { a: 1 } } }),
    );
    expect((await readRunningMirror())?.id).toBe("e1");
  });

  it("reads a mirror from a newer build as nothing running", async () => {
    backing.set(
      "trackyourtime.running-entry",
      JSON.stringify({ v: 2, data: running }),
    );
    expect(await readRunningMirror()).toBeNull();
  });

  it("treats garbage inside the envelope as nothing running", async () => {
    for (const data of [null, 42, "entry", [], { id: "e1", start: "soon", end: null }]) {
      backing.set("trackyourtime.running-entry", JSON.stringify({ v: 1, data }));
      expect(await readRunningMirror()).toBeNull();
    }
  });

  it("lives in localStorage in the desktop app, where the profile is not evicted", async () => {
    // The real store, not the injected one: the desktop app must not go
    // through Capacitor Preferences, whose web fallback prefixes its keys.
    __resetRunningMirrorForTests(null);
    desktop.value = true;
    await writeRunningMirror(running);
    expect(
      JSON.parse(window.localStorage.getItem("trackyourtime.running-entry") ?? "null"),
    ).toEqual({ v: 1, data: running });

    const timerStore = createTimerStore();
    await seedRunningFromMirror(timerStore);
    expect(timerStore.getState().running?.id).toBe("e1");
  });

  it("is inert on web", async () => {
    isNative.mockReturnValue(false);
    await writeRunningMirror(running);
    expect(backing.size).toBe(0);
    expect(await readRunningMirror()).toBeNull();
  });
});

describe("seedRunningFromMirror", () => {
  it("puts the mirrored timer into an empty store", async () => {
    await writeRunningMirror(running);
    const store = createTimerStore();

    expect(await seedRunningFromMirror(store)).toEqual(running);
    expect(store.getState().running).toEqual(running);
    expect(isRunningProvisional()).toBe(true);
  });

  it("ticks from the wall clock, so a long-dead app resumes correctly", async () => {
    await writeRunningMirror(running);
    const store = createTimerStore();
    vi.spyOn(Date, "now").mockReturnValue(
      Date.parse(running.start) + 90 * 60 * 1000,
    );

    await seedRunningFromMirror(store);
    expect(store.getState().elapsedSec).toBe(5400);
    vi.restoreAllMocks();
  });

  it("never overwrites an answer that already arrived", async () => {
    await writeRunningMirror(running);
    const store = createTimerStore();
    const fresher: TimeEntry = { ...running, id: "e2", description: "Newer" };
    store.getState().setRunning(fresher);

    expect(await seedRunningFromMirror(store)).toBeNull();
    expect(store.getState().running).toEqual(fresher);
  });

  it("does nothing on web", async () => {
    isNative.mockReturnValue(false);
    const store = createTimerStore();
    expect(await seedRunningFromMirror(store)).toBeNull();
    expect(store.getState().running).toBeNull();
  });

  it("stops being provisional once a real answer is mirrored", async () => {
    await writeRunningMirror(running);
    const store = createTimerStore();
    await seedRunningFromMirror(store);
    expect(isRunningProvisional()).toBe(true);

    await writeRunningMirror(running);
    expect(isRunningProvisional()).toBe(false);
  });
});
