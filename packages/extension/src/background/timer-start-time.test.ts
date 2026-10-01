import { beforeEach, expect, test, vi } from "vitest";
import { createOfflineQueue, memoryStorage, type TimeEntry } from "@starter/core";

const api = { mutate: vi.fn() };
let running: TimeEntry | null = null;
let queue = createOfflineQueue({ storage: memoryStorage() });
const remember = vi.fn(async (_entry: TimeEntry) => undefined);
vi.mock("./badge", () => ({ renderBadge: vi.fn(async () => undefined) }));
vi.mock("./idle-state", () => ({ noteLocalStart: vi.fn(), noteLocalStop: vi.fn() }));
vi.mock("./runtime", () => ({
  ensureReady: async () => ({ session: { userId: "user" }, api, apiUrl: "https://api.test" }),
  addressedWrite: () => ({ workspaceId: "ws", address: (input: object) => ({ ...input, workspaceId: "ws" }) }),
  flushQueue: async () => queue.size(),
  getCachedProjects: () => [],
  getKnownUserId: () => "user",
  getOfflineQueue: () => queue,
  invalidateRecents: vi.fn(),
  markEntriesStale: vi.fn(),
  isTransportFailure: (error: unknown) => error instanceof TypeError,
  ORIGIN_ID: "test",
  rememberOptimisticRunning: (entry: TimeEntry) => remember(entry),
  upsertOptimisticEntry: vi.fn(async () => undefined),
  resolveRunning: async () => running,
  setCachedRunning: (entry: TimeEntry | null) => { running = entry; },
  enqueueOffline: (op: string, input: unknown, tempId?: string) =>
    queue.enqueue(op, { input, tempId }, "user", "https://api.test", "ws"),
}));
const { startTimer, stopTimer, updateRunning } = await import("./timer");

const entry = (start: string): TimeEntry => ({
  id: "saved", start, description: "Work", projectId: null, taskId: null,
  billable: false, tagIds: [], workspaceId: "ws", authorId: "user", end: null,
  durationSec: 0, hourlyRate: null, currency: "EUR", source: "extension",
  timeZone: "UTC", runaway: null, invoiceId: null, importId: null,
  createdAt: start, updatedAt: start,
});
const earlier = "2026-09-30T08:00:00.000Z";
beforeEach(() => {
  running = null;
  queue = createOfflineQueue({ storage: memoryStorage() });
  api.mutate.mockReset();
  remember.mockClear();
});

test("an immediate start-time edit waits for Start and reaches the newly created entry", async () => {
  let finish!: (entry: TimeEntry) => void;
  api.mutate.mockImplementationOnce(() => new Promise<TimeEntry>((resolve) => { finish = resolve; }));
  api.mutate.mockImplementationOnce(async (_path, input) => ({ ...running, ...input }));
  const start = startTimer("Work", null);
  const edit = updateRunning({ start: earlier });
  await vi.waitFor(() => expect(api.mutate).toHaveBeenCalledTimes(1));
  finish(entry("2026-09-30T09:00:00.000Z"));
  await Promise.all([start, edit]);
  expect(api.mutate).toHaveBeenLastCalledWith("entries.update", expect.objectContaining({ id: "saved", start: earlier }));
  expect(running?.start).toBe(earlier);
});

test("offline start-time edits amend the durable start without sending a temporary id", async () => {
  api.mutate.mockRejectedValueOnce(new TypeError("offline"));
  await startTimer("Work", null);
  const tempId = running?.id;
  await updateRunning({ start: earlier });
  expect(api.mutate).toHaveBeenCalledTimes(1);
  expect(running?.start).toBe(earlier);
  expect(remember).toHaveBeenLastCalledWith(expect.objectContaining({ id: tempId, start: earlier }));
  const rows = await queue.list();
  expect(rows).toHaveLength(1);
  expect(rows[0].payload).toMatchObject({ input: { start: earlier }, tempId });
  await stopTimer();
  expect(running).toBeNull();
  expect((await queue.list()).map((row) => row.op)).toEqual(["entries.start", "entries.stop"]);
});

test("a refused Start cannot redirect its waiting edit to the previous timer", async () => {
  running = entry("2026-09-30T07:00:00.000Z");
  api.mutate.mockRejectedValueOnce(new Error("refused"));
  const results = await Promise.allSettled([startTimer("New", null), updateRunning({ start: earlier })]);
  expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
  expect(api.mutate).toHaveBeenCalledTimes(1);
  expect(running.start).toBe("2026-09-30T07:00:00.000Z");
});

test("Stop waits for a pending start-time save and leaves the timer stopped", async () => {
  running = entry("2026-09-30T09:00:00.000Z");
  let finish!: (entry: TimeEntry) => void;
  api.mutate.mockImplementationOnce(() => new Promise<TimeEntry>((resolve) => { finish = resolve; }));
  api.mutate.mockResolvedValueOnce(null);
  const edit = updateRunning({ start: earlier });
  const stop = stopTimer();
  await vi.waitFor(() => expect(api.mutate).toHaveBeenCalledTimes(1));
  finish(entry(earlier));
  await Promise.all([edit, stop]);
  expect(api.mutate.mock.calls.map(([path]) => path)).toEqual(["entries.update", "entries.stop"]);
  expect(running).toBeNull();
});
