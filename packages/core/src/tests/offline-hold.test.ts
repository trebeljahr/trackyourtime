import assert from "node:assert/strict";
import { test } from "node:test";
import {
  corruptQueueKey,
  createOfflineQueue,
  OfflineQueueLockedError,
  type QueuedMutation,
} from "../offline-queue.js";
import {
  HELD_RETRY_MS,
  describeQueuedMutation,
  heldReasons,
  holdBlocksReplay,
  holdReasonOf,
  tempIdOf,
} from "../offline-ops.js";
import {
  classifyReplayOutcome,
  flushVerdictFor,
  isUnknownProcedure,
  StaleQueuedStopError,
} from "../offline-replay.js";
import { ApiError } from "../api-client.js";
import { memoryStorage, type KeyValueStorage } from "../storage.js";

const KEY = "trackyourtime.offline-queue";

const start = (tempId?: string): unknown => ({
  input: { description: "Invoicing", start: "2026-09-14T09:00:00.000Z", originId: "o" },
  ...(tempId ? { tempId } : {}),
});
const stop = (tempId?: string): unknown => ({
  input: { end: "2026-09-14T10:00:00.000Z", originId: "o" },
  ...(tempId ? { tempId } : {}),
});

const row = (overrides: Partial<QueuedMutation> = {}): QueuedMutation => ({
  id: "r",
  op: "entries.start",
  payload: start(),
  createdAt: "2026-09-14T09:00:00.000Z",
  ...overrides,
});

const unknownPath = (path: string): ApiError =>
  new ApiError(`No procedure found on path "${path}"`, "NOT_FOUND", 404);

// ── the classifier ───────────────────────────────────────────────────

test("an unknown procedure holds; an application NOT_FOUND drops", async () => {
  assert.deepEqual(
    await classifyReplayOutcome(unknownPath("entries.discard"), row()),
    { kind: "hold", reason: "unknown-procedure" },
  );
  // The runaway guard capped the entry a queued stop meant to close.
  assert.deepEqual(
    await classifyReplayOutcome(new ApiError("No running entry", "NOT_FOUND", 404), row()),
    { kind: "drop", reason: "refused" },
  );
  assert.deepEqual(
    await classifyReplayOutcome(new ApiError("Entry not found", "NOT_FOUND", 404), row()),
    { kind: "drop", reason: "refused" },
  );
  // A message that merely mentions the phrase is not tRPC's own.
  assert.equal(
    isUnknownProcedure({ code: "NOT_FOUND", httpStatus: 404, message: 'Oops: No procedure found on path "x"' }),
    false,
  );
});

test("an unknown procedure holds even for a stamped row whose membership is fine", async () => {
  let asked = false;
  const outcome = await classifyReplayOutcome(
    unknownPath("entries.discard"),
    row({ workspaceId: "ws-a" }),
    { stillMember: async () => { asked = true; return true; } },
  );
  assert.deepEqual(outcome, { kind: "hold", reason: "unknown-procedure" });
  assert.equal(asked, false);
});

test("400, 403, 409, 410 and 422 are refusals on the merits", async () => {
  for (const [code, status] of [
    ["BAD_REQUEST", 400],
    ["FORBIDDEN", 403],
    ["CONFLICT", 409],
    ["GONE", 410],
    ["UNPROCESSABLE_CONTENT", 422],
  ] as const) {
    assert.deepEqual(
      await classifyReplayOutcome(new ApiError("no", code, status), row()),
      { kind: "drop", reason: "refused" },
      code,
    );
  }
});

test("5xx, 429, PARSE_ERROR, transport and unreadable errors retry later", async () => {
  for (const [code, status] of [
    ["INTERNAL_SERVER_ERROR", 500],
    ["SERVICE_UNAVAILABLE", 503],
    ["TOO_MANY_REQUESTS", 429],
    ["PARSE_ERROR", 404],
    ["PARSE_ERROR", 403],
  ] as const) {
    assert.deepEqual(
      await classifyReplayOutcome(new ApiError("x", code, status), row()),
      { kind: "retry-later", reason: "server" },
      `${code} ${status}`,
    );
  }
  assert.deepEqual(
    await classifyReplayOutcome(new TypeError("fetch failed"), row()),
    { kind: "retry-later", reason: "transport" },
  );
  // A client whose transport test is narrower: an error that is no answer.
  assert.deepEqual(
    await classifyReplayOutcome(new Error("boom"), row(), { isTransportFailure: () => false }),
    { kind: "retry-later", reason: "server" },
  );
});

test("UNAUTHORIZED retries later with its own reason", async () => {
  assert.deepEqual(
    await classifyReplayOutcome(new ApiError("x", "UNAUTHORIZED", 401), row()),
    { kind: "retry-later", reason: "unauthorized" },
  );
});

test("a stale id-less stop drops", async () => {
  assert.deepEqual(
    await classifyReplayOutcome(new StaleQueuedStopError("2026-09-01T00:00:00Z"), row()),
    { kind: "drop", reason: "stale-stop" },
  );
});

test("a tRPC client error shape is read like an ApiError", async () => {
  const trpcLike = Object.assign(new Error('No procedure found on path "entries.discard"'), {
    data: { code: "NOT_FOUND", httpStatus: 404 },
  });
  assert.deepEqual(
    await classifyReplayOutcome(trpcLike, row(), { isTransportFailure: () => false }),
    { kind: "hold", reason: "unknown-procedure" },
  );
  const noStatus = Object.assign(new Error("bad"), { data: { code: "BAD_REQUEST" } });
  assert.deepEqual(
    await classifyReplayOutcome(noStatus, row(), { isTransportFailure: () => false }),
    { kind: "drop", reason: "refused" },
  );
});

test("a NOT_FOUND on a stamped row is kept unless membership is confirmed", async () => {
  const notFound = new ApiError("Entry not found", "NOT_FOUND", 404);
  const stamped = row({ workspaceId: "ws-a" });
  assert.deepEqual(
    await classifyReplayOutcome(notFound, stamped, { stillMember: async () => false }),
    { kind: "retry-later", reason: "membership" },
  );
  assert.deepEqual(
    await classifyReplayOutcome(notFound, stamped, {
      stillMember: async () => {
        throw new Error("offline");
      },
    }),
    { kind: "retry-later", reason: "membership" },
  );
  assert.deepEqual(
    await classifyReplayOutcome(notFound, stamped, { stillMember: async () => true }),
    { kind: "drop", reason: "refused" },
  );
});

test("holdRefusal can hold a refusal on the merits, and only that", async () => {
  const holdRefusal = (): "unknown-procedure" => "unknown-procedure";
  assert.deepEqual(
    await classifyReplayOutcome(new ApiError("bad", "BAD_REQUEST", 400), row(), { holdRefusal }),
    { kind: "hold", reason: "unknown-procedure" },
  );
  assert.deepEqual(
    await classifyReplayOutcome(new ApiError("x", "INTERNAL_SERVER_ERROR", 500), row(), { holdRefusal }),
    { kind: "retry-later", reason: "server" },
  );
});

test("flushVerdictFor rethrows retry-later and hands back holds", () => {
  const error = new Error("x");
  assert.throws(() => flushVerdictFor({ kind: "retry-later", reason: "server" }, error), /x/);
  assert.deepEqual(flushVerdictFor({ kind: "hold", reason: "unknown-op" }, error), { hold: "unknown-op" });
  assert.equal(flushVerdictFor({ kind: "drop", reason: "refused" }, error), undefined);
});

// ── hold helpers ─────────────────────────────────────────────────────

test("a row this build cannot decode is held unknown-op", () => {
  assert.equal(holdReasonOf(row({ op: "entries.pause" })), "unknown-op");
  assert.equal(holdReasonOf(row({ payload: { input: 7 } })), "unknown-op");
  assert.equal(holdReasonOf(row()), null);
  assert.equal(holdBlocksReplay(row({ op: "entries.pause" }), { retryHeld: true }), true);
  const summary = describeQueuedMutation(row({ op: "entries.pause" }));
  assert.equal(summary.op, null);
  assert.equal(summary.hold, "unknown-op");
});

test("an unknown-procedure hold is retried hourly, or when asked", () => {
  const now = Date.parse("2026-09-14T12:00:00.000Z");
  const recent = row({ hold: { reason: "unknown-procedure", at: new Date(now - 60_000).toISOString() } });
  const old = row({ hold: { reason: "unknown-procedure", at: new Date(now - HELD_RETRY_MS).toISOString() } });
  assert.equal(holdBlocksReplay(recent, { now }), true);
  assert.equal(holdBlocksReplay(recent, { now, retryHeld: true }), false);
  assert.equal(holdBlocksReplay(old, { now }), false);
  assert.equal(holdBlocksReplay(row(), { now }), false);
});

test("heldReasons follows a temp-id chain in order, and only forwards", () => {
  const rows: QueuedMutation[] = [
    row({ id: "stop-before", op: "entries.stop", payload: stop("t1") }),
    row({ id: "start", op: "entries.future", payload: start("t1") }),
    row({ id: "stop", op: "entries.stop", payload: stop("t1") }),
    row({ id: "other", op: "entries.stop", payload: stop("t2") }),
  ];
  const held = heldReasons(rows);
  assert.deepEqual([...held.entries()], [
    ["start", "unknown-op"],
    ["stop", "unknown-op"],
  ]);
  assert.equal(tempIdOf(rows[3]), "t2");
});

// ── the queue ────────────────────────────────────────────────────────

test("a hold verdict keeps the row, stamps it and carries on, holding its chain", async () => {
  const storage = memoryStorage();
  const queue = createOfflineQueue({ storage });
  const s = await queue.enqueue("entries.discard", start("t1"));
  const chained = await queue.enqueue("entries.stop", stop("t1"));
  const next = await queue.enqueue("entries.start", start("t2"));

  const ran: string[] = [];
  const result = await queue.flush(
    async (mutation) => {
      ran.push(mutation.id);
      if (mutation.id === s.id) return { hold: "unknown-procedure" };
    },
    { chainOf: tempIdOf },
  );

  assert.deepEqual(ran, [s.id, next.id]);
  assert.equal(result.flushed, 1);
  assert.equal(result.held, 2);
  assert.equal(result.skipped, 2);
  assert.equal(result.remaining, 2);
  const rows = await queue.list();
  assert.deepEqual(rows.map((it) => it.id), [s.id, chained.id]);
  assert.equal(rows[0].hold?.reason, "unknown-procedure");
  assert.equal(rows[1].hold, undefined);
});

test("an unknown-op verdict is not written onto the row", async () => {
  const queue = createOfflineQueue({ storage: memoryStorage() });
  await queue.enqueue("entries.future", start());
  await queue.flush(async () => ({ hold: "unknown-op" }));
  const [only] = await queue.list();
  assert.equal(only.hold, undefined);
});

test("a filtered row strands its chain without calling it held", async () => {
  const queue = createOfflineQueue({ storage: memoryStorage() });
  const a = await queue.enqueue("entries.start", start("t1"));
  await queue.enqueue("entries.stop", stop("t1"));
  const result = await queue.flush(async () => undefined, {
    filter: (mutation) => mutation.id !== a.id,
    chainOf: tempIdOf,
  });
  assert.equal(result.flushed, 0);
  assert.equal(result.skipped, 2);
  assert.equal(result.held, 0);
});

test("the queue is written as a versioned envelope and reads the legacy array", async () => {
  const storage = memoryStorage();
  await storage.setItem(
    KEY,
    JSON.stringify([{ id: "legacy", op: "entries.start", payload: start(), createdAt: "2026-09-01T00:00:00Z" }]),
  );
  const queue = createOfflineQueue({ storage });
  assert.deepEqual((await queue.list()).map((it) => it.id), ["legacy"]);

  await queue.enqueue("entries.stop", stop());
  const stored = JSON.parse((await storage.getItem(KEY)) ?? "null") as { v: number; data: unknown[] };
  assert.equal(stored.v, 1);
  assert.equal(stored.data.length, 2);
  assert.equal((await queue.list()).length, 2);
});

const recordingStorage = (): KeyValueStorage & { keys: () => string[]; raw: Map<string, string> } => {
  const raw = new Map<string, string>();
  return {
    raw,
    keys: () => [...raw.keys()],
    getItem: async (key) => raw.get(key) ?? null,
    setItem: async (key, value) => {
      raw.set(key, value);
    },
    removeItem: async (key) => {
      raw.delete(key);
    },
  };
};

test("an unreadable queue is copied aside before it is reset", async () => {
  for (const garbage of ["{not json", JSON.stringify({ data: [] }), JSON.stringify("x"), JSON.stringify({ v: 1, data: 3 })]) {
    const storage = recordingStorage();
    storage.raw.set(KEY, garbage);
    const queue = createOfflineQueue({ storage });
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      assert.deepEqual(await queue.list(), []);
    } finally {
      console.warn = warn;
    }
    const copies = storage.keys().filter((key) => key.startsWith(`${KEY}.corrupt.`));
    assert.equal(copies.length, 1, garbage);
    assert.equal(storage.raw.get(copies[0]), garbage);
    assert.equal(corruptQueueKey(KEY, 5), `${KEY}.corrupt.5`);

    await queue.enqueue("entries.start", start());
    assert.equal(storage.raw.get(copies[0]), garbage, "the copy survives the next enqueue");
  }
});

test("a queue in a newer format is listed as held and never overwritten", async () => {
  const storage = recordingStorage();
  const stored = JSON.stringify({
    v: 2,
    data: [{ id: "n", op: "entries.start", payload: start("t"), createdAt: "2026-09-14T09:00:00Z", level: 9 }],
    extra: true,
  });
  storage.raw.set(KEY, stored);
  const queue = createOfflineQueue({ storage });

  const rows = await queue.list();
  assert.equal(rows.length, 1);
  assert.equal(holdReasonOf(rows[0]), "unknown-op");
  assert.equal(heldReasons(rows).get("n"), "unknown-op");

  let ran = false;
  const result = await queue.flush(async () => {
    ran = true;
  });
  assert.equal(ran, false);
  assert.equal(result.remaining, 1);

  await assert.rejects(queue.enqueue("entries.stop", stop()), OfflineQueueLockedError);
  await assert.rejects(queue.remove("n"), OfflineQueueLockedError);
  await queue.clear();
  assert.equal(await queue.adoptUnowned("u"), 0);
  assert.equal(storage.raw.get(KEY), stored);
});

test("a stored hold with a reason this build does not know is dropped on read", async () => {
  const storage = memoryStorage();
  await storage.setItem(
    KEY,
    JSON.stringify({
      v: 1,
      data: [
        { ...row({ id: "a" }), hold: { reason: "server-too-old", at: "2026-09-14T09:00:00Z" } },
        { ...row({ id: "b" }), hold: { reason: "unknown-op", at: "2026-09-14T09:00:00Z" } },
        { ...row({ id: "c" }), hold: { reason: "unknown-procedure", at: "2026-09-14T09:00:00Z" } },
      ],
    }),
  );
  const rows = await createOfflineQueue({ storage }).list();
  assert.deepEqual(rows.map((it) => it.hold?.reason ?? null), [null, null, "unknown-procedure"]);
});
