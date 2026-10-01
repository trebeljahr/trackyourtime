import { afterEach, expect, test, vi } from "vitest";
import { extensionBridgeSyncRequest, extensionBridgeSyncReply } from "@starter/shared/extension-bridge";
import { EXTENSION_RELAY_CHANNEL } from "@starter/shared/extension-relay";
import { installPageRelay } from "./relay";

function harness(origin = "https://trackyourtime.dev", framed = false) {
  const listeners = new Set<(event: MessageEvent) => void>();
  const win = {
    location: { origin }, top: null as unknown, postMessage: vi.fn(),
    addEventListener: (_: string, fn: (event: MessageEvent) => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: (event: MessageEvent) => void) => listeners.delete(fn),
  };
  win.top = framed ? {} : win;
  const runtime = { sendMessage: vi.fn(), lastError: undefined as unknown };
  const dispose = installPageRelay(win as unknown as Window, runtime as unknown as typeof chrome.runtime);
  const emit = (data: unknown, source: unknown = win, from = origin) => {
    for (const fn of listeners) fn({ data, source, origin: from } as MessageEvent);
  };
  return { win, runtime, emit, dispose, listeners };
}
const envelope = {
  channel: EXTENSION_RELAY_CHANNEL, direction: "request", id: "relay-request-1234",
  payload: extensionBridgeSyncRequest("https://api.trackyourtime.dev", { userId: "u", sessionCreatedAt: 100 }),
};
afterEach(() => vi.useRealTimers());

test("forwards only decoded fields and posts a decoded reply to the exact origin", () => {
  const h = harness();
  h.runtime.sendMessage.mockImplementation((_request, callback) => callback({ ...extensionBridgeSyncReply({ type: "none", reason: "linked" }), token: "must-not-leak" }));
  h.emit({ ...envelope, payload: { ...envelope.payload, password: "must-not-forward" } });
  expect(h.runtime.sendMessage.mock.calls[0][0]).toEqual(envelope);
  expect(h.win.postMessage).toHaveBeenCalledWith({ ...envelope, direction: "reply", payload: extensionBridgeSyncReply({ type: "none", reason: "linked" }) }, h.win.location.origin);
  h.dispose();
  expect(h.listeners.size).toBe(0);
});

test("ignores foreign windows, origins, directions and privileged popup commands", () => {
  const h = harness();
  h.emit(envelope, {});
  h.emit(envelope, h.win, "https://evil.example");
  h.emit({ ...envelope, direction: "reply" });
  h.emit({ ...envelope, payload: { type: "GET_STATE" } });
  h.emit(envelope.payload);
  expect(h.runtime.sendMessage).not.toHaveBeenCalled();
});

test.each([["https://evil.example", false], ["http://trackyourtime.dev", false], ["https://trackyourtime.dev", true]] as const)("does not install on %s framed=%s", (origin, framed) => {
  const h = harness(origin, framed);
  h.emit(envelope);
  expect(h.runtime.sendMessage).not.toHaveBeenCalled();
  expect(h.listeners.size).toBe(0);
});

test("bounds outstanding requests and recovers slots after missing replies", () => {
  vi.useFakeTimers();
  const h = harness();
  for (let i = 0; i < 20; i++) h.emit(envelope);
  expect(h.runtime.sendMessage).toHaveBeenCalledTimes(8);
  vi.advanceTimersByTime(5000);
  h.emit(envelope);
  expect(h.runtime.sendMessage).toHaveBeenCalledTimes(9);
  expect(h.win.postMessage).not.toHaveBeenCalled();
  vi.runAllTimers();
});

test("handles missing receivers and malformed replies without posting", () => {
  const h = harness();
  h.runtime.sendMessage.mockImplementation(() => { throw new Error("closed"); });
  expect(() => h.emit(envelope)).not.toThrow();
  h.runtime.sendMessage.mockImplementation((_request, callback) => callback({ token: "secret" }));
  h.emit(envelope);
  h.runtime.lastError = { message: "no receiver" };
  h.runtime.sendMessage.mockImplementation((_request, callback) => callback(extensionBridgeSyncReply({ type: "none", reason: "linked" })));
  h.emit(envelope);
  expect(h.win.postMessage).not.toHaveBeenCalled();
});
