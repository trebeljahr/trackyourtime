import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../api-client.js";
import {
  createOfflineQueue,
  QUEUE_FORMAT_VERSION,
  type QueuedMutation,
  type HoldReason,
} from "../offline-queue.js";
import {
  decodeOfflineMutation,
  heldReasons,
  holdBlocksReplay,
  scopedTempIdOf,
} from "../offline-ops.js";
import {
  classifyReplayOutcome,
  flushVerdictFor,
  replayOfflineMutation,
  STALE_STOP_MS,
  type OfflineReplayMutators,
} from "../offline-replay.js";
import {
  discardRecoveryRow,
  exportRecoveryRows,
  retryRecoveryRow,
  type RecoveryScope,
} from "../offline-recovery.js";
import { memoryStorage, type KeyValueStorage } from "../storage.js";

const SERVER = "https://time.example";
const scope = (overrides: Partial<RecoveryScope> = {}): RecoveryScope => ({
  owner: "alice",
  server: SERVER,
  legacyServer: SERVER,
  memberWorkspaceIds: new Set(["work-a", "work-b"]),
  ...overrides,
});
const payload = (description: string, tempId?: string): unknown => ({
  input: { description, start: "2026-10-01T09:00:00Z", originId: "test" },
  ...(tempId ? { tempId } : {}),
});
const mutators = (
  send: (op: string, input: unknown) => Promise<unknown>,
): OfflineReplayMutators => ({
  "entries.start": (input) => send("start", input),
  "entries.stop": (input) => send("stop", input),
  "entries.create": (input) => send("create", input),
  "entries.update": (input) => send("update", input),
  "entries.remove": (input) => send("remove", input),
  "entries.discard": (input) => send("discard", input),
});
const envelope = (json: string): QueuedMutation[] =>
  (JSON.parse(json) as { data: QueuedMutation[] }).data;

test("durable queue writes v3 so pre-receipt readers lock the queue", async () => {
  assert.equal(QUEUE_FORMAT_VERSION, 3);
  const storage = memoryStorage();
  const queue = createOfflineQueue({ storage });
  await queue.enqueue(
    "entries.start",
    payload("saved work"),
    "alice",
    SERVER,
    "work-a",
  );
  await queue.flush(async () => ({ hold: "refused", message: "Project gone" }));
  const raw = await storage.getItem("trackyourtime.offline-queue");
  const saved = JSON.parse(raw!) as { v: number; data: QueuedMutation[] };
  assert.ok(saved.v > 1);
  assert.equal(saved.data[0].hold?.reason, "refused");
  assert.equal(saved.data[0].hold?.message, "Project gone");
});

for (const [code, status] of [
  ["BAD_REQUEST", 400],
  ["FORBIDDEN", 403],
  ["NOT_FOUND", 404],
  ["CONFLICT", 409],
  ["GONE", 410],
  ["UNPROCESSABLE_CONTENT", 422],
] as const) {
  test(`${code} saves reason and original work across reload, with no automatic retry`, async () => {
    const storage = memoryStorage();
    const queue = createOfflineQueue({ storage });
    const original = payload("A morning of work");
    const row = await queue.enqueue(
      "entries.start",
      original,
      "alice",
      SERVER,
      "work-a",
    );
    const error = new ApiError("Fix this field", code, status);
    await queue.flush(async (stored) =>
      flushVerdictFor(await classifyReplayOutcome(error, stored), error),
    );
    const reloaded = createOfflineQueue({ storage });
    const [kept] = await reloaded.list();
    assert.equal(kept.id, row.id);
    assert.deepEqual(kept.payload, original);
    assert.equal(kept.hold?.reason, "refused");
    assert.equal(kept.hold?.message, "Fix this field");
    assert.equal(kept.hold?.code, code);
    assert.equal(
      holdBlocksReplay(kept, {
        retryHeld: true,
        now: Date.now() + 10 * STALE_STOP_MS,
      }),
      true,
    );
    let calls = 0;
    await reloaded.flush(async () => {
      calls += 1;
    });
    assert.equal(calls, 0);
    assert.equal(await reloaded.size(), 1);
  });
}

test("a rejected start keeps its stop and exports/repairs/discards the entire scoped chain", async () => {
  const queue = createOfflineQueue({ storage: memoryStorage() });
  const first = await queue.enqueue(
    "entries.start",
    payload("wrong project", "temp-1"),
    "alice",
    SERVER,
    "work-a",
  );
  const last = await queue.enqueue(
    "entries.stop",
    { input: { end: "2026-10-01T10:00:00Z" }, tempId: "temp-1" },
    "alice",
    SERVER,
    "work-a",
  );
  const foreign = await queue.enqueue(
    "entries.start",
    payload("secret", "temp-1"),
    "bob",
    SERVER,
    "work-a",
  );
  const otherWorkspace = await queue.enqueue(
    "entries.start",
    payload("other workspace", "temp-1"),
    "alice",
    SERVER,
    "work-b",
  );
  const called: string[] = [];
  await queue.flush(
    async (row) => {
      called.push(row.id);
      return row.id === first.id
        ? { hold: "refused", message: "Project gone" }
        : undefined;
    },
    {
      filter: (row) => row.owner === "alice" && row.workspaceId === "work-a",
      chainOf: scopedTempIdOf,
    },
  );
  assert.deepEqual(called, [first.id]);
  const before = await queue.list();
  assert.equal(heldReasons(before).get(last.id), "refused");
  const repeated = await queue.flush(
    async () => {
      throw new Error("A manually held chain must not run");
    },
    {
      filter: (row) => row.owner === "alice" && row.workspaceId === "work-a",
      chainOf: scopedTempIdOf,
    },
  );
  assert.equal(repeated.held, 2);
  assert.equal(repeated.skipped, 4);
  const exported = envelope(exportRecoveryRows(before, scope(), [last.id]));
  assert.deepEqual(
    exported.map((row) => row.id),
    [first.id, last.id],
  );
  assert.equal(
    await retryRecoveryRow(queue, scope, first.id, {
      description: "repaired",
      projectId: null,
    }),
    2,
  );
  const repaired = await queue.list();
  assert.deepEqual(repaired[0].originalPayload, first.payload);
  assert.equal(repaired[0].hold, undefined);
  assert.deepEqual(repaired[0].payload, {
    input: { description: "repaired", projectId: null },
    tempId: "temp-1",
  });
  assert.equal(await discardRecoveryRow(queue, scope, last.id), 2);
  assert.deepEqual(
    (await queue.list()).map((row) => row.id),
    [foreign.id, otherWorkspace.id],
  );
});

test("a later manual hold blocks its pending start too", async () => {
  const queue = createOfflineQueue({ storage: memoryStorage() });
  const start = await queue.enqueue(
    "entries.start",
    payload("start", "temp-1"),
    "alice",
    SERVER,
    "work-a",
  );
  const stop = await queue.enqueue(
    "entries.stop",
    { input: {}, tempId: "temp-1" },
    "alice",
    SERVER,
    "work-a",
  );
  await queue.amendRows((rows) =>
    rows.map((row) =>
      row.id === stop.id
        ? { ...row, hold: { reason: "stale-stop", at: row.createdAt } }
        : row,
    ),
  );
  const holds = heldReasons(await queue.list());
  assert.equal(holds.get(start.id), "stale-stop");
  let calls = 0;
  await queue.flush(
    async () => {
      calls += 1;
    },
    { chainOf: scopedTempIdOf },
  );
  assert.equal(calls, 0);
  assert.equal(await queue.size(), 2);
});

test("a successful start targets its refused stop durably before reload", async () => {
  const storage = memoryStorage();
  const queue = createOfflineQueue({ storage });
  await queue.enqueue(
    "entries.start",
    payload("meeting", "temp-1"),
    "alice",
    SERVER,
    "work-a",
  );
  const stop = await queue.enqueue(
    "entries.stop",
    { input: { end: "2026-10-01T10:00:00Z" }, tempId: "temp-1" },
    "alice",
    SERVER,
    "work-a",
  );
  const resolved = new Map<string, string>();
  const refuse = new ApiError("End needs correction", "BAD_REQUEST", 400);
  const api = mutators(async (op, input) => {
    if (op === "start") return { id: "original-entry" };
    assert.equal((input as { id: string }).id, "original-entry");
    throw refuse;
  });
  await queue.flush(
    async (row) => {
      try {
        return await replayOfflineMutation(
          api,
          { noteServerId: () => undefined },
          decodeOfflineMutation(row)!,
          { createdAt: row.createdAt, resolved },
        );
      } catch (error) {
        return flushVerdictFor(await classifyReplayOutcome(error, row), error);
      }
    },
    { chainOf: scopedTempIdOf },
  );
  const reloaded = createOfflineQueue({ storage });
  const [kept] = await reloaded.list();
  assert.equal(kept.id, stop.id);
  assert.equal(
    decodeOfflineMutation(kept)?.input &&
      (decodeOfflineMutation(kept)?.input as { id: string }).id,
    "original-entry",
  );
  assert.deepEqual(kept.originalPayload, stop.payload);
  await retryRecoveryRow(reloaded, scope, stop.id);
  let target: unknown;
  await reloaded.flush(async (row) =>
    replayOfflineMutation(
      mutators(async (_op, input) => {
        target = input;
      }),
      { noteServerId: () => undefined },
      decodeOfflineMutation(row)!,
      { createdAt: "2020-01-01T00:00:00Z", resolved: new Map() },
    ),
  );
  assert.equal((target as { id: string }).id, "original-entry");
  assert.equal(await reloaded.size(), 0);
});

test("an old generic stop never reaches today's timer, including explicit unmodified retry", async () => {
  const storage = memoryStorage();
  const queue = createOfflineQueue({ storage });
  const row = await queue.enqueue(
    "entries.stop",
    { input: { end: "2020-01-01T10:00:00Z" } },
    "alice",
    SERVER,
    "work-a",
  );
  await queue.amendRows((rows) =>
    rows.map((part) => ({ ...part, createdAt: "2020-01-01T00:00:00Z" })),
  );
  let calls = 0;
  await queue.flush(async (stored) => {
    try {
      return await replayOfflineMutation(
        mutators(async () => {
          calls += 1;
        }),
        { noteServerId: () => undefined },
        decodeOfflineMutation(stored)!,
        { createdAt: stored.createdAt, resolved: new Map() },
      );
    } catch (error) {
      return flushVerdictFor(await classifyReplayOutcome(error, stored), error);
    }
  });
  assert.equal(calls, 0);
  assert.equal((await queue.list())[0].hold?.reason, "stale-stop");
  await assert.rejects(
    retryRecoveryRow(queue, scope, row.id),
    /STOP_TARGET_REQUIRED/,
  );
  await retryRecoveryRow(queue, scope, row.id, {
    id: "original-entry",
    end: "2020-01-01T10:00:00Z",
  });
  assert.equal(
    (decodeOfflineMutation((await queue.list())[0])?.input as { id: string })
      .id,
    "original-entry",
  );
});

test("exports reveal only the live identity on this server; replay recovery also requires membership", async () => {
  const queue = createOfflineQueue({ storage: memoryStorage() });
  const mine = await queue.enqueue(
    "entries.start",
    payload("mine"),
    "alice",
    SERVER,
    "work-a",
  );
  await queue.enqueue(
    "entries.start",
    payload("bob secret"),
    "bob",
    SERVER,
    "work-a",
  );
  await queue.enqueue(
    "entries.start",
    payload("other server secret"),
    "alice",
    "https://other.example",
    "work-a",
  );
  await queue.enqueue("entries.future", { future: "unclaimed secret" });
  await queue.flush(async (row) =>
    row.id === mine.id ? { hold: "refused" } : { hold: "unknown-op" },
  );
  const rows = await queue.list();
  assert.deepEqual(
    envelope(exportRecoveryRows(rows, scope())).map((row) => row.id),
    [mine.id],
  );
  assert.deepEqual(
    envelope(exportRecoveryRows(rows, scope({ owner: null }))),
    [],
  );
  assert.deepEqual(
    envelope(
      exportRecoveryRows(rows, scope({ server: "https://elsewhere.example" })),
    ),
    [],
  );
  for (const changed of [
    scope({ owner: "bob" }),
    scope({ server: "https://other.example" }),
    scope({ memberWorkspaceIds: new Set() }),
  ]) {
    await assert.rejects(
      retryRecoveryRow(queue, () => changed, mine.id),
      /SCOPE_CHANGED/,
    );
  }
  await assert.rejects(
    discardRecoveryRow(queue, () => scope({ owner: "bob" }), mine.id),
    /SCOPE_CHANGED/,
  );
  await assert.rejects(
    retryRecoveryRow(queue, scope, mine.id, {
      workspaceId: "work-b",
      description: "retarget",
    }),
    /INVALID_INPUT/,
  );
  assert.deepEqual(
    (await queue.list()).find((row) => row.id === mine.id)?.payload,
    mine.payload,
  );
});

test("storage failure never reports a recovery edit or discard as completed", async () => {
  const memory = memoryStorage();
  let fail = false;
  const storage: KeyValueStorage = {
    getItem: memory.getItem,
    setItem: async (key, value) => {
      if (fail) throw new Error("disk full");
      await memory.setItem(key, value);
    },
    removeItem: async (key) => {
      if (fail) throw new Error("disk full");
      await memory.removeItem(key);
    },
  };
  const queue = createOfflineQueue({ storage });
  const row = await queue.enqueue(
    "entries.start",
    payload("saved work"),
    "alice",
    SERVER,
    "work-a",
  );
  fail = true;
  await assert.rejects(
    queue.flush(async () => ({ hold: "refused", message: "invalid" })),
    /disk full/,
  );
  assert.deepEqual((await queue.list())[0].payload, row.payload);
  fail = false;
  await queue.flush(async () => ({ hold: "refused", message: "invalid" }));
  const before = await memory.getItem("trackyourtime.offline-queue");
  fail = true;
  await assert.rejects(
    retryRecoveryRow(queue, scope, row.id, { description: "edited" }),
    /disk full/,
  );
  await assert.rejects(discardRecoveryRow(queue, scope, row.id), /disk full/);
  assert.equal(await memory.getItem("trackyourtime.offline-queue"), before);
  assert.equal(
    (await createOfflineQueue({ storage }).list())[0].hold?.reason,
    "refused",
  );
});

test("unknown future rows and hold details survive edits to known rows", async () => {
  const queue = createOfflineQueue({ storage: memoryStorage() });
  const known = await queue.enqueue(
    "entries.start",
    payload("known"),
    "alice",
    SERVER,
    "work-a",
  );
  const future = await queue.enqueue(
    "entries.future",
    { future: { format: 20 } },
    "alice",
    SERVER,
    "work-a",
  );
  await queue.amendRows((rows) =>
    rows.map((row) => ({
      ...row,
      hold: {
        reason: row.id === known.id ? "refused" : ("future-hold" as HoldReason),
        at: row.createdAt,
      },
    })),
  );
  const originalFuture = (await queue.list())[1];
  await retryRecoveryRow(queue, scope, known.id, { description: "fixed" });
  assert.deepEqual((await queue.list())[1], originalFuture);
  await assert.rejects(
    retryRecoveryRow(queue, scope, future.id),
    /UPDATE_REQUIRED/,
  );
  assert.equal(
    envelope(exportRecoveryRows(await queue.list(), scope(), [future.id]))[0]
      .op,
    "entries.future",
  );
});

test("an unknown operation makes its entire chain export-only", async () => {
  const queue = createOfflineQueue({ storage: memoryStorage() });
  const future = await queue.enqueue(
    "entries.future",
    { input: {}, tempId: "temp-future" },
    "alice",
    SERVER,
    "work-a",
  );
  const known = await queue.enqueue(
    "entries.start",
    payload("known", "temp-future"),
    "alice",
    SERVER,
    "work-a",
  );
  await queue.amendRows((rows) =>
    rows.map((row) =>
      row.id === known.id
        ? { ...row, hold: { reason: "refused", at: row.createdAt } }
        : row,
    ),
  );
  const rows = await queue.list();
  assert.deepEqual(
    [...heldReasons(rows).values()],
    ["unknown-op", "unknown-op"],
  );
  await assert.rejects(
    retryRecoveryRow(queue, scope, known.id),
    /UPDATE_REQUIRED/,
  );
  assert.deepEqual(
    envelope(exportRecoveryRows(rows, scope(), [known.id])).map(
      (row) => row.id,
    ),
    [future.id, known.id],
  );
});

test("friendly field repair clears unavailable references while retaining untouched content", async () => {
  const { repairRecoveryInput } = await import("../offline-recovery.js");
  const input = {
    description: "meeting",
    projectId: "gone",
    clientId: "gone",
    taskId: "gone",
    tagIds: ["gone"],
    start: "2026-10-01T09:00:00Z",
    end: "2026-10-01T10:00:00Z",
    source: "web",
  };
  assert.deepEqual(
    repairRecoveryInput("entries.create", input, {
      description: "fixed",
      clearCatalog: true,
    }),
    {
      ...input,
      description: "fixed",
      projectId: null,
      clientId: null,
      taskId: null,
      tagIds: [],
    },
  );
  const update = repairRecoveryInput("entries.update", input, {
    clearCatalog: true,
  });
  assert.equal("projectId" in update, false);
  assert.equal("taskId" in update, false);
  assert.equal("tagIds" in update, false);
  assert.equal(update.source, "web");
  assert.throws(
    () => repairRecoveryInput("entries.create", input, { end: "bad date" }),
    /INVALID_DATE/,
  );
  assert.throws(
    () =>
      repairRecoveryInput("entries.create", input, {
        end: "2020-01-01T10:00:00Z",
      }),
    /END_BEFORE_START/,
  );
});

test("orphan-stop candidates exclude colleagues, other workspaces and today's new timer", async () => {
  const { recoveryStopTargets } = await import("../offline-recovery.js");
  const row: QueuedMutation = {
    id: "stop",
    op: "entries.stop",
    owner: "alice",
    server: SERVER,
    workspaceId: "work-a",
    createdAt: "2026-10-01T10:00:00Z",
    payload: { input: { end: "2026-10-01T10:00:00Z" } },
  };
  const original = {
    id: "original",
    authorId: "alice",
    workspaceId: "work-a",
    description: "original meeting",
    start: "2026-10-01T09:00:00Z",
  };
  assert.deepEqual(
    recoveryStopTargets(
      [
        original,
        { ...original, id: "colleague", authorId: "bob" },
        { ...original, id: "elsewhere", workspaceId: "work-b" },
        { ...original, id: "today", start: "2026-10-04T09:00:00Z" },
      ],
      row,
      scope(),
    ),
    [
      {
        id: "original",
        description: "original meeting",
        start: original.start,
      },
    ],
  );
  assert.deepEqual(
    recoveryStopTargets([original], row, scope({ owner: "bob" })),
    [],
  );
});
