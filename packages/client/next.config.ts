import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants.js";
import type { NextConfig } from "next";

/**
 * The self-contained pdfkit build for the browser.
 *
 * `@starter/invoice-pdf` renders the invoice PDF, and it runs in the browser on
 * the public invoice generator (`/invoice-generator/`), loaded through a
 * dynamic `import()` on the first "Download PDF" click. pdfkit's default entry
 * pulls in Node builtins (`fs`, `zlib`, `Buffer`); its standalone bundle ships
 * its own Buffer/zlib/font support and needs no Node externals (see the
 * package README). `pdfkit.standalone.js` is not in pdfkit's `exports` map, so
 * the alias points at the resolved file rather than the package specifier,
 * which bypasses the exports gate. Resolve the package's own entry (its `.`
 * export IS in the map) and swap the filename, since the standalone build sits
 * beside it in `js/`. The alias is on the client bundle only; the server
 * imports the real pdfkit through its own build.
 *
 * The two bundlers want the target in different forms. webpack takes the
 * absolute path. Turbopack `resolveAlias` treats an absolute path as a request
 * relative to the project root (it prepends "./", so "/Users/…" 404s), so it
 * gets a request relative to that root instead. The root is the pnpm
 * workspace root, where `node_modules/.pnpm` lives — it has to be, because
 * Turbopack refuses to compile files outside the root, and the standalone
 * bundle sits under the store. Pinning it also silences Next's inferred-root
 * warning.
 */
const clientDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = findWorkspaceRoot(clientDir);
const pdfkitEntry = createRequire(import.meta.url).resolve("pdfkit");
const pdfkitStandalone = join(dirname(pdfkitEntry), "pdfkit.standalone.js");
const pdfkitStandaloneRequest = `./${relative(workspaceRoot, pdfkitStandalone).split(sep).join("/")}`;
// Turbopack resolves an aliased RELATIVE request from the importing package
// (`packages/client`), not from `turbopack.root`, so the workspace-root form
// above misses. pdfkit is a direct dependency of the client too, so its
// standalone build is reachable through the client's own `node_modules`
// symlink — a path that resolves from `packages/client`.
const pdfkitStandaloneClientRequest = `./${relative(clientDir, join(clientDir, "node_modules", "pdfkit", "js", "pdfkit.standalone.js")).split(sep).join("/")}`;

/** The pnpm workspace root: the nearest ancestor with a `pnpm-workspace.yaml`. */
function findWorkspaceRoot(from: string): string {
  let dir = from;
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return from;
    dir = parent;
  }
}

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
  env: {
    NEXT_PUBLIC_APP_VERSION: readRootVersion(),
    // Defined even when unset. The bundler inlines only the NEXT_PUBLIC_*
    // variables that exist at build time; an unset one stays a runtime
    // `process.env` lookup, and `lib/error-reporting/reporter.ts` keeps the
    // SDK import behind `NEXT_PUBLIC_SENTRY_DSN ? import(…) : …`. Only a
    // literal "" folds that to its false branch and drops the SDK chunk from
    // the export — measured: never fetched either way, but ~430 KB in every
    // web image, phone bundle and desktop package until it was a literal.
    NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN ?? "",
  },
  ...(isDev ? { allowedDevOrigins: devOrigins } : {}),
  trailingSlash: true,
  images: { unoptimized: true },
  transpilePackages: ["@starter/server", "@starter/shared", "@starter/core"],
  // The invoice generator renders PDFs in the browser with pdfkit; point every
  // `pdfkit` import at its self-contained standalone build. Both bundlers are
  // configured because `next build` uses Turbopack by default and `--webpack`
  // switches to webpack.
  // `pdfkit-standalone` is a dedicated specifier the invoice generator page
  // imports directly (`invoice-generator-page.tsx`). Aliasing the bare `pdfkit`
  // alone is not enough: it does not reach the `import "pdfkit"` inside the
  // pre-built `@starter/invoice-pdf` dist (not a transpiled package), so that
  // path loads pdfkit's Node build, which cannot register its standard fonts in
  // a browser. The page therefore imports `pdfkit-standalone` — app source that
  // IS bundled here — and hands the constructor to the renderer. The made-up
  // specifier also sidesteps pdfkit's `exports` map, which blocks the real
  // `pdfkit/js/pdfkit.standalone.js` subpath.
  turbopack: {
    root: workspaceRoot,
    resolveAlias: {
      pdfkit: pdfkitStandaloneRequest,
      "pdfkit-standalone": pdfkitStandaloneClientRequest,
    },
  },
  webpack: (webpackConfig) => {
    webpackConfig.resolve ??= {};
    webpackConfig.resolve.alias = {
      ...(webpackConfig.resolve.alias as Record<string, string> | undefined),
      pdfkit: pdfkitStandalone,
      "pdfkit-standalone": pdfkitStandalone,
    };
    return webpackConfig;
  },
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
