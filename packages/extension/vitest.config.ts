import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const fromHere = (relative: string): string =>
  fileURLToPath(new URL(relative, import.meta.url));

/**
 * Unit tests for the worker and popup modules, in Node.
 *
 * `chrome` does not exist here, so `src/test/setup.ts` installs the in-memory
 * fake from `src/test/fake-chrome.ts` before every test, and `fake-indexeddb`
 * provides the IndexedDB activity capture stores into.
 *
 * `@starter/core` resolves to its SOURCE rather than its `dist`: the tests then
 * run against the code in the working tree without a build step first, which
 * is the mistake that would otherwise make a green run describe stale output.
 */
export default defineConfig({
  define: {
    // A port nothing listens on: a test that forgets to stub `fetch` fails
    // fast instead of reaching a real server.
    "import.meta.env.VITE_API_URL": JSON.stringify("http://127.0.0.1:9"),
    "import.meta.env.VITE_APP_VERSION": JSON.stringify("9.8.7"),
  },
  resolve: {
    alias: [
      {
        find: /^@starter\/core\/(.+)$/,
        replacement: `${fromHere("../core/src")}/$1.ts`,
      },
      { find: /^@starter\/core$/, replacement: fromHere("../core/src/index.ts") },
    ],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: ["src/test/setup.ts"],
  },
});
