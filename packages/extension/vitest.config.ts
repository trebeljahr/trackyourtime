import { defineConfig } from "vitest/config";

/**
 * Unit tests only, in Node.
 *
 * Nothing under test touches the DOM or a real `chrome.*` API: the modules
 * that decide things (the permission request, the server switch, the
 * manifest) take those APIs as arguments, so a test hands in a fake rather
 * than a browser.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
