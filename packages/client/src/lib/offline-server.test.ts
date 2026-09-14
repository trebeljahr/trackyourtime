/**
 * The phone apps can be pointed at another server, and the offline queue
 * survives that on purpose — its rows are time no server has received. So
 * every row is stamped with the server it was queued against, and these pin
 * the client-side rules: replay, pending counts, adoption, cancelling and
 * deleting all stay on the server a row was made for. The pure queue half is
 * in packages/core/src/tests/offline-queue-server.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const CLOUD = "https://api.trackyourtime.dev";
const OWN = "https://track.example.com";

const server = { current: CLOUD };

vi.mock("@/lib/api-origin", () => ({
  getAbsoluteApiOrigin: () => server.current,
  getDefaultAbsoluteApiOrigin: () => CLOUD,
  whenApiOriginReady: async () => undefined,
}));

const {
  __resetOfflineQueueForTests,
  __resetOfflineQueueOwnerForTests,
  cancelQueuedForTemp,
  discardDeletedAccountQueue,
  discardForeignQueued,
  enqueueOffline,
  flushOfflineQueue,
  getForeignCount,
  getOfflineQueue,
  getPendingCount,
  listForeignQueued,
  refreshPendingCount,
  sealOfflineQueueOwner,
  setOfflineQueueOwner,
} = await import("./offline");

const start = (description: string) => ({
  description,
  projectId: null,
  taskId: null,
  billable: true,
  start: "2026-09-12T09:00:00.000Z",
  source: "mobile" as const,
  timeZone: "Europe/Berlin",
  originId: "tab-1",
});

const replay = async (): Promise<string[]> => {
  const seen: string[] = [];
  await flushOfflineQueue(async (mutation) => {
    seen.push((mutation.input as { description?: string }).description ?? mutation.op);
  });
  return seen;
};

/** Leave one server for another, the way `switchServer` does. */
const moveTo = async (origin: string, account: string): Promise<void> => {
  await sealOfflineQueueOwner();
  server.current = origin;
  await setOfflineQueueOwner(account);
};

beforeEach(() => {
  server.current = CLOUD;
  __resetOfflineQueueForTests();
  __resetOfflineQueueOwnerForTests();
});

describe("offline rows and the server they were queued on", () => {
  it("stamps every row with the server in use", async () => {
    await setOfflineQueueOwner("cloud-user");
    await enqueueOffline("entries.start", start("On the cloud"), "temp-1");
    const rows = await getOfflineQueue().list();
    expect(rows.map((row) => row.server)).toEqual([CLOUD]);
  });

  it("does not replay a row into a server it was not queued on", async () => {
    await setOfflineQueueOwner("cloud-user");
    await enqueueOffline("entries.start", start("On the cloud"), "temp-1");

    await moveTo(OWN, "own-user");
    await enqueueOffline("entries.start", start("On my server"), "temp-2");

    expect(await replay()).toEqual(["On my server"]);
    // The cloud row is still there, and counted as somebody else's work.
    const rows = await getOfflineQueue().list();
    expect(rows.map((row) => row.server)).toEqual([CLOUD]);
    expect(getPendingCount()).toBe(0);
    expect(getForeignCount()).toBe(1);
  });

  it("replays the row once the device is back on its server", async () => {
    await setOfflineQueueOwner("cloud-user");
    await enqueueOffline("entries.start", start("On the cloud"), "temp-1");
    await moveTo(OWN, "own-user");
    expect(await replay()).toEqual([]);

    await moveTo(CLOUD, "cloud-user");
    expect(await replay()).toEqual(["On the cloud"]);
    expect(await getOfflineQueue().size()).toBe(0);
  });

  it("counts another server's rows as foreign even before a session resolves", async () => {
    await setOfflineQueueOwner("cloud-user");
    await enqueueOffline("entries.start", start("On the cloud"), "temp-1");
    await sealOfflineQueueOwner();
    server.current = OWN;

    await refreshPendingCount();
    expect(getPendingCount()).toBe(0);
    expect(getForeignCount()).toBe(1);
  });

  it("treats a row from before the stamp as the default server's", async () => {
    // Written by a build that predates server stamping: no `server` at all.
    await getOfflineQueue().enqueue("entries.start", { input: start("Legacy"), tempId: "t" }, "cloud-user");

    server.current = OWN;
    await setOfflineQueueOwner("own-user");
    expect(await replay()).toEqual([]);
    const listed = await listForeignQueued();
    expect(listed.map((row) => row.otherServer)).toEqual([CLOUD]);

    await moveTo(CLOUD, "cloud-user");
    expect(await replay()).toEqual(["Legacy"]);
  });

  it("lists another server's rows with that server, another account's without", async () => {
    await setOfflineQueueOwner("cloud-user");
    await enqueueOffline("entries.start", start("Cloud, me"), "temp-1");
    await sealOfflineQueueOwner();
    await setOfflineQueueOwner("cloud-other");
    await enqueueOffline("entries.start", start("Cloud, other"), "temp-2");
    await moveTo(OWN, "own-user");

    const listed = await listForeignQueued();
    expect(listed.map((row) => [row.description, row.otherServer])).toEqual([
      ["Cloud, me", CLOUD],
      ["Cloud, other", CLOUD],
    ]);

    server.current = CLOUD;
    await setOfflineQueueOwner("cloud-other");
    const fromCloud = await listForeignQueued();
    expect(fromCloud.map((row) => [row.description, row.otherServer])).toEqual([
      ["Cloud, me", null],
    ]);
  });

  it("does not let an account adopt an unowned row from another server", async () => {
    await getOfflineQueue().enqueue("entries.start", { input: start("Unowned") }, undefined, CLOUD);
    server.current = OWN;
    await setOfflineQueueOwner("own-user");
    const rows = await getOfflineQueue().list();
    expect(rows[0]?.owner).toBeUndefined();
  });

  it("never cancels or deletes a row on another server", async () => {
    await setOfflineQueueOwner("same-id");
    await enqueueOffline("entries.start", start("Cloud"), "temp-1");
    // An account on the other server that happens to share nothing but luck.
    await moveTo(OWN, "same-id");

    expect(await cancelQueuedForTemp("temp-1")).toBe(false);
    expect(await discardDeletedAccountQueue("same-id")).toBe(0);
    expect(await getOfflineQueue().size()).toBe(1);
  });

  it("discards only the rows it was handed", async () => {
    await setOfflineQueueOwner("cloud-user");
    await enqueueOffline("entries.start", start("One"), "temp-1");
    await enqueueOffline("entries.start", start("Two"), "temp-2");
    await moveTo(OWN, "own-user");

    const [first] = await listForeignQueued();
    expect(await discardForeignQueued([first!.queueId])).toBe(1);
    const left = await getOfflineQueue().list();
    expect(left).toHaveLength(1);
  });
});
