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

// Relative asset paths are required only by the shells that load the exported
// client off a file:// document, where there is no server and no root to be
// absolute from: Electron (`build:desktop`, `electron:build`,
// `electron:preview`) and Tauri (`build:tauri`). Those four — and only those
// four — set RELATIVE_ASSET_PREFIX=1. The flag is named for what it does
// rather than for one of its consumers, because `build:tauri` setting a
// variable called ELECTRON_BUILD reads like a copy-paste slip and invites a
// deletion that silently blanks the Tauri window.
//
// Capacitor is deliberately NOT in that list. CapacitorRouter.route(for:)
// (node_modules/@capacitor/ios/Capacitor/Capacitor/Router.swift) resolves every
// asset from the bundle root: it returns `basePath + "/index.html"` when the
// path has no extension and `basePath + path` otherwise. So with
// `trailingSlash: true`, a chunk requested as "./_next/…" from a document at
// /track/ resolves to "/track/_next/…", which has an extension, and the router
// looks for a file that does not exist — a blank screen behind a splash
// `launchAutoHide: false` never hides. Root-absolute "/_next/…" is correct
// there, and is what the web build already uses.
//
// Relative paths are WRONG for the web build for the same reason: a page
// served at /track/ would resolve "./_next/..." to "/track/_next/..." and every
// asset 404s. So the prefix is opt-in and never applied to `next dev` or to a
// web production build.
const isDev = process.env.NODE_ENV === "development";
const useRelativeAssetPrefix = process.env.RELATIVE_ASSET_PREFIX === "1";

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
  ...(useRelativeAssetPrefix && !isDev ? { assetPrefix: "./" } : {}),
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
