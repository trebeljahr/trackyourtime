import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Node 26 defines `localStorage` and `sessionStorage` as globals of its own,
 * and leaves them `undefined` unless the process was started with
 * `--localstorage-file`. Their mere presence is what breaks the jsdom tests:
 * vitest's jsdom environment copies a window key onto the global only when the
 * key is NOT already there (`getWindowKeys`, which keeps an existing global for
 * anything outside its own `KEYS` list, and that list has `Storage` but not
 * `localStorage`). So jsdom's real Storage was never published and every
 * `window.localStorage` read answered `undefined`.
 *
 * Turning Node's own Web Storage off hands both globals back to jsdom, which
 * has them: the document's origin is `http://localhost:3000` (vitest's default
 * `jsdom.url`), not an opaque one. Node 24 — what `.nvmrc` pins and CI runs —
 * does not define them at all and accepts the flag as a no-op, so both versions
 * end up with jsdom's Storage and nothing here is version-specific.
 *
 * It goes on NODE_OPTIONS rather than `poolOptions.*.execArgv`, which vitest 4
 * replaces with an argv of its own, and it is APPENDED so that a NODE_OPTIONS
 * the developer already exports (`--max-old-space-size`) survives. Setting it
 * here rather than in the `test` script covers `npx vitest`, watch mode and
 * editor runners too; the pool's worker processes inherit it when they spawn.
 */
const DISABLE_NODE_WEB_STORAGE = "--no-experimental-webstorage";
if (!(process.env.NODE_OPTIONS ?? "").includes(DISABLE_NODE_WEB_STORAGE)) {
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} ${DISABLE_NODE_WEB_STORAGE}`.trim();
}

/**
 * Vitest needs the same "@/" alias the app and tsconfig use. Without it any
 * test that pulls in a module importing "@/..." fails to resolve, which
 * limited unit tests to alias-free files.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
