import { afterEach, expect, it, vi } from "vitest";
import { fetchAuthWithTimeout } from "./auth-request";
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it("aborts a stalled native auth request after twenty seconds", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new Error("aborted")));
  })));
  const result = expect(fetchAuthWithTimeout("https://example.test")).rejects.toThrow("aborted");
  await vi.advanceTimersByTimeAsync(20_000);
  await result;
  expect(vi.getTimerCount()).toBe(0);
});
it("preserves caller cancellation and removes the timeout on completion", async () => {
  vi.useFakeTimers();
  const caller = new AbortController();
  vi.stubGlobal("fetch", vi.fn((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new Error("cancelled")));
  })));
  const result = expect(fetchAuthWithTimeout("https://example.test", { signal: caller.signal })).rejects.toThrow("cancelled");
  caller.abort();
  await result;
  expect(vi.getTimerCount()).toBe(0);
});
it("clears its timer after a successful request", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
  expect((await fetchAuthWithTimeout("https://example.test")).ok).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
