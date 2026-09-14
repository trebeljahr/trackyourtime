/**
 * Unit tests for `resolveSyncUrl` in @starter/core — the one rule the web app,
 * the browser extension and any future client all derive the sync socket's URL
 * from.
 *
 * Worth pinning because nothing else catches it. There is no E2E coverage of
 * the socket, and `connectSync` skips an unusable URL quietly rather than
 * throwing, so a wrong path here reaches production as "sync just doesn't
 * work" with every HTTP request still succeeding.
 *
 * The `/api` prefix in particular is load-bearing for the deployment: the
 * server mounts everything it owns at `/api`, so a socket outside it would
 * need its own proxy rule. See docs/deploy.md.
 */
import { describe, expect, it } from "vitest";
import { resolveSyncUrl } from "@starter/core";

describe("resolveSyncUrl", () => {
  it("puts the socket under /api so one proxy rule covers the server", () => {
    expect(resolveSyncUrl("https://api.trackyourtime.dev", "")).toBe(
      "wss://api.trackyourtime.dev/api/ws",
    );
  });

  it("upgrades https to wss and http to ws", () => {
    expect(resolveSyncUrl("https://example.test", "")).toBe(
      "wss://example.test/api/ws",
    );
    expect(resolveSyncUrl("http://localhost:5159", "")).toBe(
      "ws://localhost:5159/api/ws",
    );
  });

  it("falls back to the page origin when no API URL was built in", () => {
    expect(resolveSyncUrl("", "https://api.trackyourtime.dev")).toBe(
      "wss://api.trackyourtime.dev/api/ws",
    );
  });

  it("does not double the slash on a base that has a trailing one", () => {
    expect(resolveSyncUrl("https://example.test/", "")).toBe(
      "wss://example.test/api/ws",
    );
  });

  it("keeps a base path, so a proxied sub-path deployment still resolves", () => {
    expect(resolveSyncUrl("https://example.test/trackyourtime", "")).toBe(
      "wss://example.test/trackyourtime/api/ws",
    );
  });

  it("drops any query and hash rather than carrying them onto the socket", () => {
    expect(resolveSyncUrl("https://example.test/?a=1#b", "")).toBe(
      "wss://example.test/api/ws",
    );
  });

  it("returns empty when neither input parses, so callers can skip connecting", () => {
    expect(resolveSyncUrl("", "")).toBe("");
    expect(resolveSyncUrl("not-a-url", "")).toBe("");
  });

  it("ignores surrounding whitespace in a hand-typed preference", () => {
    expect(resolveSyncUrl("  https://example.test  ", "")).toBe(
      "wss://example.test/api/ws",
    );
  });
});
