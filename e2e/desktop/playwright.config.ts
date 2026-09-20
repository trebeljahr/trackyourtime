import { defineConfig } from "@playwright/test";

/*
 * The Electron harness: `pnpm test:e2e:desktop`.
 *
 * Separate from the browser suite (playwright.config.ts ignores this folder)
 * because it needs different servers and a different build: global-setup.ts
 * starts its own `mongod` and a production-mode API on high ports, builds the
 * desktop export against that API when the one on disk was built for another,
 * and every spec launches `electron/dist/main.js` over `app://-` — the same
 * main process, scheme and export a packaged build runs, minus the fuses
 * (which disable the inspector Playwright drives Electron through).
 *
 * On Linux CI it runs under `xvfb-run`.
 */
export default defineConfig({
  testDir: ".",
  testMatch: /\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  globalSetup: "./global-setup.ts",
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
