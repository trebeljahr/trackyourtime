/**
 * The structured values this worker keeps in `chrome.storage.local`, read back
 * the way a different build would find them: bare values from before the
 * version envelope, envelopes from a newer build, and rows that are simply
 * wrong. Each must decode to what this build can use, or to a miss.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { TimeEntry } from "@starter/core";

// The worker modules pin their `chrome.storage` handle on first use, and every
// test gets a fresh fake `chrome`; a fresh module graph per test keeps the two
// in step.
const runtime = async (): Promise<typeof import("./runtime")> => import("./runtime");
const idleState = async (): Promise<typeof import("./idle-state")> => import("./idle-state");
const config = async (): Promise<typeof import("../lib/config")> => import("../lib/config");

const entry: TimeEntry = {
  id: "e1",
  workspaceId: "w1",
  authorId: "u1",
  description: "Offline start",
  projectId: "p1",
  taskId: null,
  billable: true,
  start: "2026-09-14T09:00:00.000Z",
  end: null,
  durationSec: 0,
  hourlyRate: 90,
  currency: "EUR",
  source: "extension",
  timeZone: "Europe/Berlin",
  runaway: null,
  tagIds: [],
  invoiceId: null,
  importId: null,
  createdAt: "2026-09-14T09:00:00.000Z",
  updatedAt: "2026-09-14T09:00:00.000Z",
};

const local = (): chrome.storage.StorageArea => chrome.storage.local;

const rawAt = async (key: string): Promise<unknown> => {
  const record = await local().get(key);
  return JSON.parse(record[key] as string);
};

beforeEach(() => {
  vi.resetModules();
});

describe("the optimistic running entry", () => {
  test("is written in the envelope and read back", async () => {
    const { rememberOptimisticRunning } = await runtime();
    await rememberOptimisticRunning(entry);
    expect(await rawAt("trackyourtime.optimistic-running")).toEqual({
      v: 1,
      data: { entry },
    });
  });

  test("reads the bare shape older builds wrote, stop included", async () => {
    const { decodeOptimisticRunning } = await runtime();
    expect(decodeOptimisticRunning(JSON.stringify({ entry }))).toEqual({ entry });
    expect(decodeOptimisticRunning(JSON.stringify({ entry: null }))).toEqual({
      entry: null,
    });
  });

  test("keeps fields it does not know, refuses what it would render wrongly", async () => {
    const { decodeOptimisticRunning } = await runtime();
    const withExtra = { ...entry, somethingNew: true };
    expect(
      decodeOptimisticRunning(JSON.stringify({ v: 1, data: { entry: withExtra } })),
    ).toEqual({ entry: withExtra });
    // A rate that would turn into NaN money, and an entry that is not running.
    expect(
      decodeOptimisticRunning(JSON.stringify({ entry: { ...entry, hourlyRate: "90" } })),
    ).toBeNull();
    expect(
      decodeOptimisticRunning(JSON.stringify({ entry: { ...entry, end: entry.start } })),
    ).toBeNull();
    expect(decodeOptimisticRunning(JSON.stringify({ entry: {} }))).toBeNull();
  });

  test("a newer build's value and garbage are a miss", async () => {
    const { decodeOptimisticRunning } = await runtime();
    expect(
      decodeOptimisticRunning(JSON.stringify({ v: 2, data: { entry } })),
    ).toBeNull();
    for (const raw of [null, "", "{", "[]", "7", JSON.stringify({ v: 1, data: 3 })]) {
      expect(decodeOptimisticRunning(raw)).toBeNull();
    }
  });
});

describe("the optimistic past entries", () => {
  const past: TimeEntry = {
    ...entry,
    id: "e2",
    end: "2026-09-14T10:00:00.000Z",
    durationSec: 3600,
  };

  test("round trip through the envelope", async () => {
    const { loadOptimisticEntries, upsertOptimisticEntry } = await runtime();
    await upsertOptimisticEntry(past);
    expect(await rawAt("trackyourtime.optimistic-entries")).toMatchObject({ v: 1 });
    expect(await loadOptimisticEntries()).toEqual({ upserts: [past], deletes: [] });
  });

  test("read the bare shape and drop only the unreadable rows", async () => {
    const { loadOptimisticEntries } = await runtime();
    await local().set({
      "trackyourtime.optimistic-entries": JSON.stringify({
        upserts: [past, { ...past, id: "bad", currency: 3 }, { id: "x" }],
        deletes: ["e9", 4],
      }),
    });
    expect(await loadOptimisticEntries()).toEqual({ upserts: [past], deletes: ["e9"] });
  });

  test("are empty for a newer build's value or garbage", async () => {
    const { loadOptimisticEntries } = await runtime();
    for (const raw of [
      JSON.stringify({ v: 2, data: { upserts: [past], deletes: [] } }),
      "{nope",
      "null",
    ]) {
      await local().set({ "trackyourtime.optimistic-entries": raw });
      expect(await loadOptimisticEntries()).toEqual({ upserts: [], deletes: [] });
    }
  });
});

describe("the idle watcher's memory", () => {
  const seed = { description: "Deep work", projectId: null, taskId: null, billable: false };
  const state = {
    ownedEntryId: "e1",
    idleFloorMs: 1000,
    pending: {
      entryId: "e1",
      idleStartedAt: "2026-09-14T09:10:00.000Z",
      detectedAt: "2026-09-14T09:15:00.000Z",
      idleSec: 300,
      signal: "idle",
      truncateAt: "2026-09-14T09:10:00.000Z",
      seed,
    },
    settledEntryId: null,
    awaitingResume: null,
    pausedEntryId: null,
  };

  test("reads the envelope and the bare state alike", async () => {
    const { decodeIdleState } = await idleState();
    expect(decodeIdleState(JSON.stringify({ v: 1, data: state }))).toEqual(state);
    expect(decodeIdleState(JSON.stringify(state))).toEqual(state);
  });

  test("resets a wrong field on its own instead of trusting it", async () => {
    const { decodeIdleState } = await idleState();
    const decoded = decodeIdleState(
      JSON.stringify({
        ...state,
        idleFloorMs: "soon",
        pending: { ...state.pending, idleSec: "300" },
        awaitingResume: { description: 1 },
        extra: true,
      }),
    );
    expect(decoded).toEqual({
      ...state,
      idleFloorMs: 0,
      pending: null,
      awaitingResume: null,
    });
  });

  test("starts empty from a newer build's value or garbage", async () => {
    const { decodeIdleState } = await idleState();
    const empty = decodeIdleState(null);
    expect(decodeIdleState(JSON.stringify({ v: 2, data: state }))).toEqual(empty);
    expect(decodeIdleState("{")).toEqual(empty);
    expect(empty.ownedEntryId).toBeNull();
  });
});

describe("the server info", () => {
  const info = {
    origin: "https://api.example.com",
    release: "1.2.0",
    commit: "abc",
    webUrl: null,
    originTrusted: true,
  };

  test("round trips through the envelope and reads the bare record", async () => {
    const { loadServerInfo, saveServerInfo } = await config();
    await saveServerInfo(info);
    expect(await rawAt("trackyourtime.server-info")).toEqual({ v: 1, data: info });
    expect(await loadServerInfo()).toEqual(info);

    await local().set({ "trackyourtime.server-info": JSON.stringify(info) });
    expect(await loadServerInfo()).toEqual(info);
  });

  test("a newer build's record is a miss", async () => {
    const { loadServerInfo } = await config();
    await local().set({
      "trackyourtime.server-info": JSON.stringify({ v: 2, data: info }),
    });
    expect(await loadServerInfo()).toBeNull();
  });
});
