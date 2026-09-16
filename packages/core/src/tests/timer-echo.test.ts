import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryStorage } from "../storage.js";
import {
  TIMER_ECHO_KEY,
  readTimerEcho,
  reconcileRunning,
  writeTimerEcho,
} from "../timer-echo.js";

type Entry = { id: string };

const entry = (id: string): Entry => ({ id });

test("a snapshot with no echo is used as-is", () => {
  const running = entry("a");
  assert.deepEqual(
    reconcileRunning({ running, fetchedAt: 100 }, null),
    { running, refetch: false },
  );
});

test("an echo older than the snapshot never wins", () => {
  const running = entry("a");
  // The timer was started on another device after we recorded our own stop.
  assert.deepEqual(
    reconcileRunning({ running, fetchedAt: 200 }, { runningId: null, at: 100 }),
    { running, refetch: false },
  );
});

test("a stop echoed after the snapshot clears the timer without a refetch", () => {
  assert.deepEqual(
    reconcileRunning(
      { running: entry("a"), fetchedAt: 100 },
      { runningId: null, at: 101 },
    ),
    { running: null, refetch: false },
  );
});

test("an echo of the entry we are already holding keeps the rich copy", () => {
  const running = entry("a");
  assert.deepEqual(
    reconcileRunning({ running, fetchedAt: 100 }, { runningId: "a", at: 101 }),
    { running, refetch: false },
  );
});

test("an echo of an entry the snapshot never saw asks for a refetch", () => {
  assert.deepEqual(
    reconcileRunning(
      { running: entry("a"), fetchedAt: 100 },
      { runningId: "b", at: 101 },
    ),
    { running: null, refetch: true },
  );
});

test("an echo at exactly the snapshot's instant loses to the snapshot", () => {
  const running = entry("a");
  assert.deepEqual(
    reconcileRunning({ running, fetchedAt: 100 }, { runningId: null, at: 100 }),
    { running, refetch: false },
  );
});

test("round trips through storage", async () => {
  const storage = memoryStorage();
  assert.equal(await readTimerEcho(storage), null);

  await writeTimerEcho(storage, "a", 42);
  assert.deepEqual(await readTimerEcho(storage), { runningId: "a", at: 42 });

  await writeTimerEcho(storage, null, 43);
  assert.deepEqual(await readTimerEcho(storage), { runningId: null, at: 43 });
});

test("garbage in storage reads as no echo rather than throwing", async () => {
  const storage = memoryStorage();
  await storage.setItem(TIMER_ECHO_KEY, "{not json");
  assert.equal(await readTimerEcho(storage), null);

  await storage.setItem(TIMER_ECHO_KEY, JSON.stringify({ at: "soon" }));
  assert.equal(await readTimerEcho(storage), null);
});

test("a storage that throws never breaks the caller", async () => {
  const broken = {
    getItem: async (): Promise<string | null> => {
      throw new Error("locked");
    },
    setItem: async (): Promise<void> => {
      throw new Error("full");
    },
    removeItem: async (): Promise<void> => {},
  };
  assert.equal(await readTimerEcho(broken), null);
  await writeTimerEcho(broken, null, 1);
});

test("writes the versioned envelope and still reads an unversioned echo", async () => {
  const storage = memoryStorage();
  await writeTimerEcho(storage, "a", 42);
  assert.deepEqual(JSON.parse((await storage.getItem(TIMER_ECHO_KEY)) ?? ""), {
    v: 1,
    data: { runningId: "a", at: 42 },
  });

  // What every build before the envelope wrote.
  await storage.setItem(TIMER_ECHO_KEY, JSON.stringify({ runningId: "b", at: 7 }));
  assert.deepEqual(await readTimerEcho(storage), { runningId: "b", at: 7 });

  // A newer build's echo is not guessed at.
  await storage.setItem(
    TIMER_ECHO_KEY,
    JSON.stringify({ v: 2, data: { runningId: "c", at: 9 } }),
  );
  assert.equal(await readTimerEcho(storage), null);
});
