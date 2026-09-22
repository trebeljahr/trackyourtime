// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CHUNK_RELOAD_STORAGE_KEY,
  CHUNK_RELOAD_WINDOW_MS,
  isChunkLoadError,
  reloadOnceForChunkError,
  watchChunkErrors,
  type ReloadStorage,
} from "./chunk-reload";

const memory = (): ReloadStorage & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
};

describe("isChunkLoadError", () => {
  it("recognises webpack, turbopack and native dynamic import failures", () => {
    const named = new Error("whatever");
    named.name = "ChunkLoadError";
    expect(isChunkLoadError(named)).toBe(true);
    expect(isChunkLoadError(new Error("Loading chunk 123 failed.\n(error: /_next/static/chunks/123.js)"))).toBe(true);
    expect(isChunkLoadError(new Error("Loading CSS chunk app-layout failed"))).toBe(true);
    expect(isChunkLoadError(new Error("Failed to load chunk /_next/static/chunks/abc.js from module 42"))).toBe(true);
    expect(isChunkLoadError(new TypeError("Failed to fetch dynamically imported module: https://x/a.js"))).toBe(true);
    expect(isChunkLoadError(new TypeError("error loading dynamically imported module"))).toBe(true);
    expect(isChunkLoadError(new TypeError("Importing a module script failed."))).toBe(true);
    expect(isChunkLoadError("Loading chunk 7 failed")).toBe(true);
  });

  it("leaves every other error alone", () => {
    expect(isChunkLoadError(new Error("Cannot read properties of undefined"))).toBe(false);
    expect(isChunkLoadError(new TypeError("Failed to fetch"))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });
});

describe("reloadOnceForChunkError", () => {
  it("reloads the first time and records when", () => {
    const storage = memory();
    const reload = vi.fn();
    expect(reloadOnceForChunkError(reload, storage, 5_000_000)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(storage.data.get(CHUNK_RELOAD_STORAGE_KEY)).toBe("5000000");
  });

  it("refuses a second reload inside the window, so a broken server cannot loop", () => {
    const storage = memory();
    const reload = vi.fn();
    reloadOnceForChunkError(reload, storage, 5_000_000);
    expect(reloadOnceForChunkError(reload, storage, 5_000_000 + CHUNK_RELOAD_WINDOW_MS - 1)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("allows another reload after the window, for a later deploy", () => {
    const storage = memory();
    const reload = vi.fn();
    reloadOnceForChunkError(reload, storage, 5_000_000);
    expect(reloadOnceForChunkError(reload, storage, 5_000_000 + CHUNK_RELOAD_WINDOW_MS)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("does not reload without storage to guard the loop", () => {
    const reload = vi.fn();
    expect(reloadOnceForChunkError(reload, null, 1)).toBe(false);
    const throwing: ReloadStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(reloadOnceForChunkError(reload, throwing, 1)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("ignores a garbage stored value", () => {
    const storage = memory();
    storage.data.set(CHUNK_RELOAD_STORAGE_KEY, "nope");
    const reload = vi.fn();
    expect(reloadOnceForChunkError(reload, storage, 1_000)).toBe(true);
  });
});

describe("watchChunkErrors", () => {
  let stop: (() => void) | undefined;
  afterEach(() => stop?.());

  it("reacts to a rejected dynamic import and to an uncaught chunk error only", () => {
    const onChunkError = vi.fn();
    stop = watchChunkErrors(onChunkError);

    const rejection = new Event("unhandledrejection") as PromiseRejectionEvent;
    Object.defineProperty(rejection, "reason", {
      value: new TypeError("Failed to fetch dynamically imported module: /x.js"),
    });
    window.dispatchEvent(rejection);
    expect(onChunkError).toHaveBeenCalledTimes(1);

    const unrelated = new Event("unhandledrejection") as PromiseRejectionEvent;
    Object.defineProperty(unrelated, "reason", { value: new Error("boom") });
    window.dispatchEvent(unrelated);
    expect(onChunkError).toHaveBeenCalledTimes(1);

    // Message only: jsdom reports a dispatched ErrorEvent carrying `error` to
    // the test runner as an uncaught exception.
    const chunkEvent = (): ErrorEvent =>
      new ErrorEvent("error", { message: "Loading chunk 7 failed." });
    window.dispatchEvent(chunkEvent());
    expect(onChunkError).toHaveBeenCalledTimes(2);

    // The failure itself is handed over, so DeployRecovery can report the one
    // the reload guard refuses.
    expect(onChunkError.mock.calls[0]?.[0]).toBeInstanceOf(TypeError);
    expect(onChunkError.mock.calls[1]?.[0]).toBe("Loading chunk 7 failed.");

    stop();
    stop = undefined;
    window.dispatchEvent(chunkEvent());
    expect(onChunkError).toHaveBeenCalledTimes(2);
  });
});
