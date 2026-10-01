import { expect, test, vi } from "vitest";
import type { FakeEvent } from "../test/fake-chrome";
import { EXTENSION_RELAY_CHANNEL } from "@starter/shared/extension-relay";

test("popup listener refuses content scripts without racing the relay, but keeps extension tabs working", async () => {
  await import("./index");
  type Listener = (message: unknown, sender: chrome.runtime.MessageSender, reply: (value: unknown) => void) => boolean;
  const listener = (chrome.runtime.onMessage as unknown as FakeEvent<Listener>).listeners[0];
  const reply = vi.fn();
  const sender = { id: chrome.runtime.id, url: "https://trackyourtime.dev/app", frameId: 0, tab: { id: 1 } } as chrome.runtime.MessageSender;
  expect(listener({ type: "auth:sign-out" }, sender, reply)).toBe(false);
  expect(listener({ channel: EXTENSION_RELAY_CHANNEL }, sender, reply)).toBe(false);
  expect(reply).not.toHaveBeenCalled();
  const result = await new Promise((resolve) => {
    expect(listener({ type: "unknown" }, { ...sender, url: chrome.runtime.getURL("src/popup/index.html") }, resolve)).toBe(true);
  });
  expect(result).toMatchObject({ ok: false, code: "BAD_MESSAGE" });
});
