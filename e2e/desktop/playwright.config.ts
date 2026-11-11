import { defineConfig } from "@playwright/test";

/*
 * The desktop harness: `pnpm test:e2e:desktop`.
 *
 * Separate from the browser suite (playwright.config.ts ignores this folder)
 * because it needs different servers and a different build: global-setup.ts
 * starts its own `mongod` and a production-mode API on high ports, and builds
 * the desktop export against that API plus a debug build of the shell with
 * the `e2e` cargo feature. Every spec launches that binary headless over
 * `app://-` — the same shell, scheme and export a release runs, plus the
 * control channel the specs drive it through (driver.ts), which no release
 * build has.
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
