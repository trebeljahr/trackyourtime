/**
 * Unit tests for the framework-free offline queue in @starter/core. The queue
 * is what makes start/stop survive a dead network, so ordering, the
 * stop-at-first-failure rule and durability across instances all matter.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  createOfflineQueue,
  isReplayableBy,
  memoryStorage,
  type KeyValueStorage,
  type QueuedMutation,
} from "@starter/core";

const KEY = "test.offline-queue";

/** A memory store we can also poke at directly, to assert what was persisted. */
const trackedStorage = (): KeyValueStorage & { raw(): string | null } => {
  const map = new Map<string, string>();
  return {
    getItem: async (key) => map.get(key) ?? null,
    setItem: async (key, value) => {
      map.set(key, value);
    },
    removeItem: async (key) => {
      map.delete(key);
    },
    raw: () => map.get(KEY) ?? null,
  };
};

describe("createOfflineQueue", () => {
  let storage: KeyValueStorage & { raw(): string | null };

  beforeEach(() => {
    storage = trackedStorage();
  });

  const queue = (): ReturnType<typeof createOfflineQueue> =>
    createOfflineQueue({ storage, key: KEY });

  it("starts empty", async () => {
    const offline = queue();
    expect(await offline.list()).toEqual([]);
    expect(await offline.size()).toBe(0);
  });

  it("keeps mutations in the order they were made", async () => {
    const offline = queue();
    await offline.enqueue("entries.start", { description: "one" });
    await offline.enqueue("entries.stop", { description: "two" });
    await offline.enqueue("entries.update", { description: "three" });

    expect((await offline.list()).map((m) => m.op)).toEqual([
      "entries.start",
      "entries.stop",
      "entries.update",
    ]);
    expect(await offline.size()).toBe(3);
  });

  it("stamps each mutation with an id, its payload and a timestamp", async () => {
    const offline = queue();
    const mutation = await offline.enqueue("entries.start", { id: "temp-1" });

    expect(mutation.id).toBeTruthy();
    expect(mutation.op).toBe("entries.start");
    expect(mutation.payload).toEqual({ id: "temp-1" });
    expect(Number.isNaN(Date.parse(mutation.createdAt))).toBe(false);
    expect(await offline.list()).toEqual([mutation]);
  });

  it("serializes concurrent enqueues instead of clobbering them", async () => {
    const offline = queue();
    await Promise.all([
      offline.enqueue("a", 1),
      offline.enqueue("b", 2),
      offline.enqueue("c", 3),
    ]);
    expect((await offline.list()).map((m) => m.op)).toEqual(["a", "b", "c"]);
  });

  it("removes a single mutation by id and clears the rest", async () => {
    const offline = queue();
    const first = await offline.enqueue("a", 1);
    await offline.enqueue("b", 2);

    await offline.remove(first.id);
    expect((await offline.list()).map((m) => m.op)).toEqual(["b"]);

    await offline.clear();
    expect(await offline.size()).toBe(0);
    expect(storage.raw()).toBeNull();
  });

  describe("flush", () => {
    it("replays every mutation in order and empties the queue", async () => {
      const offline = queue();
      await offline.enqueue("a", 1);
      await offline.enqueue("b", 2);
      await offline.enqueue("c", 3);

      const seen: string[] = [];
      const result = await offline.flush(async (mutation) => {
        seen.push(mutation.op);
      });

      expect(seen).toEqual(["a", "b", "c"]);
      expect(result).toEqual({ flushed: 3, skipped: 0, held: 0, remaining: 0 });
      expect(await offline.size()).toBe(0);
    });

    it("stops at the first failure and keeps that mutation plus the rest", async () => {
      const offline = queue();
      await offline.enqueue("a", 1);
      await offline.enqueue("b", 2);
      await offline.enqueue("c", 3);

      const boom = new Error("offline again");
      const attempted: string[] = [];
      const result = await offline.flush(async (mutation) => {
        attempted.push(mutation.op);
        if (mutation.op === "b") throw boom;
      });

      expect(attempted).toEqual(["a", "b"]);
      expect(result.flushed).toBe(1);
      expect(result.remaining).toBe(2);
      expect(result.failed?.op).toBe("b");
      expect(result.error).toBe(boom);

      // The failed mutation stays at the head so ordering survives the retry.
      expect((await offline.list()).map((m) => m.op)).toEqual(["b", "c"]);
    });

    it("can be retried and drains what was left behind", async () => {
      const offline = queue();
      await offline.enqueue("a", 1);
      await offline.enqueue("b", 2);

      let failNext = true;
      await offline.flush(async () => {
        if (failNext) {
          failNext = false;
          throw new Error("first attempt fails");
        }
      });
      expect(await offline.size()).toBe(2);

      const second = await offline.flush(async () => {});
      expect(second).toEqual({ flushed: 2, skipped: 0, held: 0, remaining: 0 });
      expect(await offline.size()).toBe(0);
    });

    it("reports an empty flush", async () => {
      expect(await queue().flush(async () => {})).toEqual({
        flushed: 0,
        skipped: 0,
        held: 0,
        remaining: 0,
      });
    });
  });

  /*
   * The queue outlives a sign-out on purpose — an auth error stops the flush
   * and keeps the rows rather than deleting time the server has never seen —
   * so a row has to say whose it is. Without that, the next account to sign in
   * on this device replays the previous account's work into its workspace.
   */
  describe("ownership", () => {
    it("stamps the owner it was given and leaves it off when given none", async () => {
      const offline = queue();
      const owned = await offline.enqueue("a", 1, "user-a");
      const legacy = await offline.enqueue("b", 2);

      expect(owned.owner).toBe("user-a");
      expect(legacy.owner).toBeUndefined();

      const rows = await offline.list();
      expect(rows.map((row) => row.owner)).toEqual(["user-a", undefined]);
    });

    it("decides replayability without inventing an owner", () => {
      expect(isReplayableBy({ owner: "user-a" }, "user-a")).toBe(true);
      expect(isReplayableBy({ owner: "user-a" }, "user-b")).toBe(false);
      // Legacy rows belong to whoever claims them first.
      expect(isReplayableBy({ owner: undefined }, "user-b")).toBe(true);
      // Signed out, nothing is replayable — not even an unowned row.
      expect(isReplayableBy({ owner: undefined }, null)).toBe(false);
      expect(isReplayableBy({ owner: "user-a" }, null)).toBe(false);
    });

    it("does not replay another account's rows, and does not drop them", async () => {
      const offline = queue();
      await offline.enqueue("a-start", 1, "user-a");
      await offline.enqueue("a-stop", 2, "user-a");

      const seen: string[] = [];
      const result = await offline.flush(
        async (mutation) => {
          seen.push(mutation.op);
        },
        { filter: (row) => isReplayableBy(row, "user-b") }
      );

      expect(seen).toEqual([]);
      expect(result).toEqual({ flushed: 0, skipped: 2, held: 0, remaining: 2 });
      expect((await offline.list()).map((m) => m.op)).toEqual([
        "a-start",
        "a-stop",
      ]);
    });

    it("replays an account's own rows", async () => {
      const offline = queue();
      await offline.enqueue("a-start", 1, "user-a");
      await offline.enqueue("a-stop", 2, "user-a");

      const seen: string[] = [];
      const result = await offline.flush(
        async (mutation) => {
          seen.push(mutation.op);
        },
        { filter: (row) => isReplayableBy(row, "user-a") }
      );

      expect(seen).toEqual(["a-start", "a-stop"]);
      expect(result).toEqual({ flushed: 2, skipped: 0, held: 0, remaining: 0 });
      expect(await offline.size()).toBe(0);
    });

    it("keeps the other account's rows in order while draining its own", async () => {
      const offline = queue();
      await offline.enqueue("a-1", 1, "user-a");
      await offline.enqueue("b-1", 2, "user-b");
      await offline.enqueue("a-2", 3, "user-a");
      await offline.enqueue("b-2", 4, "user-b");

      const seen: string[] = [];
      const result = await offline.flush(
        async (mutation) => {
          seen.push(mutation.op);
        },
        { filter: (row) => isReplayableBy(row, "user-b") }
      );

      expect(seen).toEqual(["b-1", "b-2"]);
      expect(result).toEqual({ flushed: 2, skipped: 2, held: 0, remaining: 2 });
      expect((await offline.list()).map((m) => m.op)).toEqual(["a-1", "a-2"]);
    });

    it("writes skipped rows back ahead of the remainder when a flush fails", async () => {
      const offline = queue();
      await offline.enqueue("a-1", 1, "user-a");
      await offline.enqueue("b-1", 2, "user-b");
      await offline.enqueue("b-2", 3, "user-b");

      const result = await offline.flush(
        async (mutation) => {
          if (mutation.op === "b-2") throw new Error("still offline");
        },
        { filter: (row) => isReplayableBy(row, "user-b") }
      );

      expect(result.flushed).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.remaining).toBe(2);
      expect(result.failed?.op).toBe("b-2");
      expect((await offline.list()).map((m) => m.op)).toEqual(["a-1", "b-2"]);
    });

    it("replays a legacy row for whoever is signed in", async () => {
      const offline = queue();
      // A row written by a build that predates ownership stamping.
      const legacy: QueuedMutation = {
        id: "1",
        op: "entries.start",
        payload: { input: {} },
        createdAt: new Date().toISOString(),
      };
      await storage.setItem(KEY, JSON.stringify([legacy]));

      const seen: string[] = [];
      await offline.flush(
        async (mutation) => {
          seen.push(mutation.op);
        },
        { filter: (row) => isReplayableBy(row, "user-b") }
      );

      expect(seen).toEqual(["entries.start"]);
    });

    it("lets the first account to claim the queue adopt the legacy rows", async () => {
      const offline = queue();
      await storage.setItem(
        KEY,
        JSON.stringify([
          { id: "1", op: "a", payload: null, createdAt: "2026-08-21T09:00:00.000Z" },
          {
            id: "2",
            op: "b",
            payload: null,
            createdAt: "2026-08-21T09:01:00.000Z",
            owner: "user-a",
          },
        ])
      );

      expect(await offline.adoptUnowned("user-a")).toBe(1);
      expect((await offline.list()).map((row) => row.owner)).toEqual([
        "user-a",
        "user-a",
      ]);

      // Adopted rows are then invisible to the next account, which is the
      // point: after this, user-b can never replay them.
      const seen: string[] = [];
      await offline.flush(
        async (mutation) => {
          seen.push(mutation.op);
        },
        { filter: (row) => isReplayableBy(row, "user-b") }
      );
      expect(seen).toEqual([]);
      expect(await offline.size()).toBe(2);
    });

    it("adopts nothing when every row already has an owner", async () => {
      const offline = queue();
      await offline.enqueue("a", 1, "user-a");
      expect(await offline.adoptUnowned("user-b")).toBe(0);
      expect((await offline.list())[0].owner).toBe("user-a");
    });

    it("treats a non-string owner as no owner at all", async () => {
      await storage.setItem(
        KEY,
        JSON.stringify([
          { id: "1", op: "a", payload: null, createdAt: "x", owner: 7 },
          { id: "2", op: "b", payload: null, createdAt: "x", owner: "" },
        ])
      );
      expect((await queue().list()).map((row) => row.owner)).toEqual([
        undefined,
        undefined,
      ]);
    });
  });

  describe("durability", () => {
    it("is visible to a fresh queue over the same storage", async () => {
      const first = queue();
      await first.enqueue("entries.start", { description: "survives" });

      const second = queue();
      const rows = await second.list();
      expect(rows).toHaveLength(1);
      expect(rows[0].payload).toEqual({ description: "survives" });
    });

    it("hands the remainder of a failed flush to the next queue instance", async () => {
      const first = queue();
      await first.enqueue("a", 1);
      await first.enqueue("b", 2);
      await first.flush(async (mutation) => {
        if (mutation.op === "b") throw new Error("still offline");
      });

      expect((await queue().list()).map((m) => m.op)).toEqual(["b"]);
    });

    it("keeps queues on different keys apart", async () => {
      const mine = createOfflineQueue({ storage, key: KEY });
      const other = createOfflineQueue({ storage, key: "other-queue" });

      await mine.enqueue("a", 1);
      expect(await other.size()).toBe(0);
    });

    it("drops a corrupt payload rather than wedging the app", async () => {
      await storage.setItem(KEY, "{not json");
      expect(await queue().list()).toEqual([]);
    });

    it("ignores rows that are not queued mutations", async () => {
      const good: QueuedMutation = {
        id: "1",
        op: "entries.stop",
        payload: null,
        createdAt: new Date().toISOString(),
      };
      await storage.setItem(KEY, JSON.stringify([good, { nope: true }, 7]));
      expect(await queue().list()).toEqual([good]);
    });

    it("treats a non-array payload as an empty queue", async () => {
      await storage.setItem(KEY, JSON.stringify({ id: "1" }));
      expect(await queue().list()).toEqual([]);
    });
  });

  it("works over the shipped in-memory storage", async () => {
    const offline = createOfflineQueue({ storage: memoryStorage() });
    await offline.enqueue("entries.start", { description: "default key" });
    expect(await offline.size()).toBe(1);
  });
});
