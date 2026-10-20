import { defineConfig } from "@playwright/test";

/*
 * Checks the static client export in packages/client/out — the files the
 * Cloudflare Worker serves — on its own, with no API server behind it.
 * Build it first:
 *
 *   NEXT_PUBLIC_API_URL=http://127.0.0.1:49761 pnpm run build:client
 *   pnpm test:e2e:export
 *
 * CI runs this in build-client on the exact export it uploads.
 *
 * Without E2E_EXPORT_PORT a random high port is picked, so a local run
 * never collides with a dev server. Workers inherit the variable.
 */
process.env.E2E_EXPORT_PORT ??= String(49152 + Math.floor(Math.random() * 16000));
const port = process.env.E2E_EXPORT_PORT;

export default defineConfig({
  testDir: "./e2e/export",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "on-first-retry",
  },
  webServer: {
    command: "node e2e/serve-static.mjs",
    url: `http://127.0.0.1:${port}/`,
    env: { PORT: port },
    reuseExistingServer: false,
    timeout: 10_000,
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
});
