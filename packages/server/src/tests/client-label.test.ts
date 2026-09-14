import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CLIENT_HEADER,
  DEVICE_FLOW_CLIENT_IDS,
  clientKindFromHeaders,
  describeClient,
  normalizeClientKind,
} from "../auth/client-label.js";

describe("normalizeClientKind", () => {
  it("accepts the known client kinds verbatim", () => {
    assert.equal(normalizeClientKind("raycast"), "raycast");
    assert.equal(normalizeClientKind("web"), "web");
    assert.equal(normalizeClientKind("extension"), "extension");
  });

  it("maps device-flow client ids onto their kind", () => {
    assert.equal(normalizeClientKind("trackyourtime-raycast"), "raycast");
    assert.equal(normalizeClientKind("trackyourtime-cli"), "cli");
  });

  it("is case- and whitespace-insensitive", () => {
    assert.equal(normalizeClientKind("  RayCast "), "raycast");
  });

  it("falls back to unknown for anything else", () => {
    assert.equal(normalizeClientKind("definitely-not-a-client"), "unknown");
    assert.equal(normalizeClientKind(undefined), "unknown");
    assert.equal(normalizeClientKind(42), "unknown");
    assert.equal(normalizeClientKind(null), "unknown");
  });
});

describe("clientKindFromHeaders", () => {
  it("reads the client header", () => {
    const headers = new Headers({ [CLIENT_HEADER]: "trackyourtime-cli" });
    assert.equal(clientKindFromHeaders(headers), "cli");
  });

  it("returns unknown for missing headers", () => {
    assert.equal(clientKindFromHeaders(new Headers()), "unknown");
    assert.equal(clientKindFromHeaders(null), "unknown");
    assert.equal(clientKindFromHeaders(undefined), "unknown");
  });
});

describe("describeClient", () => {
  const CHROME_MAC =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
  const SAFARI_IOS =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
    "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

  it("names a browser session by browser and platform", () => {
    assert.equal(describeClient("web", CHROME_MAC), "Chrome on macOS");
    assert.equal(describeClient("web", SAFARI_IOS), "Safari on iOS");
  });

  it("does not mistake Chrome for Safari, or Edge for Chrome", () => {
    const edge = `${CHROME_MAC} Edg/126.0.0.0`;
    assert.equal(describeClient("web", edge), "Edge on macOS");
  });

  it("prefers the self-declared client over the user agent", () => {
    assert.equal(describeClient("raycast", CHROME_MAC), "Raycast on macOS");
    assert.equal(describeClient("cli", null), "Command line");
  });

  it("degrades gracefully with no user agent at all", () => {
    assert.equal(describeClient("unknown", null), "Unknown client");
  });
});

describe("DEVICE_FLOW_CLIENT_IDS", () => {
  it("is the allowlist the device flow validates against", () => {
    // Guards the validateClient callback in auth.ts: an unlisted client id
    // must not be able to start a pairing flow.
    assert.ok(Object.hasOwn(DEVICE_FLOW_CLIENT_IDS, "trackyourtime-raycast"));
    assert.ok(!Object.hasOwn(DEVICE_FLOW_CLIENT_IDS, "attacker-app"));
  });
});
