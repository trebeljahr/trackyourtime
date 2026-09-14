import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createOfflineQueue,
  isQueuedOn,
  isReplayableBy,
  type QueuedMutation,
} from "../offline-queue.js";
import { describeQueuedMutation } from "../offline-ops.js";
import { memoryStorage } from "../storage.js";

const CLOUD = "https://api.trackyourtime.dev";
const OWN = "https://track.example.com";

const row = (server?: string): Pick<QueuedMutation, "server"> => ({ server });

test("a row replays only against the server it was queued on", () => {
  assert.equal(isQueuedOn(row(OWN), OWN, CLOUD), true);
  assert.equal(isQueuedOn(row(OWN), CLOUD, CLOUD), false);
  assert.equal(isQueuedOn(row(CLOUD), OWN, CLOUD), false);
});

test("the comparison ignores case and a trailing slash", () => {
  assert.equal(isQueuedOn(row("https://Track.Example.com/"), OWN, CLOUD), true);
});

test("an unstamped row belongs to the build's default server, not the current one", () => {
  // Made before the stamp existed, when the default was the only server.
  assert.equal(isQueuedOn(row(undefined), CLOUD, CLOUD), true);
  // Switching to another server must not hand it over.
  assert.equal(isQueuedOn(row(undefined), OWN, CLOUD), false);
});

test("the queue stores the server stamp and filters a flush by it", async () => {
  const queue = createOfflineQueue({ storage: memoryStorage() });
  await queue.enqueue("entries.start", { input: {} }, "u1", CLOUD);
  await queue.enqueue("entries.stop", { input: {} }, "u2", OWN);
  await queue.enqueue("entries.stop", { input: {} }, "u2", OWN);

  const listed = await queue.list();
  assert.deepEqual(
    listed.map((mutation) => mutation.server),
    [CLOUD, OWN, OWN],
  );

  const ran: string[] = [];
  const result = await queue.flush(
    async (mutation) => {
      ran.push(mutation.op);
    },
    {
      filter: (mutation) =>
        isReplayableBy(mutation, "u2") && isQueuedOn(mutation, OWN, CLOUD),
    },
  );

  assert.deepEqual(ran, ["entries.stop", "entries.stop"]);
  assert.equal(result.flushed, 2);
  assert.equal(result.skipped, 1);
  // The cloud row is kept, untouched, for a device that switches back.
  const kept = await queue.list();
  assert.equal(kept.length, 1);
  assert.equal(kept[0]?.server, CLOUD);
  assert.equal(kept[0]?.owner, "u1");
});

test("a malformed stamp reads as no stamp", async () => {
  const storage = memoryStorage();
  await storage.setItem(
    "tracktime.offline-queue",
    JSON.stringify([
      { id: "a", op: "entries.stop", payload: {}, createdAt: "2026-09-13T00:00:00Z", server: 42 },
      { id: "b", op: "entries.stop", payload: {}, createdAt: "2026-09-13T00:00:00Z", server: "" },
    ]),
  );
  const rows = await createOfflineQueue({ storage }).list();
  assert.deepEqual(
    rows.map((mutation) => mutation.server),
    [undefined, undefined],
  );
});

test("adopting unowned rows can be limited to one server", async () => {
  const queue = createOfflineQueue({ storage: memoryStorage() });
  await queue.enqueue("entries.start", { input: {} }, undefined, CLOUD);
  await queue.enqueue("entries.start", { input: {} }, undefined, OWN);

  const adopted = await queue.adoptUnowned("u-own", (mutation) =>
    isQueuedOn(mutation, OWN, CLOUD),
  );
  assert.equal(adopted, 1);
  const rows = await queue.list();
  assert.deepEqual(
    rows.map((mutation) => [mutation.server, mutation.owner]),
    [
      [CLOUD, undefined],
      [OWN, "u-own"],
    ],
  );
});

test("a described row carries the server it was queued on", async () => {
  const queue = createOfflineQueue({ storage: memoryStorage() });
  const mutation = await queue.enqueue(
    "entries.create",
    { input: { description: "Invoicing", start: "2026-09-12T09:00:00.000Z" } },
    "u1",
    OWN,
  );
  const summary = describeQueuedMutation(mutation);
  assert.equal(summary.server, OWN);
  assert.equal(summary.description, "Invoicing");
});

test("unstamped rows can be claimed for one server, once", async () => {
  const queue = createOfflineQueue({ storage: memoryStorage() });
  await queue.enqueue("entries.start", { input: {} }, "u1");
  await queue.enqueue("entries.start", { input: {} }, "u1", CLOUD);

  assert.equal(await queue.adoptUnserved(OWN), 1);
  assert.equal(await queue.adoptUnserved(CLOUD), 0);
  const rows = await queue.list();
  assert.deepEqual(
    rows.map((mutation) => mutation.server),
    [OWN, CLOUD],
  );
});
