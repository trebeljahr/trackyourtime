import assert from "node:assert/strict";
import { test } from "node:test";
import { locks } from "node:worker_threads";
import { createOfflineQueue } from "../offline-queue.js";
import { durableEntryEnvelope, durableQueuedWrite, type QueueExclusive } from "../durable-entry.js";
import { decodeOfflineMutation } from "../offline-ops.js";
import { memoryStorage } from "../storage.js";

const scope = { owner: "user-a", server: "https://example.invalid", workspaceId: "workspace-a" };
const exclusive: QueueExclusive = (task) => locks.request("durable-entry-tests", task);
const input = { description: "synthetic", projectId: null, taskId: null, billable: false, source: "web", timeZone: "UTC", originId: "fixture" };

test("response lost after commit: storage precedes HTTP and another instance retries the same immutable request", async () => {
  const storage = memoryStorage();
  const first = createOfflineQueue({ storage, exclusive, durableEntries: true });
  const receipts = new Map<string, unknown>();
  let writes = 0;
  let sent: unknown;
  await assert.rejects(first.submit("entries.start", { input }, scope, async (row) => {
    assert.equal(JSON.parse((await storage.getItem("trackyourtime.offline-queue"))!).data[0].submittedInput.operationId, row.submittedInput!.operationId);
    sent = durableEntryEnvelope(row.op, row.submittedInput);
    receipts.set(row.submittedInput!.operationId as string, { id: "entry-1" });
    writes += 1;
    throw new TypeError("synthetic lost response");
  }), (error) => durableQueuedWrite(error)?.rowId !== undefined);
  const restarted = createOfflineQueue({ storage, exclusive, durableEntries: true });
  // Even an optimistic edit cannot mutate a request that may have committed.
  await restarted.amendPayloads((row) => ({ ...(row.payload as object), input: { ...input, description: "later edit" } }));
  const report = await restarted.flush(async (row) => {
    const decoded = decodeOfflineMutation(row)!;
    assert.deepEqual(durableEntryEnvelope(decoded.op, decoded.input), sent);
    assert.ok(receipts.has(decoded.input.operationId!));
  });
  assert.equal(report.flushed, 1);
  assert.equal(writes, 1);
  assert.equal(await restarted.size(), 0);
});

test("independent queue instances serialize enqueue and HTTP checkpoints without lost or resurrected rows", async () => {
  const storage = memoryStorage();
  const a = createOfflineQueue({ storage, exclusive, durableEntries: true });
  const b = createOfflineQueue({ storage, exclusive, durableEntries: true });
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const sending = new Promise<void>((resolve) => { entered = resolve; });
  const first = a.submit("entries.start", { input }, scope, async () => { entered(); await gate; return "applied"; });
  await sending;
  const second = b.enqueue("entries.stop", { input: { end: "2026-10-04T00:01:00.000Z", originId: "fixture" } }, scope.owner, scope.server, scope.workspaceId);
  release();
  assert.equal(await first, "applied");
  await second;
  const rows = await a.list();
  assert.deepEqual(rows.map((row) => row.op), ["entries.stop"]);
  assert.match((rows[0]!.payload as { input: { operationId: string } }).input.operationId, /^[a-f\d-]{36}$/);
});

test("storage failure prevents the first HTTP attempt", async () => {
  const base = memoryStorage();
  const queue = createOfflineQueue({ storage: { ...base, setItem: async () => { throw new Error("disk full"); } }, exclusive, durableEntries: true });
  let sent = false;
  await assert.rejects(queue.submit("entries.start", { input }, scope, async () => { sent = true; }), /disk full/);
  assert.equal(sent, false);
});

test("legacy ambiguous writes are held without contacting any server", async () => {
  const storage = memoryStorage();
  await storage.setItem("trackyourtime.offline-queue", JSON.stringify([{ id: "legacy", op: "entries.start", payload: { input }, createdAt: "2026-10-01T00:00:00.000Z", ...scope }]));
  const queue = createOfflineQueue({ storage, exclusive, durableEntries: true });
  let sent = false;
  const report = await queue.flush(async () => { sent = true; });
  assert.equal(sent, false);
  assert.equal(report.held, 1);
  assert.equal((await queue.list())[0]!.hold?.code, "LEGACY_WRITE_OUTCOME_UNKNOWN");
});


test("standalone Mongo refusal holds the saved request for deliberate retry", async () => {
  const { ApiError } = await import("../api-client.js");
  const { classifyReplayOutcome } = await import("../offline-replay.js");
  const result = await classifyReplayOutcome(new ApiError("DURABLE_REPLAY_REQUIRES_REPLICA_SET", "PRECONDITION_FAILED", 412), { op: "entries.start" });
  assert.deepEqual(result, { kind: "hold", reason: "refused", message: "DURABLE_REPLAY_REQUIRES_REPLICA_SET", code: "PRECONDITION_FAILED" });
});
