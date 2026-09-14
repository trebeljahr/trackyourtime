import { STORE_EXTENSION_ID, STORE_EXTENSION_KEY } from "@starter/shared";
import { describe, expect, it } from "vitest";
import { buildManifest } from "../manifest.config";

describe("production manifest", () => {
  it("requires only the hosted API and offers any server as optional", () => {
    const manifest = buildManifest("production", {});
    expect(manifest.host_permissions).toEqual(["https://api.trackyourtime.dev/*"]);
    expect(manifest.optional_host_permissions).toEqual([
      "https://*/*",
      "http://localhost/*",
      "http://127.0.0.1/*",
    ]);
  });

  it("pins the Web Store key by default", () => {
    expect(buildManifest("production", {}).key).toBe(STORE_EXTENSION_KEY);
    // Sanity: the constant the servers trust is the one this key produces.
    expect(STORE_EXTENSION_ID).toMatch(/^[a-p]{32}$/);
  });

  it("lets EXTENSION_KEY override the store key", () => {
    expect(buildManifest("production", { EXTENSION_KEY: " fork-key " }).key).toBe(
      "fork-key",
    );
    expect(buildManifest("production", { EXTENSION_KEY: "  " }).key).toBe(
      STORE_EXTENSION_KEY,
    );
  });
});

describe("development manifest", () => {
  it("keeps a path-derived id: no key unless one is supplied", () => {
    expect(buildManifest("development", {})).not.toHaveProperty("key");
    expect(buildManifest("development", { EXTENSION_KEY: "k" }).key).toBe("k");
  });

  it("holds loopback and can ask for an https server", () => {
    const manifest = buildManifest("development", {});
    expect(manifest.host_permissions).toEqual([
      "http://localhost/*",
      "http://127.0.0.1/*",
    ]);
    expect(manifest.optional_host_permissions).toEqual(["https://*/*"]);
  });
});
