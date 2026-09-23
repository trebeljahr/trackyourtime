import { STORE_EXTENSION_ID, STORE_EXTENSION_KEY } from "@starter/shared";
import { describe, expect, it } from "vitest";
import {
  BUILD_TARGETS,
  GECKO_SETTINGS,
  RELEASE_VERSION,
  buildManifest,
  manifestVersionFields,
} from "../manifest.config";

/** What the store listing may ask for, and nothing more, in every build. */
const expectNoHostAccess = (manifest: Record<string, unknown>): void => {
  expect(manifest).not.toHaveProperty("host_permissions");
  expect(manifest).not.toHaveProperty("optional_host_permissions");
  expect(manifest.permissions).toEqual(["storage", "alarms", "idle"]);
  expect(manifest.permissions).not.toContain("cookies");
  expect(manifest.optional_permissions).toEqual(["tabs"]);
};

describe("production manifest", () => {
  it("asks for no host access and no cookies", () => {
    expectNoHostAccess(buildManifest("production", {}));
  });

  it("lets only the hosted web app message the extension", () => {
    expect(buildManifest("production", {}).externally_connectable).toEqual({
      matches: ["https://trackyourtime.dev/*"],
    });
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

  it("asks for no host access and no cookies", () => {
    expectNoHostAccess(buildManifest("development", {}));
  });

  it("lets a local web app on any port message the extension, and no other extension", () => {
    const connectable = buildManifest("development", {}).externally_connectable;
    expect(connectable).toEqual({
      matches: ["http://localhost/*", "http://127.0.0.1/*"],
    });
    expect(connectable).not.toHaveProperty("ids");
  });
});

describe("firefox manifest", () => {
  const manifest = buildManifest("firefox", {});

  it("asks for no host access and no cookies, like every other build", () => {
    expectNoHostAccess(manifest);
  });

  it("runs an event page, not a service worker", () => {
    // Gecko has no `service_worker` key. A manifest carrying one loads with no
    // background at all — every listener unregistered, and an extension whose
    // popup opens and does nothing.
    expect(manifest.background).toEqual({
      scripts: ["background.js"],
      type: "module",
    });
  });

  it("carries the gecko id and the versions AMO needs", () => {
    expect(manifest.browser_specific_settings).toEqual({ gecko: GECKO_SETTINGS });
    // Permanent once listed: AMO keys the listing and Firefox keys the
    // profile's stored data on it.
    expect(GECKO_SETTINGS.id).toBe("trackyourtime@ricoslabs.com");
    // data_collection_permissions is only read from 140 on, and AMO requires
    // it on a new submission.
    expect(GECKO_SETTINGS.strict_min_version).toBe("140.0");
    expect(GECKO_SETTINGS.data_collection_permissions.required).toContain(
      "authenticationInfo",
    );
  });

  it("carries no Chromium-only keys", () => {
    // `key` pins an id on Chromium and means nothing here; EXTENSION_KEY must
    // not smuggle one in either, since AMO reviews the manifest it is sent.
    expect(manifest).not.toHaveProperty("key");
    expect(buildManifest("firefox", { EXTENSION_KEY: "fork-key" })).not.toHaveProperty(
      "key",
    );
    expect(manifest).not.toHaveProperty("minimum_chrome_version");
  });

  it("has no bridge: Firefox does not connect web pages to extensions", () => {
    // The key is omitted rather than written empty — AMO reads an unknown or
    // empty key as a mistake, and an empty match list is not a narrower
    // bridge, it is no bridge.
    expect(manifest).not.toHaveProperty("externally_connectable");
  });

  it("points at the hosted API, like the production build", () => {
    // Not asserted from the manifest (the URL is a vite define), but the two
    // targets must not drift: a Firefox build pointed at localhost would ship
    // to AMO talking to nothing.
    expect(BUILD_TARGETS.firefox.apiUrl).toBe(BUILD_TARGETS.production.apiUrl);
    expect(BUILD_TARGETS.firefox.outDir).toBe("dist-firefox");
    expect(BUILD_TARGETS.firefox.bridgeTarget).toBe("none");
  });
});

describe("manifest version", () => {
  it("comes from the root package.json, the version the release tag names", async () => {
    const root = (await import("../../../package.json")).default as {
      version: string;
    };
    expect(RELEASE_VERSION).toBe(root.version);
    expect(buildManifest("production", {}).version).toBe(
      manifestVersionFields(root.version).version,
    );
  });

  it("keeps a plain release as the version alone", () => {
    expect(manifestVersionFields("1.2.3")).toEqual({ version: "1.2.3" });
  });

  it("splits a prerelease into a Chrome version and a version_name", () => {
    expect(manifestVersionFields("0.2.0-rc.1")).toEqual({
      version: "0.2.0",
      version_name: "0.2.0-rc.1",
    });
  });

  it("refuses a version Chrome cannot read", () => {
    expect(() => manifestVersionFields("v1.2.3")).toThrow(/Chrome version/);
    expect(() => manifestVersionFields("1.2.3.4.5")).toThrow(/Chrome version/);
  });
});
