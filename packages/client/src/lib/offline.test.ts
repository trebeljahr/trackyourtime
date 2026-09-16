/**
 * Tests for the browser-bound half of the client's offline plumbing: the
 * localStorage-backed queue wrapper, the reactive pending count, and the
 * network-vs-server error classification that decides whether an optimistic
 * update survives or rolls back. The pure op contract it builds on is covered
 * by core-offline-ops.test.ts.
 *
 * Everything is imported through "./offline", so these also pin the module's
 * public surface after the contract moved into @starter/core.
 */
import { TRPCClientError } from "@trpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelQueuedForTemp,
  clearOfflineQueue,
  enqueueOffline,
  flushOfflineQueue,
  getOfflineQueue,
  getHeldCount,
  getPendingCount,
  hasReplayableRows,
  getServerPendingCount,
  isNetworkError,
  isOnline,
  isPermanentServerRejection,
  isTransientServerError,
  refreshPendingCount,
  setOfflineQueueOwner,
  subscribePending,
  type OfflineMutation,
  type OfflineStartInput,
} from "./offline";

const startInput: OfflineStartInput = {
  description: "Wrote tests",
  projectId: "p1",
  taskId: null,
  billable: true,
  start: "2026-08-21T09:00:00.000Z",
  source: "web",
      timeZone: "Europe/Berlin",
  originId: "tab-1",
};

describe("the client queue", () => {
  beforeEach(async () => {
    await clearOfflineQueue();
    // A flush replays only the signed-in account's rows, so these need an
    // account. Ownership itself is covered by offline-owner.test.ts.
    await setOfflineQueueOwner("user-1");
  });

  it("tracks the pending count as mutations are queued and flushed", async () => {
    expect(getPendingCount()).toBe(0);
    expect(getServerPendingCount()).toBe(0);

    await enqueueOffline("entries.start", startInput, "temp-1");
    await enqueueOffline("entries.stop", { end: "…", originId: "tab-1" });
    expect(getPendingCount()).toBe(2);
    expect(await refreshPendingCount()).toBe(2);

    const replayed: OfflineMutation[] = [];
    const result = await flushOfflineQueue(async (mutation) => {
      replayed.push(mutation);
    });

    expect(replayed.map((mutation) => mutation.op)).toEqual([
      "entries.start",
      "entries.stop",
    ]);
    expect(replayed[0].input).toEqual(startInput);
    expect(result).toEqual({ flushed: 2, skipped: 0, held: 0, remaining: 0 });
    expect(getPendingCount()).toBe(0);
  });

  it("notifies subscribers when the pending count changes", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribePending(listener);

    await enqueueOffline("entries.start", startInput);
    expect(listener).toHaveBeenCalled();

    unsubscribe();
    listener.mockClear();
    await clearOfflineQueue();
    expect(listener).not.toHaveBeenCalled();
  });

  it("keeps the remainder queued when a replay fails", async () => {
    await enqueueOffline("entries.start", startInput, "temp-1");
    await enqueueOffline("entries.stop", { end: "…", originId: "tab-1" });

    const result = await flushOfflineQueue(async (mutation) => {
      if (mutation.op === "entries.start") throw new Error("still offline");
    });

    expect(result.flushed).toBe(0);
    expect(result.remaining).toBe(2);
    expect(getPendingCount()).toBe(2);
  });

  it("holds a row this build cannot read: never replayed, never dropped", async () => {
    await getOfflineQueue().enqueue("entries.frobnicate", { input: {} });
    await refreshPendingCount();
    expect(getPendingCount()).toBe(0);
    expect(getHeldCount()).toBe(1);

    const replayed: string[] = [];
    const result = await flushOfflineQueue(async (mutation) => {
      replayed.push(mutation.op);
    }, { retryHeld: true });

    expect(replayed).toEqual([]);
    expect(result.flushed).toBe(0);
    expect(await getOfflineQueue().size()).toBe(1);
    expect(getPendingCount()).toBe(0);
    expect(getHeldCount()).toBe(1);
    expect(await hasReplayableRows({ retryHeld: true })).toBe(false);
  });

  it("cancels everything queued for a temp entry", async () => {
    await enqueueOffline("entries.start", startInput, "temp-1");
    await enqueueOffline("entries.stop", { end: "…", originId: "tab-1" }, "temp-1");
    await enqueueOffline("entries.stop", { end: "…", originId: "tab-1" }, "temp-2");

    expect(await cancelQueuedForTemp("temp-1")).toBe(true);
    expect(getPendingCount()).toBe(1);

    expect(await cancelQueuedForTemp("temp-3")).toBe(false);
    expect(getPendingCount()).toBe(1);
  });
});

describe("isNetworkError", () => {
  it("assumes we are online in a non-browser host", () => {
    expect(isOnline()).toBe(true);
  });

  it("treats transport failures as retryable", () => {
    expect(isNetworkError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isNetworkError(new Error("fetch failed"))).toBe(true);
    expect(isNetworkError(new Error("NetworkError when attempting to fetch"))).toBe(
      true
    );
    expect(isNetworkError(new Error("Load failed"))).toBe(true);
    expect(isNetworkError("connection refused")).toBe(true);
  });

  it("follows the cause chain", () => {
    const wrapped = new Error("mutation failed", {
      cause: new Error("socket hang up"),
    });
    expect(isNetworkError(wrapped)).toBe(true);
  });

  it("never retries a rejection that came from the server", () => {
    const rejected = Object.assign(new Error("Failed to fetch"), {
      data: { code: "BAD_REQUEST" },
    });
    expect(isNetworkError(rejected)).toBe(false);
  });

  it("does not treat an ordinary error as a network error", () => {
    expect(isNetworkError(new Error("Entry not found"))).toBe(false);
    expect(isNetworkError(null)).toBe(false);
    expect(isNetworkError(undefined)).toBe(false);
    expect(isNetworkError({ nope: true })).toBe(false);
  });
});

describe("which server answers may drop a queued row", () => {
  const answered = (code: string, httpStatus?: number) =>
    Object.assign(new Error(code), { data: { code, httpStatus } });

  it("drops only on the permanent set shared with @starter/core", () => {
    for (const [code, status] of [
      ["BAD_REQUEST", 400],
      ["FORBIDDEN", 403],
      ["NOT_FOUND", 404],
      ["CONFLICT", 409],
      ["UNPROCESSABLE_CONTENT", 422],
    ] as const) {
      expect(isPermanentServerRejection(answered(code, status)), code).toBe(true);
      expect(isTransientServerError(answered(code, status)), code).toBe(false);
    }
  });

  it("keeps a row the server failed to answer about", () => {
    for (const [code, status] of [
      ["INTERNAL_SERVER_ERROR", 500],
      ["TOO_MANY_REQUESTS", 429],
      ["SERVICE_UNAVAILABLE", 503],
      ["TIMEOUT", 408],
      ["BAD_GATEWAY", 502],
    ] as const) {
      expect(isPermanentServerRejection(answered(code, status)), code).toBe(false);
      expect(isTransientServerError(answered(code, status)), code).toBe(true);
    }
  });

  it("reads the status from the code when the error carries none", () => {
    expect(isPermanentServerRejection(answered("FORBIDDEN"))).toBe(true);
    expect(isTransientServerError(answered("INTERNAL_SERVER_ERROR"))).toBe(true);
  });

  it("keeps a row when the response was not a tRPC answer at all", () => {
    const html = new TRPCClientError("Unexpected token '<', \"<html>\" is not valid JSON");
    expect(isPermanentServerRejection(html)).toBe(false);
    expect(isTransientServerError(html)).toBe(true);
  });

  it("leaves errors that never came from a response to the flush's other rules", () => {
    expect(isTransientServerError(new Error("local bug"))).toBe(false);
    expect(isTransientServerError(null)).toBe(false);
  });
});
