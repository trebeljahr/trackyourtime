import { describe, expect, it } from "vitest";
import { createOfflineQueue, memoryStorage } from "@starter/core";

import { isAuthError, isForbiddenError, isNetworkError } from "@/lib/offline";

/**
 * An expired or revoked session must stop the flush, not empty it.
 *
 * The queue drops any mutation the runner does not rethrow for, because "the
 * server refused it" normally means the server is right. A 401 is the one
 * refusal that says nothing about the mutation — and on a phone, where the
 * queue now survives OS kills and the app deliberately stays inside on a
 * failed session check, it is the refusal every queued row would hit at once.
 */

const trpcError = (code: string): Error =>
  Object.assign(new Error(code), { data: { code } });

describe("isAuthError", () => {
  it("recognises the code an unauthenticated tRPC call returns", () => {
    expect(isAuthError(trpcError("UNAUTHORIZED"))).toBe(true);
  });

  it("does not treat FORBIDDEN as a lapsed session", () => {
    // In a shared workspace FORBIDDEN is a valid session refused one row — a
    // role change. Calling it an auth error halted the whole flush behind that
    // row and told a signed-in person to sign in.
    expect(isAuthError(trpcError("FORBIDDEN"))).toBe(false);
    expect(isForbiddenError(trpcError("FORBIDDEN"))).toBe(true);
    expect(isForbiddenError(trpcError("UNAUTHORIZED"))).toBe(false);
  });

  it("leaves every other server refusal alone", () => {
    expect(isAuthError(trpcError("BAD_REQUEST"))).toBe(false);
    expect(isAuthError(trpcError("NOT_FOUND"))).toBe(false);
    expect(isAuthError(trpcError("CONFLICT"))).toBe(false);
  });

  it("is not confused by a plain transport failure", () => {
    expect(isAuthError(new TypeError("Failed to fetch"))).toBe(false);
    expect(isAuthError(null)).toBe(false);
    expect(isAuthError("UNAUTHORIZED")).toBe(false);
  });

  it("is disjoint from isNetworkError", () => {
    // They are handled the same way at the flush — both stop it — but for
    // different reasons, and nothing should ever match both.
    const unauthorized = trpcError("UNAUTHORIZED");
    expect(isAuthError(unauthorized)).toBe(true);
    expect(isNetworkError(unauthorized)).toBe(false);
  });
});

describe("a flush that hits an expired session", () => {
  const seed = async () => {
    const queue = createOfflineQueue({
      storage: memoryStorage(),
      key: "test.queue",
    });
    await queue.enqueue("entries.start", { input: { description: "one" } });
    await queue.enqueue("entries.stop", { input: {} });
    await queue.enqueue("entries.start", { input: { description: "two" } });
    return queue;
  };

  it("keeps every row when the runner rethrows", async () => {
    const queue = await seed();

    const result = await queue.flush(async () => {
      throw trpcError("UNAUTHORIZED");
    });

    expect(result.flushed).toBe(0);
    expect(await queue.size()).toBe(3);
  });

  it("keeps the rows behind the one that failed, in order", async () => {
    const queue = await seed();
    let seen = 0;

    await queue.flush(async () => {
      seen += 1;
      if (seen === 2) throw trpcError("UNAUTHORIZED");
    });

    const remaining = await queue.list();
    expect(remaining.map((row) => row.op)).toEqual([
      "entries.stop",
      "entries.start",
    ]);
  });

  it("still drops a row the server refused on the merits", async () => {
    // The contrast that makes the auth case a deliberate exception rather
    // than a blanket "never drop anything".
    const queue = await seed();

    await queue.flush(async () => {
      // The real runner swallows this rather than rethrowing.
      const error = trpcError("BAD_REQUEST");
      if (isAuthError(error) || isNetworkError(error)) throw error;
    });

    expect(await queue.size()).toBe(0);
  });
});
