import { buildManifest, type BuildEnv } from "./manifest.config";

export const HMR_OUT_DIR = "dist-hmr";

/** Development identity never inherits a release key or the selected backend. */
export function buildHmrManifest(port: number, env: BuildEnv = {}) {
  return {
    ...buildManifest("development", { ...env, EXTENSION_KEY: "" }),
    background: { service_worker: "src/background/index.ts", type: "module" },
    host_permissions: ["http://localhost/*", "http://127.0.0.1/*"],
    content_security_policy: {
      extension_pages: `script-src 'self' http://localhost:${port} http://127.0.0.1:${port}; object-src 'self';`,
    },
  };
}
