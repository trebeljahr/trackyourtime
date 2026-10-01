import assert from "node:assert/strict";
import { test } from "node:test";
import { createOfflineQueue } from "../offline-queue.js";
import { memoryStorage } from "../storage.js";

test("an amendment racing a replay cannot resurrect a flushed start", async () => {
  const queue = createOfflineQueue({ storage: memoryStorage() });
  await queue.enqueue("entries.start", { start: "before" });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const flush = queue.flush(async () => { entered(); await pending; });
  await started;
  const amend = queue.amendPayloads(() => ({ start: "after" }));
  release();
  await flush;
  assert.equal(await amend, 0);
  assert.deepEqual(await queue.list(), []);
});

test("an amendment racing a failed replay persists for the next attempt", async () => {
  const storage = memoryStorage();
  const queue = createOfflineQueue({ storage });
  await queue.enqueue("entries.start", { start: "before" }, "owner", "server", "workspace");
  const flush = queue.flush(async () => { throw new Error("offline"); });
  const amend = queue.amendPayloads(() => ({ start: "after" }));
  await flush;
  assert.equal(await amend, 1);
  const [row] = await createOfflineQueue({ storage }).list();
  assert.deepEqual(row.payload, { start: "after" });
  assert.equal(row.owner, "owner");
  assert.equal(row.server, "server");
  assert.equal(row.workspaceId, "workspace");
});
