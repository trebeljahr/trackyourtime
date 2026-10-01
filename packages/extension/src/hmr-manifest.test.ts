import { describe, expect, it } from "vitest";
import { buildHmrManifest, HMR_OUT_DIR } from "../hmr-manifest";
import { BUILD_TARGETS, buildManifest } from "../manifest.config";

describe("isolated HMR extension", () => {
  it("never inherits a production key, even from the environment", () => {
    const manifest = buildHmrManifest(54321, { EXTENSION_KEY: "production-key" });
    expect(manifest).not.toHaveProperty("key");
    expect(manifest).toHaveProperty("name", "__MSG_extNameDev__");
    expect(manifest).toHaveProperty("icons.32", "icons/dev/32.png");
    expect(buildManifest("production", {})).toHaveProperty("icons.32", "icons/32.png");
    expect(manifest).toHaveProperty("externally_connectable", { matches: ["http://localhost/*", "http://127.0.0.1/*"] });
    expect(manifest.host_permissions).toContain("https://api.trackyourtime.dev/*");
  });
  it("keeps its loader outside every standalone build directory", () => {
    for (const target of Object.values(BUILD_TARGETS)) expect(HMR_OUT_DIR).not.toBe(target.outDir);
    expect(buildHmrManifest(54321).background.service_worker).toBe("src/background/index.ts");
    expect(buildManifest("production", {}).background).toEqual({ service_worker: "background.js", type: "module" });
  });
});
