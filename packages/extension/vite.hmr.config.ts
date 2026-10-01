import { randomInt } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { crx, type ManifestV3Export } from "@crxjs/vite-plugin";
import { defineConfig } from "vite";
import { BUILD_TARGETS, RELEASE_VERSION, buildManifest } from "./manifest.config";

const fromHere = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = randomInt(49152, 65536);
    const free = await new Promise<boolean>((resolve) => {
      const probe = createServer();
      probe.once("error", () => resolve(false));
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error("Could not find a free extension HMR port after three attempts.");
}

// Separate from the release config: no dev-server code or permissions can
// accidentally enter Chrome Store or Firefox packages.
export default defineConfig(async ({ command, mode }) => {
  if (command !== "serve") throw new Error("HMR config is for development only. Use vite.config.ts to build releases.");
  if (mode !== "hosted" && mode !== "local-api") throw new Error("Use --mode hosted or --mode local-api for extension HMR.");
  const targetMode = mode === "local-api" ? "development" : "production";
  const target = BUILD_TARGETS[targetMode];
  const manifest = {
    ...buildManifest(targetMode),
    background: { service_worker: "src/background/index.ts", type: "module" },
  } as ManifestV3Export;
  const port = await freePort();
  return {
    plugins: [react(), crx({ manifest })],
    publicDir: "public",
    // Keep using the already-installed unpacked path and extension identity.
    build: { outDir: target.outDir, emptyOutDir: true },
    server: {
      host: "127.0.0.1",
      port,
      strictPort: true,
      open: false,
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
      "import.meta.env.VITE_BRIDGE_TARGET": JSON.stringify(target.bridgeTarget),
    },
  };
});
