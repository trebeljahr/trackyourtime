import { afterEach, expect, test, vi } from "vitest";
import { extensionBridgeSyncRequest, extensionBridgeSyncReply } from "@starter/shared/extension-bridge";
import { sendThroughPageRelay } from "./extension-bridge-transport";

function harness(origin = "https://trackyourtime.dev", framed = false) {
  const listeners = new Set<(event: MessageEvent) => void>();
  const win = {
    location: { origin }, top: null as unknown, crypto: { randomUUID: () => "request-1234567890" }, postMessage: vi.fn(),
    addEventListener: (_: string, fn: (event: MessageEvent) => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: (event: MessageEvent) => void) => listeners.delete(fn),
  };
  win.top = framed ? {} : win;
  return { win: win as unknown as Window, post: win.postMessage, listeners, emit(data: unknown, source: unknown = win, from = origin) {
    for (const fn of listeners) fn({ data, source, origin: from } as MessageEvent);
  } };
}
const request = extensionBridgeSyncRequest("https://api.trackyourtime.dev", { userId: "u", sessionCreatedAt: 100 });
const reply = extensionBridgeSyncReply({ type: "none", reason: "linked" });
afterEach(() => vi.useRealTimers());

test("correlates decoded replies and removes listeners after success", async () => {
  const h = harness();
  const pending = sendThroughPageRelay(request, 100, h.win);
  const envelope = h.post.mock.calls[0][0];
  expect(h.post.mock.calls[0][1]).toBe("https://trackyourtime.dev");
  h.emit({ ...envelope, direction: "reply", payload: { ...reply, token: "discard" } });
  expect(await pending).toEqual(reply);
  expect(h.listeners.size).toBe(0);
});

test("ignores stale, cross-origin, framed, malformed and request messages", async () => {
  vi.useFakeTimers();
  const h = harness();
  const pending = sendThroughPageRelay(request, 100, h.win);
  const envelope = { ...h.post.mock.calls[0][0], direction: "reply", payload: reply };
  h.emit({ ...envelope, id: "stale-request-1234" });
  h.emit(envelope, {});
  h.emit(envelope, h.win, "https://evil.example");
  h.emit({ ...envelope, payload: { token: "secret" } });
  h.emit({ ...envelope, direction: "request" });
  expect(h.listeners.size).toBe(1);
  vi.advanceTimersByTime(100);
  expect(await pending).toBeUndefined();
  expect(h.listeners.size).toBe(0);
});

test.each([["https://evil.example", false], ["http://trackyourtime.dev", false], ["https://trackyourtime.dev", true]] as const)("refuses %s framed=%s", async (origin, framed) => {
  const h = harness(origin, framed);
  expect(await sendThroughPageRelay(request, 100, h.win)).toBeUndefined();
  expect(h.post).not.toHaveBeenCalled();
});

test("refuses unknown commands and recovers from postMessage failures", async () => {
  const h = harness();
  expect(await sendThroughPageRelay({ type: "GET_STATE" }, 100, h.win)).toBeUndefined();
  expect(h.post).not.toHaveBeenCalled();
  h.post.mockImplementation(() => { throw new Error("closed"); });
  expect(await sendThroughPageRelay(request, 100, h.win)).toBeUndefined();
  expect(h.listeners.size).toBe(0);
});

test("is inert during server rendering without window", async () => {
  expect(await sendThroughPageRelay(request)).toBeUndefined();
});
