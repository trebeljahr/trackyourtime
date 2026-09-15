/**
 * The queue outlives a sign-out on purpose: `isAuthError` stops the flush and
 * KEEPS the rows, because they are time the server has never seen. That makes
 * the queue a shared surface between whoever used this device last and whoever
 * is using it now — so every row records the account that queued it, and a
 * flush replays only the rows belonging to the account currently signed in.
 *
 * These are the client-side half of that. The pure queue mechanics live in
 * core-offline-queue.test.ts.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetOfflineQueueForTests,
  __resetOfflineQueueOwnerForTests,
  discardDeletedAccountQueue,
  discardForeignQueued,
  enqueueOffline,
  flushOfflineQueue,
  getForeignCount,
  getOfflineQueue,
  getOfflineQueueOwner,
  getPendingCount,
  listForeignQueued,
  refreshPendingCount,
  sealOfflineQueueOwner,
  setOfflineQueueOwner,
  type OfflineMutation,
  type OfflineStartInput,
} from "./offline";

const startInput = (description: string): OfflineStartInput => ({
  description,
  projectId: null,
  taskId: null,
  billable: true,
  start: "2026-08-21T09:00:00.000Z",
  source: "web",
  timeZone: "Europe/Berlin",
  originId: "tab-1",
});

/** Replay everything the current account is allowed to replay. */
const replay = async (): Promise<string[]> => {
  const seen: string[] = [];
  await flushOfflineQueue(async (mutation: OfflineMutation) => {
    seen.push((mutation.input as { description?: string }).description ?? mutation.op);
  });
  return seen;
};

describe("queue ownership", () => {
  beforeEach(() => {
    // A fresh in-memory queue per test — under the node environment there is
    // no window, so `resolveStorage()` hands back `memoryStorage()`.
    __resetOfflineQueueForTests();
    __resetOfflineQueueOwnerForTests();
  });

  it("stamps queued rows with the signed-in account", async () => {
    await setOfflineQueueOwner("user-a");
    expect(getOfflineQueueOwner()).toBe("user-a");

    await enqueueOffline("entries.start", startInput("A's work"), "temp-1");

    const rows = await getOfflineQueue().list();
    expect(rows.map((row) => row.owner)).toEqual(["user-a"]);
  });

  it("does not replay one account's rows under the next account", async () => {
    await setOfflineQueueOwner("user-a");
    await enqueueOffline("entries.start", startInput("A's work"), "temp-1");
    await enqueueOffline("entries.stop", {
      end: "2026-08-21T10:00:00.000Z",
      originId: "tab-1",
    });

    // A signs out, B signs in on the same device.
    await setOfflineQueueOwner(null);
    await setOfflineQueueOwner("user-b");

    expect(await replay()).toEqual([]);

    // Nothing was dropped — that is somebody's tracked time — and B is told
    // the device is holding it rather than shown a silently stuck counter.
    expect(await getOfflineQueue().size()).toBe(2);
    expect(getPendingCount()).toBe(0);
    expect(getForeignCount()).toBe(2);
  });

  it("replays an account's own rows when it signs back in", async () => {
    await setOfflineQueueOwner("user-a");
    await enqueueOffline("entries.start", startInput("A's work"), "temp-1");

    await setOfflineQueueOwner(null);
    await setOfflineQueueOwner("user-b");
    expect(await replay()).toEqual([]);

    await setOfflineQueueOwner("user-a");
    expect(getPendingCount()).toBe(1);
    expect(getForeignCount()).toBe(0);

    expect(await replay()).toEqual(["A's work"]);
    expect(await getOfflineQueue().size()).toBe(0);
  });

  it("keeps each account's rows apart in one queue", async () => {
    await setOfflineQueueOwner("user-a");
    await enqueueOffline("entries.start", startInput("A one"), "temp-a1");
    await setOfflineQueueOwner("user-b");
    await enqueueOffline("entries.start", startInput("B one"), "temp-b1");
    await setOfflineQueueOwner("user-a");
    await enqueueOffline("entries.start", startInput("A two"), "temp-a2");

    expect(await replay()).toEqual(["A one", "A two"]);

    await setOfflineQueueOwner("user-b");
    expect(getPendingCount()).toBe(1);
    expect(await replay()).toEqual(["B one"]);
  });

  it("lets the first account to sign in adopt rows queued before stamping", async () => {
    // No owner resolved yet — the shape a build predating ownership wrote,
    // and the shape a mutation queued mid-session-resolution still writes.
    await enqueueOffline("entries.start", startInput("legacy"), "temp-1");
    expect((await getOfflineQueue().list())[0].owner).toBeUndefined();

    // Unknown owner is not the same as "somebody else queued this": with no
    // account resolved, nothing is accused of being foreign.
    expect(await refreshPendingCount()).toBe(1);
    expect(getForeignCount()).toBe(0);

    await setOfflineQueueOwner("user-a");
    expect((await getOfflineQueue().list())[0].owner).toBe("user-a");

    // And from then on it is A's, so B cannot replay it.
    await setOfflineQueueOwner("user-b");
    expect(await replay()).toEqual([]);
    expect(getForeignCount()).toBe(1);

    await setOfflineQueueOwner("user-a");
    expect(await replay()).toEqual(["legacy"]);
  });

  it("replays nothing at all while no account is resolved", async () => {
    await setOfflineQueueOwner("user-a");
    await enqueueOffline("entries.start", startInput("A's work"), "temp-1");
    await setOfflineQueueOwner(null);

    expect(await replay()).toEqual([]);
    expect(await getOfflineQueue().size()).toBe(1);
  });

  it("reports how many legacy rows an account adopted", async () => {
    await enqueueOffline("entries.start", startInput("one"), "temp-1");
    await enqueueOffline("entries.start", startInput("two"), "temp-2");

    expect(await setOfflineQueueOwner("user-a")).toBe(2);
    // Nothing left to adopt, so a later switch claims nothing.
    expect(await setOfflineQueueOwner("user-b")).toBe(0);
  });
});

/*
 * `app/app/layout.tsx` keeps a phone with a stored token inside the app
 * when the session check cannot reach the server, so the tracker is fully
 * usable while `useSession()` still says nothing. That is the launch the
 * offline queue exists for, and it must not produce rows the next account can
 * claim.
 */
describe("queue ownership before the session resolves", () => {
  beforeEach(() => {
    __resetOfflineQueueForTests();
    __resetOfflineQueueOwnerForTests();
  });

  it("stamps a pre-resolution row with the account that owned the queue last", async () => {
    await setOfflineQueueOwner("user-a");

    // A relaunch: the queue and its owner stamp survive, `useSession()` does
    // not. `__resetOfflineQueueOwnerForTests` drops the in-memory owner while
    // leaving what was persisted, which is exactly a cold launch.
    __resetOfflineQueueOwnerForTests();
    await enqueueOffline("entries.start", startInput("offline launch"), "temp-1");

    expect((await getOfflineQueue().list())[0].owner).toBe("user-a");

    // So it is A's work, and B cannot take it.
    await setOfflineQueueOwner("user-b");
    expect(await replay()).toEqual([]);
    expect(getForeignCount()).toBe(1);
  });

  it("counts a pre-resolution row as this device's own, not as somebody else's", async () => {
    await setOfflineQueueOwner("user-a");
    await enqueueOffline("entries.start", startInput("A's work"), "temp-1");
    __resetOfflineQueueOwnerForTests();

    // Cold launch, session unresolved: the badge must not accuse the person
    // holding the phone of being a different account.
    expect(await refreshPendingCount()).toBe(1);
    expect(getForeignCount()).toBe(0);
  });

  it("still refuses to replay anything until a session resolves", async () => {
    await setOfflineQueueOwner("user-a");
    await enqueueOffline("entries.start", startInput("A's work"), "temp-1");
    __resetOfflineQueueOwnerForTests();

    // A stamp says who made a mutation. It is never a licence to send one.
    expect(await replay()).toEqual([]);
    expect(await getOfflineQueue().size()).toBe(1);
  });

  it("only leaves a row unowned on a device that has never had an account", async () => {
    await enqueueOffline("entries.start", startInput("first ever"), "temp-1");
    expect((await getOfflineQueue().list())[0].owner).toBeUndefined();
  });
});

describe("sealing the queue on sign-out", () => {
  beforeEach(() => {
    __resetOfflineQueueForTests();
    __resetOfflineQueueOwnerForTests();
  });

  it("claims what is still unowned for the departing account", async () => {
    // Queued before this device ever resolved an account, then signed in.
    await enqueueOffline("entries.start", startInput("legacy"), "temp-1");
    await setOfflineQueueOwner("user-a");
    // …and something queued while A was signed in.
    await enqueueOffline("entries.start", startInput("A's work"), "temp-2");

    await sealOfflineQueueOwner();

    const rows = await getOfflineQueue().list();
    expect(rows.map((row) => row.owner)).toEqual(["user-a", "user-a"]);

    // Nothing was destroyed — that is the whole difference from the
    // extension's forgetSession().
    expect(rows).toHaveLength(2);
  });

  it("stops the next account inheriting the stamp", async () => {
    await setOfflineQueueOwner("user-a");
    await sealOfflineQueueOwner();

    // B's cold-launch row is B's, not A's, even before B's session resolves.
    await enqueueOffline("entries.start", startInput("B's work"), "temp-1");
    expect((await getOfflineQueue().list())[0].owner).toBeUndefined();

    await setOfflineQueueOwner("user-b");
    expect(await replay()).toEqual(["B's work"]);
  });

  it("seals an account whose session never resolved this launch", async () => {
    await setOfflineQueueOwner("user-a");
    __resetOfflineQueueOwnerForTests();
    await enqueueOffline("entries.start", startInput("offline launch"), "temp-1");

    // `owner` is null here; the persisted stamp is what identifies the person
    // signing out.
    expect(await sealOfflineQueueOwner()).toBe(0);
    expect((await getOfflineQueue().list())[0].owner).toBe("user-a");
  });

  it("forgets the persisted owner, not just the in-memory one", async () => {
    await setOfflineQueueOwner("user-a");
    await sealOfflineQueueOwner();

    // A relaunch after the sign-out. Nothing is left in storage to stamp with,
    // so the seal really did reach `OFFLINE_QUEUE_OWNER_STORAGE_KEY` rather
    // than only clearing the module's own state.
    __resetOfflineQueueOwnerForTests();
    await enqueueOffline("entries.start", startInput("after relaunch"), "temp-1");
    expect((await getOfflineQueue().list())[0].owner).toBeUndefined();
  });
});

/*
 * Keeping another account's rows forever is right and, on its own, a dead end:
 * the tracker reports a count nobody can act on until the app is reinstalled.
 * These cover the way out — which is explicit, human, and never automatic.
 */
describe("another account's queued rows", () => {
  beforeEach(() => {
    __resetOfflineQueueForTests();
    __resetOfflineQueueOwnerForTests();
  });

  it("describes them well enough for a person to decide", async () => {
    await setOfflineQueueOwner("user-a");
    await enqueueOffline("entries.start", startInput("Design review"), "temp-1");
    await enqueueOffline("entries.stop", {
      end: "2026-08-21T10:00:00.000Z",
      originId: "tab-1",
    });
    await setOfflineQueueOwner("user-b");

    const rows = await listForeignQueued();
    expect(rows.map((row) => row.op)).toEqual([
      "entries.start",
      "entries.stop",
    ]);
    // The start carries what the work was called and when it happened; a stop
    // carries neither, so it falls back to when it was queued.
    expect(rows[0].description).toBe("Design review");
    expect(rows[0].at).toBe("2026-08-21T09:00:00.000Z");
    expect(rows[1].description).toBeNull();
    expect(Number.isNaN(Date.parse(rows[1].at))).toBe(false);
  });

  it("lists nothing while the rows are this account's own", async () => {
    await setOfflineQueueOwner("user-a");
    await enqueueOffline("entries.start", startInput("A's work"), "temp-1");
    expect(await listForeignQueued()).toEqual([]);
  });

  it("discards only the other account's rows", async () => {
    await setOfflineQueueOwner("user-a");
    await enqueueOffline("entries.start", startInput("A's work"), "temp-a");
    await setOfflineQueueOwner("user-b");
    await enqueueOffline("entries.start", startInput("B's work"), "temp-b");

    expect(await discardForeignQueued()).toBe(1);

    // B keeps its own queue, and can still send it.
    expect(getForeignCount()).toBe(0);
    expect(getPendingCount()).toBe(1);
    expect(await replay()).toEqual(["B's work"]);
  });

  it("leaves unowned rows alone — they are not somebody else's yet", async () => {
    await enqueueOffline("entries.start", startInput("unowned"), "temp-1");
    await setOfflineQueueOwner("user-a");
    // Adoption already claimed it, so there is nothing foreign to discard.
    expect(await discardForeignQueued()).toBe(0);
    expect(await getOfflineQueue().size()).toBe(1);
  });

  it("discards nothing when there is nothing to discard", async () => {
    await setOfflineQueueOwner("user-a");
    expect(await discardForeignQueued()).toBe(0);
  });
});

describe("discarding the queue of a deleted account", () => {
  beforeEach(() => {
    __resetOfflineQueueForTests();
    __resetOfflineQueueOwnerForTests();
  });

  it("drops the deleted account's rows and its unowned ones, never another account's", async () => {
    await setOfflineQueueOwner("user-b");
    await enqueueOffline("entries.start", startInput("B's work"), "temp-b");
    await sealOfflineQueueOwner();

    // Unowned: queued before A's session resolved on this launch.
    await enqueueOffline("entries.start", startInput("pre-resolution"), "temp-0");
    await setOfflineQueueOwner("user-a");
    await enqueueOffline("entries.start", startInput("A's work"), "temp-a");
    // `setOfflineQueueOwner` adopted the unowned row; put one back to prove an
    // unowned row at deletion time goes too.
    await getOfflineQueue().enqueue("entries.stop", {
      input: { end: "2026-08-21T10:00:00.000Z", originId: "tab-1" },
    });

    expect(await discardDeletedAccountQueue("user-a")).toBe(3);

    const rows = await getOfflineQueue().list();
    expect(rows.map((row) => row.owner)).toEqual(["user-b"]);
  });

  it("forgets the owner, so nothing later is stamped with the deleted account", async () => {
    await setOfflineQueueOwner("user-a");
    await discardDeletedAccountQueue("user-a");
    expect(getOfflineQueueOwner()).toBeNull();

    __resetOfflineQueueOwnerForTests();
    await enqueueOffline("entries.start", startInput("next person"), "temp-1");
    expect((await getOfflineQueue().list())[0].owner).toBeUndefined();
    expect(getPendingCount()).toBe(1);
  });
});
