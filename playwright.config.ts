import { defineConfig, devices } from "@playwright/test";

// High ports by default: 3001/5006 collide with whatever else is running on a
// developer machine, and this suite starts its own servers.
const E2E_SERVER_PORT = process.env.E2E_SERVER_PORT ?? "49761";
const E2E_CLIENT_PORT = process.env.E2E_CLIENT_PORT ?? "49762";

export default defineConfig({
  testDir: "./e2e",
  // e2e/desktop/ drives Electron with its own config, servers and build
  // (`pnpm test:e2e:desktop`); none of it belongs to a browser project.
  testIgnore: /[\\/]desktop[\\/]/,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "html",
  use: {
    baseURL: `http://127.0.0.1:${E2E_CLIENT_PORT}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: "bash e2e/start-server.sh",
      url: `http://127.0.0.1:${E2E_SERVER_PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      env: {
        NODE_ENV: "test",
        E2E_DISABLE_AUTH_RATE_LIMIT: "1",
        PORT: E2E_SERVER_PORT,
        MONGODB_URI:
          process.env.MONGODB_URI ??
          "mongodb://127.0.0.1:27018/trackyourtime-e2e",
        REDIS_URL: process.env.REDIS_URL ?? "redis://127.0.0.1:6380",
        BETTER_AUTH_SECRET: "e2e-test-secret",
        BETTER_AUTH_URL: `http://127.0.0.1:${E2E_SERVER_PORT}`,
        FRONTEND_URL: `http://127.0.0.1:${E2E_CLIENT_PORT}`,
      },
    },
    {
      // Build the static export and serve it, rather than running `next dev`.
      // Next 16's dev server detaches itself, which fights Playwright's process
      // management and left the client port dead partway through a run. This
      // also exercises the artifact that actually ships to web, desktop and
      // mobile — NEXT_PUBLIC_API_URL is baked in at build time, so it has to be
      // set for the build command, not just the server.
      command: `pnpm run build:client && node e2e/serve-static.mjs`,
      url: `http://127.0.0.1:${E2E_CLIENT_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 300_000,
      env: {
        PORT: E2E_CLIENT_PORT,
        E2E_CLIENT_PORT,
        NEXT_PUBLIC_API_URL: `http://127.0.0.1:${E2E_SERVER_PORT}`,
        NEXT_PUBLIC_WS_URL: `ws://127.0.0.1:${E2E_SERVER_PORT}`,
      },
    },
  ],
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
      // The phone-layout spec belongs to the project below; without this it
      // would also run here at desktop width, where its whole premise (that
      // a 390pt browser still gets the web treatment) is untestable.
      //
      // The desktop pattern is repeated from the top level on purpose: a
      // project's `testIgnore` REPLACES the config's rather than adding to
      // it, so naming only the phone spec here put every `e2e/desktop/` spec
      // back into this project — where they fail on the first fetch, because
      // their servers are started by the other config's global setup.
      testIgnore: [/[\\/]desktop[\\/]/, /mobile-shell\.spec\.ts/],
    },
    {
      // Shared mobile UX on the same export as desktop/native. Chromium is
      // installed in CI; native safe areas retain their own platform markers.
      name: "phone",
      use: { ...devices["Pixel 5"] },
      testMatch: /mobile-shell\.spec\.ts/,
    },
  ],
});
