import { describe, expect, it, vi } from "vitest";
import type { OfflineMutation } from "@starter/core";
import type { DesktopAutopilotState, DesktopAutopilotWatch, DetailedEntry, TimeEntry } from "@starter/shared";

vi.mock("@/components/tracker/use-entry-mutations", () => ({
  TRACKER_LIST_INPUT: { from: "2000-01-01", to: "2999-12-31", limit: 50 },
}));
vi.mock("@/lib/offline", () => ({ isNetworkError: () => false }));

const {
  autopilotHistoryRange,
  autopilotTrackedRange,
  describeRunning,
  fieldsOfProposal,
  historyFrom,
  isAutopilotTimer,
  trackedWithoutRunning,
} = await import("./autopilot-data");
const { autopilotStripView, ASK_AFTER_MS } = await import("./autopilot-strip-view");
const { timelineWindow } = await import("./day-timeline-window");

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse("2026-10-19T09:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

const entry = (id: string, start: number, end: number | null, authorId = "u1") => ({
  id,
  authorId,
  start: iso(start),
  end: end === null ? null : iso(end),
});

const queuedStart = (tempId: string, at: number): OfflineMutation => ({
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

describe("trackedWithoutRunning", () => {
  const range = { start: T0 - 5 * HOUR, end: T0 + 2 * HOUR };

  it("keeps the person's stopped entries and leaves the running one out", () => {
    const tracked = trackedWithoutRunning({
      entries: [entry("a", T0 - HOUR, T0 - 30 * MIN), entry("run", T0 - 10 * MIN, null), entry("b", T0 - 2 * HOUR, T0 - HOUR, "u2")],
      viewerId: "u1",
      running: { id: "run" },
      queued: [],
      range,
      now: T0,
    });
    expect(tracked).toEqual([{ start: T0 - HOUR, end: T0 - 30 * MIN }]);
  });

  it("leaves out an open row even under another id, and the queued start of a running temp entry", () => {
    const tracked = trackedWithoutRunning({
      entries: [entry("stale-open", T0 - 20 * MIN, null)],
      viewerId: "u1",
      running: { id: "temp-1" },
      queued: [queuedStart("temp-1", T0 - 10 * MIN), queuedStart("temp-0", T0 - 3 * HOUR)],
      range,
      now: T0,
    });
    expect(tracked).toEqual([{ start: T0 - 3 * HOUR, end: T0 }]);
  });
});

describe("ranges", () => {
  it("are aligned so the query key holds for a while", () => {
    expect(autopilotTrackedRange(T0 + 17 * MIN)).toEqual(autopilotTrackedRange(T0 + 59 * MIN));
    expect(autopilotTrackedRange(T0).start).toBe(T0 - 5 * HOUR);
    const history = autopilotHistoryRange(T0, 30);
    expect(history.end - history.start).toBe(16 * 24 * HOUR);
  });
});

describe("history and fields", () => {
  it("learns only from the person's own entries", () => {
    const own = {
      ...entry("a", T0 - HOUR, T0),
      description: "Site",
      projectId: "p1",
      taskId: null,
      tagIds: ["t1"],
      billable: true,
    } as unknown as DetailedEntry;
    const other = { ...own, id: "b", authorId: "u2" } as DetailedEntry;
    expect(historyFrom({ entries: [own, other], viewerId: "u1", now: T0 })).toEqual([
      { start: T0 - HOUR, end: T0, description: "Site", projectId: "p1", taskId: null, tagIds: ["t1"], billable: true },
    ]);
  });

  it("describes the running entry and fills a proposal's blanks", () => {
    const running = { start: iso(T0), description: "x", projectId: null, taskId: null } as TimeEntry;
    expect(describeRunning(running)).toEqual({ start: T0, description: "x", projectId: null, taskId: null });
    expect(describeRunning(null)).toBeNull();
    expect(fieldsOfProposal({ projectId: "p1" })).toEqual({ description: "", projectId: "p1", taskId: null, tagIds: [] });
  });
});

const state = (over: Partial<DesktopAutopilotState> = {}): DesktopAutopilotState => ({
  active: true,
  owned: null,
  watch: null,
  log: [],
  learnedApps: 0,
  ...over,
});

const watch = (over: Partial<DesktopAutopilotWatch> = {}): DesktopAutopilotWatch => ({
  app: { key: "com.figma.desktop", name: "Figma" },
  since: T0,
  creditedMs: 3 * MIN,
  filing: { key: "k", via: "rule", fields: { description: "Site" } },
  held: false,
  ...over,
});

describe("autopilotStripView", () => {
  const owned = { start: T0, filingKey: "k", app: { key: "a", name: "Figma" }, via: "rule" as const, logId: "l1" };

  it("says nothing while off, or about a timer the person started", () => {
    expect(autopilotStripView(state({ active: false, watch: watch() }), null, 5)).toBeNull();
    expect(autopilotStripView(state({ owned }), { start: iso(T0 + HOUR) }, 5)).toBeNull();
    expect(isAutopilotTimer(state({ owned }), { start: iso(T0 + 400) })).toBe(true);
  });

  it("names Autopilot's own timer", () => {
    expect(autopilotStripView(state({ owned }), { start: iso(T0) }, 5)).toEqual({
      kind: "owned",
      at: T0,
      filingKey: "k",
      app: "Figma",
      logId: "l1",
    });
  });

  it("shows how close a nameable start is", () => {
    const view = autopilotStripView(state({ watch: watch() }), null, 5);
    expect(view?.kind).toBe("warming");
    expect(view?.kind === "warming" ? view.progress : 0).toBeCloseTo(0.6);
  });

  it("asks about unnamed work only once it has lasted", () => {
    expect(autopilotStripView(state({ watch: watch({ filing: null, creditedMs: MIN }) }), null, 5)).toBeNull();
    expect(autopilotStripView(state({ watch: watch({ filing: null, creditedMs: ASK_AFTER_MS }) }), null, 5)?.kind).toBe(
      "ask",
    );
    expect(autopilotStripView(state({ watch: watch({ held: true }) }), null, 5)?.kind).toBe("held");
  });
});

describe("timelineWindow", () => {
  const day = { start: Date.parse("2026-10-19T00:00:00.000Z"), end: Date.parse("2026-10-20T00:00:00.000Z") };
  const hourStart = (hour: number): number => day.start + hour * HOUR;

  it("shows 08:00–18:00 on a quiet day", () => {
    const frame = timelineWindow({ day, spans: [], now: null, hourStart });
    expect(frame.start).toBe(hourStart(8));
    expect(frame.end).toBe(hourStart(18));
    expect(frame.ticks).toHaveLength(11);
  });

  it("grows to whole hours around everything, and to now", () => {
    const frame = timelineWindow({
      day,
      spans: [{ start: hourStart(6) + 20 * MIN, end: hourStart(9) }],
      now: hourStart(21) + 5 * MIN,
      hourStart,
    });
    expect(frame.start).toBe(hourStart(6));
    expect(frame.end).toBe(hourStart(22));
  });
});
