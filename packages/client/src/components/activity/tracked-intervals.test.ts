import { describe, expect, it, vi } from "vitest";
import type { OfflineMutation } from "@starter/core";

vi.mock("@/components/tracker/use-entry-mutations", () => ({
  TRACKER_LIST_INPUT: { from: "2000-01-01", to: "2999-12-31", limit: 50 },
}));
vi.mock("@/lib/offline", () => ({
  isNetworkError: (error: unknown) => error instanceof TypeError,
}));

const { fetchRangeEntries, queuedIntervals, trackedIntervalsFrom, TRACKED_PAGE_LIMIT } = await import(
  "./tracked-intervals"
);

const MIN = 60_000;
const T0 = Date.parse("2026-09-22T09:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();
const range = { start: T0, end: T0 + 10 * 60 * MIN };

const entry = (id: string, authorId: string, start: number, end: number | null) => ({
  id,
  authorId,
  start: iso(start),
  end: end === null ? null : iso(end),
});

const start = (tempId: string, at: number): OfflineMutation => ({
  queueId: `q-${tempId}`,
  op: "entries.start",
  tempId,
  input: {
    description: "",
    projectId: null,
    taskId: null,
    billable: false,
    start: iso(at),
    source: "desktop",
    timeZone: "UTC",
    originId: "o",
  },
});

describe("trackedIntervalsFrom", () => {
  it("counts only the viewer's own entries, and temp ones", () => {
    const intervals = trackedIntervalsFrom({
      entries: [
        entry("e1", "me", T0, T0 + 30 * MIN),
        entry("e2", "colleague", T0 + 60 * MIN, T0 + 90 * MIN),
        entry("temp-1", "", T0 + 100 * MIN, T0 + 110 * MIN),
      ],
      viewerId: "me",
      running: null,
      queued: [],
      range,
      now: T0 + 5 * 60 * MIN,
    });
    expect(intervals).toEqual([
      { start: T0, end: T0 + 30 * MIN },
      { start: T0 + 100 * MIN, end: T0 + 110 * MIN },
    ]);
  });

  it("runs the running entry up to now", () => {
    const intervals = trackedIntervalsFrom({
      entries: [],
      viewerId: "me",
      running: { start: iso(T0 + 60 * MIN), end: null },
      queued: [],
      range,
      now: T0 + 90 * MIN,
    });
    expect(intervals).toEqual([{ start: T0 + 60 * MIN, end: T0 + 90 * MIN }]);
  });

  it("drops what does not overlap the range", () => {
    const intervals = trackedIntervalsFrom({
      entries: [entry("e1", "me", T0 - 120 * MIN, T0 - 60 * MIN), entry("e2", "me", T0 - 10 * MIN, T0 + 10 * MIN)],
      viewerId: "me",
      running: null,
      queued: [],
      range,
      now: T0,
    });
    expect(intervals).toEqual([{ start: T0 - 10 * MIN, end: T0 + 10 * MIN }]);
  });
});

describe("queuedIntervals", () => {
  it("reads a queued create, a queued start up to now, and a start ended by its queued stop", () => {
    const create: OfflineMutation = {
      queueId: "q-c",
      op: "entries.create",
      input: {
        description: "",
        projectId: null,
        taskId: null,
        billable: false,
        start: iso(T0),
        end: iso(T0 + 20 * MIN),
        source: "desktop",
        timeZone: "UTC",
        originId: "o",
      },
    };
    const stop: OfflineMutation = {
      queueId: "q-s",
      op: "entries.stop",
      tempId: "temp-a",
      input: { end: iso(T0 + 50 * MIN), originId: "o" },
    };
    expect(queuedIntervals([create, start("temp-a", T0 + 30 * MIN), stop, start("temp-b", T0 + 60 * MIN)], T0 + 70 * MIN)).toEqual([
      { start: T0, end: T0 + 20 * MIN },
      { start: T0 + 30 * MIN, end: T0 + 50 * MIN },
      { start: T0 + 60 * MIN, end: T0 + 70 * MIN },
    ]);
  });
});

describe("fetchRangeEntries", () => {
  const cached = [entry("c1", "me", T0, T0 + MIN)];
  const utilsWith = (fetch: (input: { cursor?: string }) => Promise<unknown>) =>
    ({
      entries: {
        list: {
          fetch: vi.fn(fetch),
          getInfiniteData: () => ({ pages: [{ entries: cached }] }),
        },
      },
    }) as unknown as Parameters<typeof fetchRangeEntries>[0];

  it("pages through the range, a day of lookback included", async () => {
    const utils = utilsWith(async (input) =>
      input.cursor === undefined
        ? { entries: [entry("e1", "me", T0, T0 + MIN)], nextCursor: "c2" }
        : { entries: [entry("e2", "me", T0 + 2 * MIN, T0 + 3 * MIN)] },
    );
    const rows = await fetchRangeEntries(utils, range);
    expect(rows.map((row) => row.id)).toEqual(["e1", "e2"]);
    const fetch = (utils as unknown as { entries: { list: { fetch: ReturnType<typeof vi.fn> } } }).entries.list.fetch;
    expect(fetch.mock.calls[0]?.[0]).toEqual({
      from: iso(T0 - 24 * 60 * MIN),
      to: iso(range.end),
      limit: TRACKED_PAGE_LIMIT,
    });
  });

  it("falls back to the tracker's cache on a transport failure", async () => {
    const utils = utilsWith(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await fetchRangeEntries(utils, range)).toEqual(cached);
  });

  it("throws a real answer from the server", async () => {
    const utils = utilsWith(async () => {
      throw new Error("FORBIDDEN");
    });
    await expect(fetchRangeEntries(utils, range)).rejects.toThrow("FORBIDDEN");
  });
});
