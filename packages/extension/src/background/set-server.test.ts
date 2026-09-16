/**
 * `config:set-server` through the worker's own message listener: a server
 * below this build's API floor is refused before anything changes.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { MIN_SERVER_API_LEVEL } from "@starter/core";
import { loadApiUrl } from "../lib/config";
import type { BackgroundResponse } from "../lib/messaging";
import type { FakeEvent } from "../test/fake-chrome";

type MessageEvent = FakeEvent<
  (message: unknown, sender: unknown, respond: (response: unknown) => void) => boolean
>;

const health = (apiLevel: number): Response =>
  new Response(
    JSON.stringify({
      status: "ok",
      service: "trackyourtime",
      db: true,
      webUrl: "https://old.example.com",
      release: "0.0.9",
      apiLevel,
    }),
    { status: 200 },
  );

let serverLevel = 0;

beforeEach(() => {
  serverLevel = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (new URL(url).pathname === "/api/health") return health(serverLevel);
      throw new TypeError("fetch failed");
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Deliver one popup message the way Chrome would, and wait for the reply. */
const send = (message: unknown): Promise<BackgroundResponse> =>
  new Promise((resolve) => {
    (chrome.runtime.onMessage as unknown as MessageEvent).emit(message, {}, (response) =>
      resolve(response as BackgroundResponse),
    );
  });

test("a server below the API floor is refused, and the extension stays where it was", async () => {
  // Registers the listeners on this test's fake `chrome`.
  await import("./index");
  const before = await loadApiUrl();

  const response = await send({
    type: "config:set-server",
    origin: "https://old.example.com",
    discardUnsent: false,
  });

  expect(response).toMatchObject({
    ok: false,
    code: "SERVER_TOO_OLD",
    details: { apiLevel: 0, release: "0.0.9", minApiLevel: MIN_SERVER_API_LEVEL },
  });
  if (!response.ok) expect(response.message).toContain("old.example.com");
  expect(await loadApiUrl()).toBe(before);
});
