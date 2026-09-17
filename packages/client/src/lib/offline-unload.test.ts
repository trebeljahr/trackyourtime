// @vitest-environment jsdom
/**
 * A mutation that fails because the document is being torn down.
 *
 * `isNetworkError()` cannot tell an aborted request from a failed one, and a
 * full page navigation aborts everything in flight. Queueing those for replay
 * is a guess that they never reached the server — and it is usually the wrong
 * guess, because the request was fully written before the document died. The
 * replay then creates a SECOND entry rather than recovering a lost one.
 *
 * This matters more now that the queue drains on every route: before, a row
 * queued on the way out of /track sat there until the user came back, so the
 * duplicate mostly did not happen by luck.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const isNative = vi.fn(() => false);
vi.mock("@/lib/shell", async () =>
  (await import("@/lib/shell-mock")).mockShellModule(() => (isNative() ? "capacitor" : "web")),
);

const {
  __resetDocumentUnloadForTests,
  isDocumentUnloading,
  watchDocumentUnload,
} = await import("@/lib/offline");

const pagehide = (persisted: boolean): void => {
  const event = new Event("pagehide") as Event & { persisted?: boolean };
  Object.defineProperty(event, "persisted", { value: persisted });
  window.dispatchEvent(event);
};

beforeEach(() => {
  __resetDocumentUnloadForTests();
  isNative.mockReturnValue(false);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("isDocumentUnloading", () => {
  it("is false until the page is actually going away", () => {
    watchDocumentUnload();
    expect(isDocumentUnloading()).toBe(false);
  });

  it("latches on a real teardown", () => {
    watchDocumentUnload();
    pagehide(false);
    expect(isDocumentUnloading()).toBe(true);
  });

  it("ignores a back-forward cache suspension", () => {
    watchDocumentUnload();
    pagehide(true);
    expect(isDocumentUnloading()).toBe(false);
  });

  it("clears again when a cached page is restored", () => {
    watchDocumentUnload();
    pagehide(false);
    window.dispatchEvent(new Event("pageshow"));
    expect(isDocumentUnloading()).toBe(false);
  });

  it("does not watch at all on native", () => {
    // A phone has no navigation teardown, and `pagehide` fires there for
    // backgrounding. A flag latched by that would silently stop the offline
    // queue on the one platform that exists for it.
    isNative.mockReturnValue(true);
    watchDocumentUnload();
    pagehide(false);
    expect(isDocumentUnloading()).toBe(false);
  });

  it("registers its listeners once", () => {
    const add = vi.spyOn(window, "addEventListener");
    watchDocumentUnload();
    watchDocumentUnload();
    watchDocumentUnload();
    expect(add).toHaveBeenCalledTimes(2);
    add.mockRestore();
  });
});
