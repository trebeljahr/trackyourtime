import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants.js";
import type { NextConfig } from "next";

/**
 * The release every client build reports, from the ROOT package.json — the
 * single source of truth for the version (docs/versioning.md).
 *
 * Found by walking up from the working directory rather than by a fixed
 * relative path, because `next build` is run from `packages/client` by the
 * scripts and from elsewhere by hand. Throws when nothing is found: a bundle
 * that cannot say which version it is would send no handshake at all.
 */
function readRootVersion(): string {
  let dir = process.cwd();
  for (;;) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as {
        name?: unknown;
        version?: unknown;
      };
      if (parsed.name === "trackyourtime" && typeof parsed.version === "string") {
        return parsed.version;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error("[next.config] root package.json (name \"trackyourtime\") not found");
    }
    dir = parent;
  }
}

// Every host loads the export with root-absolute "/_next/…" asset paths, and
// there is deliberately no `assetPrefix`. The web serves it from a real
// origin; Capacitor's router resolves every asset from the bundle root; and
// Electron serves it from the privileged `app://-` scheme (electron/src/
// protocol.ts), which is a standard origin with a root. A relative "./" prefix
// was needed only while Electron loaded `index.html` off file://, and
// it was wrong everywhere else: under `trailingSlash: true` a document at
// /app/track/ resolves "./_next/…" to "/app/track/_next/…" and every chunk
// 404s. `scripts/build-mobile.mjs` and `scripts/build-desktop.mjs` both refuse
// an export whose HTML contains "./_next".
const isDev = process.env.NODE_ENV === "development";

// Next 16 blocks cross-origin requests to /_next dev resources by default.
// scripts/dev.mjs prints 127.0.0.1 URLs while Next treats localhost as its own
// origin, so without this the dev chunks are blocked, React never hydrates, and
// every form silently falls back to a native submit.
const devOrigins = ["127.0.0.1", "localhost", ...(process.env.NEXT_DEV_ORIGINS?.split(",").map((s) => s.trim()).filter(Boolean) ?? [])];

const baseConfig: NextConfig = {
  output: "export",
  // Inlined into every bundle: the web image, the phone apps and the desktop
  // shells. Read by `lib/app-version.ts`.
  env: { NEXT_PUBLIC_APP_VERSION: readRootVersion() },
  ...(isDev ? { allowedDevOrigins: devOrigins } : {}),
  trailingSlash: true,
  images: { unoptimized: true },
  transpilePackages: ["@starter/server", "@starter/shared", "@starter/core"],
  // scripts/dev.mjs gives each checkout its own build directory so that two
  // instances (a worktree and the main checkout, say) never share the .next
  // cache or the Next 16 dev-server lock.
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
};

/**
 * Import a module without letting Next's config bundler rewrite the call.
 *
 * Next compiles next.config.ts to CommonJS, which turns a literal `import()`
 * into `require()` — and `require()` of an ESM-only package throws
 * ERR_PACKAGE_PATH_NOT_EXPORTED. Building the function from a string keeps the
 * import opaque to the bundler, so it survives as a real dynamic import.
 */
const esmImport = new Function(
  "specifier",
  "return import(specifier);",
) as (specifier: string) => Promise<unknown>;

type LocalDevPlugin = {
  withLocalDev: (config: NextConfig, options: { slug: string }) => NextConfig;
};

/**
 * `@hatchkit/dev-plugin-next` is ESM-only and only does work during
 * `next dev` (it writes the project's Caddy fragment and prints the
 * Tailscale-URL banner), so it is loaded lazily in that phase alone. A
 * failure to load degrades to the plain config rather than breaking the
 * dev server or the build.
 */
export default async function config(phase: string): Promise<NextConfig> {
  if (phase !== PHASE_DEVELOPMENT_SERVER) return baseConfig;

  try {
    const plugin = (await esmImport(
      "@hatchkit/dev-plugin-next",
    )) as LocalDevPlugin;
    return plugin.withLocalDev(baseConfig, { slug: "trackyourtime" });
  } catch (err) {
    console.warn(
      "[next.config] @hatchkit/dev-plugin-next could not be loaded — " +
        "continuing without the local-dev integration.",
      err instanceof Error ? err.message : err,
    );
    return baseConfig;
  }
}
