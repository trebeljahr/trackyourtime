import { build } from "vite";
import { describe, expect, test } from "vitest";
import { bundleCheck } from "../bundle-check";

function buildFixture(source: string, external: string[] = []) {
  return build({
    configFile: false,
    logLevel: "silent",
    plugins: [
      {
        name: "fixture",
        resolveId: (id) => id === "fixture" ? "\0fixture" : undefined,
        load: (id) => id === "\0fixture" ? source : undefined,
      },
      bundleCheck(),
    ],
    build: {
      write: false,
      rollupOptions: { input: "fixture", external },
    },
  });
}

describe("extension bundle dependencies", () => {
  test("rejects the bare React import that leaves the popup blank", async () => {
    await expect(buildFixture('import { useState } from "react"; console.log(useState);', ["react"]))
      .rejects.toThrow('imports unbundled dependency "react"');
  });

  test("rejects external dynamic imports too", async () => {
    await expect(buildFixture('import("react").then(console.log);', ["react"]))
      .rejects.toThrow('imports unbundled dependency "react"');
  });

  test("accepts dependencies bundled into the extension", async () => {
    await expect(buildFixture('import { useState } from "react"; console.log(useState);'))
      .resolves.toBeDefined();
  });
});
