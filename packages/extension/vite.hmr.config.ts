import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { crx, type ManifestV3Export } from "@crxjs/vite-plugin";
import { defineConfig } from "vite";
import { BUILD_TARGETS, RELEASE_VERSION } from "./manifest.config.ts";

import { buildHmrManifest, HMR_OUT_DIR } from "./hmr-manifest.ts";
import { pickHmrPort } from "./scripts/hmr-port.mjs";

const fromHere = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

// Separate from the release config: no dev-server code or permissions can
// accidentally enter Chrome Store or Firefox packages.
export default defineConfig(async ({ command, mode }) => {
  if (command !== "serve") throw new Error("HMR config is for development only. Use vite.config.ts to build releases.");
  if (mode !== "hosted" && mode !== "local-api") throw new Error("Use --mode hosted or --mode local-api for extension HMR.");
  const targetMode = mode === "local-api" ? "development" : "production";
  const target = BUILD_TARGETS[targetMode];
  // Sticky across restarts (gitignored `.cache/`): see pickHmrPort.
  const port = await pickHmrPort(fromHere(".cache/hmr-port"));
  const manifest = buildHmrManifest(port) as ManifestV3Export;
  return {
    plugins: [react(), crx({ manifest })],
    publicDir: "public",
    // HMR never writes into either standalone build directory.
    build: { outDir: HMR_OUT_DIR, emptyOutDir: true },
    server: {
      host: "127.0.0.1",
      port,
      strictPort: true,
      open: false,
      // Standalone build output must not trigger popup reloads either.
      watch: { ignored: ["**/dist/**", "**/dist-prod/**", "**/dist-firefox/**"] },
      cors: { origin: /^chrome-extension:\/\/[a-p]{32}$/ },
      hmr: { host: "127.0.0.1", port },
    },
    resolve: {
      // Follow shared source edits as well as popup edits, without a second
      // compiler watcher. Subpath exports still resolve through the packages.
      alias: [
        { find: /^@starter\/core$/, replacement: fromHere("../core/src/index.ts") },
        { find: /^@starter\/shared$/, replacement: fromHere("../shared/src/index.ts") },
      ],
      dedupe: ["react", "react-dom"],
    },
    define: {
      "import.meta.env.VITE_API_URL": JSON.stringify(process.env.VITE_API_URL ?? target.apiUrl),
      "import.meta.env.VITE_APP_VERSION": JSON.stringify(RELEASE_VERSION),
      "import.meta.env.VITE_BRIDGE_TARGET": JSON.stringify("development"),
    },
  };
});
