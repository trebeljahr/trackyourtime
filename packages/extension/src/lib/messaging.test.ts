import { afterEach, describe, expect, test, vi } from "vitest";
import { sendToBackground } from "./messaging";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("worker reply deadline", () => {
  test("a stalled read returns a retryable failure", async () => {
    vi.useFakeTimers();
    vi.spyOn(chrome.runtime, "sendMessage").mockImplementation(() => new Promise(() => {}));
    const pending = sendToBackground({ type: "state:get" });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await pending).toMatchObject({ ok: false, code: "NO_RESPONSE" });
    expect(vi.getTimerCount()).toBe(0);
  });

  test("a successful read clears its deadline", async () => {
    vi.useFakeTimers();
    const response = { ok: true, state: {} };
    vi.spyOn(chrome.runtime, "sendMessage").mockImplementation(() => Promise.resolve(response));
    expect(await sendToBackground({ type: "state:get" })).toEqual(response);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("does not time out mutations that may still be committing", async () => {
    vi.useFakeTimers();
    let finish!: (value: unknown) => void;
    vi.spyOn(chrome.runtime, "sendMessage").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = sendToBackground({ type: "timer:stop" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(vi.getTimerCount()).toBe(0);
    const response = { ok: true, state: {} };
    finish(response);
    expect(await pending).toEqual(response);
  });
});
