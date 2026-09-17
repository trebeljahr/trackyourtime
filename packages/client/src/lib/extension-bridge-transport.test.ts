import { afterEach, describe, expect, it, vi } from "vitest";
import { STORE_EXTENSION_ID } from "@starter/shared";

import { chromeRuntime, extensionIds, sendToExtension } from "./extension-bridge-transport";

const DEV_ID = "abcdefghijklmnopabcdefghijklmnop";

type Callback = (response: unknown) => void;

const runtimeThat = (
  behave: (id: string, message: unknown, callback: Callback, runtime: { lastError?: unknown }) => void,
): { sendMessage: (id: string, message: unknown, callback: Callback) => void; lastError?: unknown } => {
  const runtime: {
    sendMessage: (id: string, message: unknown, callback: Callback) => void;
    lastError?: unknown;
  } = {
    sendMessage: (id, message, callback) => behave(id, message, callback, runtime),
  };
  return runtime;
};

afterEach(() => {
  vi.useRealTimers();
});

describe("chromeRuntime", () => {
  it("is null without chrome, without runtime, or without sendMessage", () => {
    expect(chromeRuntime({})).toBeNull();
    expect(chromeRuntime({ chrome: {} })).toBeNull();
    expect(chromeRuntime({ chrome: { runtime: {} } })).toBeNull();
    expect(chromeRuntime(null)).toBeNull();
  });

  it("returns a runtime that can send", () => {
    const runtime = { sendMessage: () => undefined };
    expect(chromeRuntime({ chrome: { runtime } })).toBe(runtime);
  });
});

describe("sendToExtension", () => {
  it("resolves the reply", async () => {
    const runtime = runtimeThat((_id, message, callback) => callback({ echo: message }));
    await expect(sendToExtension(DEV_ID, "hi", 1000, runtime)).resolves.toEqual({ echo: "hi" });
  });

  it("resolves undefined when Chrome sets lastError", async () => {
    const runtime = runtimeThat((_id, _message, callback, self) => {
      self.lastError = { message: "Could not establish connection." };
      callback(undefined);
    });
    await expect(sendToExtension(DEV_ID, "hi", 1000, runtime)).resolves.toBeUndefined();
  });

  it("resolves undefined when the call throws", async () => {
    const runtime = runtimeThat(() => {
      throw new Error("Invocation of form runtime.sendMessage doesn't match definition");
    });
    await expect(sendToExtension(DEV_ID, "hi", 1000, runtime)).resolves.toBeUndefined();
  });

  it("resolves undefined after the timeout, and ignores a late reply", async () => {
    vi.useFakeTimers();
    let late: Callback | null = null;
    const runtime = runtimeThat((_id, _message, callback) => {
      late = callback;
    });
    const pending = sendToExtension(DEV_ID, "hi", 5000, runtime);
    vi.advanceTimersByTime(5000);
    await expect(pending).resolves.toBeUndefined();
    (late as Callback | null)?.({ too: "late" });
  });

  it("never calls Chrome for an id that is not an extension id, or without a runtime", async () => {
    const sendMessage = vi.fn();
    await expect(sendToExtension("not-an-id", "hi", 1000, { sendMessage })).resolves.toBeUndefined();
    expect(sendMessage).not.toHaveBeenCalled();
    await expect(sendToExtension(DEV_ID, "hi", 1000, null)).resolves.toBeUndefined();
  });
});

describe("extensionIds", () => {
  it("defaults to the store id", () => {
    expect(extensionIds(undefined)).toEqual([STORE_EXTENSION_ID]);
    expect(extensionIds("  ")).toEqual([STORE_EXTENSION_ID]);
  });

  it("reads a comma-separated list, trimmed and deduplicated", () => {
    expect(extensionIds(` ${DEV_ID}, ${STORE_EXTENSION_ID},${DEV_ID}`)).toEqual([
      DEV_ID,
      STORE_EXTENSION_ID,
    ]);
  });

  it("drops anything that is not a Chrome extension id", () => {
    expect(extensionIds(`${DEV_ID},ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP,short,qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq`)).toEqual([
      DEV_ID,
    ]);
    expect(extensionIds("nonsense")).toEqual([]);
  });
});
