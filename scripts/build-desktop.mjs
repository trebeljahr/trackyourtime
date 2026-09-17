#!/usr/bin/env node
/*
 * Build the Electron app: the desktop static export, the bundled main and
 * preload, and — with --package — the electron-builder output. One script, so
 * no half of it can be run against the wrong other half.
 *
 *   NEXT_PUBLIC_API_URL=http://localhost:51590 node scripts/build-desktop.mjs
 *   node scripts/build-desktop.mjs --electron-only        # bundle main/preload only
 *   node scripts/build-desktop.mjs --package --dir        # + unpacked app (electron:preview)
 *   node scripts/build-desktop.mjs --package --mac zip    # + anything electron-builder takes
 *   node scripts/build-desktop.mjs --channel mac --package --mac dmg zip --arm64 --x64
 *   node scripts/build-desktop.mjs --reuse-export --channel mas --package --mac mas --universal
 *
 * `--channel <mac|mas|win|win-store|linux>` is how a release is built (the
 * workflow always passes it): the signing secrets for that channel are
 * checked first, and a partial set refuses (scripts/lib/desktop-release.mjs).
 * Without --channel every package is unsigned and named -unsigned.
 * `--reuse-export` packages the export already in out-desktop instead of
 * building it again (its target API is printed from .build-target.json).
 *
 * Why each check exists:
 *
 *   1. Its own export directory, `packages/client/out-desktop`. `out/` is
 *      written by the web build and by Playwright, which bakes a throwaway
 *      127.0.0.1 API port — packaging whatever sits there ships an app bound
 *      to a dead port. The mobile build learned this first (`out-mobile`).
 *
 *   2. `NEXT_PUBLIC_API_URL` is required and searched for in the emitted
 *      chunks. It is baked in at build time; unset, every request resolves
 *      against `app://-` and the build stays green.
 *
 *   3. No emitted HTML may reference "./_next". The app is served from the
 *      privileged app:// scheme, which has a root; a relative asset prefix
 *      breaks every route but `/` (it did, under file://, in the Stage 0 spike).
 *
 *   4. A dev server of this checkout owns `packages/client/.next`, which a
 *      production export also builds in (with `output: "export"` a custom
 *      distDir only moves the export). Building beside it corrupts one of them.
 *
 *   5. After packaging, the asar is listed and must contain only the bundle,
 *      the export and package.json — in particular no `@capacitor/*`, which
 *      the root `dependencies` would otherwise pull in.
 *
 *   6. After packaging, the version inside every asar (and every .app's
 *      Info.plist on macOS) must be the root package.json's, and on a tag run
 *      the tag must be v<that version>. A release named 0.2.0 that reports
 *      0.1.0 would never be offered its own update.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { build as esbuild } from "esbuild";

import { ensureElectron } from "./ensure-electron.mjs";
import { builderEnvFor, masEntitlementsPlist, resolveSigning, tagMismatch } from "./lib/desktop-release.mjs";
import { describeChildFailure } from "./lib/child-failure.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const require = createRequire(join(repoRoot, "package.json"));

export const DESKTOP_OUT_DIR = "out-desktop";
const outPath = resolve(repoRoot, "packages/client", DESKTOP_OUT_DIR);
const electronDist = resolve(repoRoot, "electron/dist");

const args = process.argv.slice(2);
const packageIndex = args.indexOf("--package");
const shouldPackage = packageIndex !== -1;
const ownArgs = shouldPackage ? args.slice(0, packageIndex) : args;
const builderArgs = shouldPackage ? args.slice(packageIndex + 1) : [];
const electronOnly = ownArgs.includes("--electron-only");
const reuseExport = ownArgs.includes("--reuse-export");
const channelIndex = ownArgs.indexOf("--channel");
const channel = channelIndex === -1 ? null : ownArgs[channelIndex + 1];
if (channelIndex !== -1 && (!channel || channel.startsWith("--"))) {
  // Checked before anything is built: a typo here must not cost an export.
  console.error("\n  build:desktop — --channel needs a value: mac, mas, win, win-store or linux.\n");
  process.exit(1);
}
const rootVersion = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;

function fail(message) {
  console.error(`\n  build:desktop — ${message}\n`);
  process.exit(1);
}

function step(message) {
  console.log(`\n  ${message}`);
}

function run(command, cmdArgs, env = {}, baseEnv = process.env) {
  const result = spawnSync(command, cmdArgs, {
    cwd: repoRoot,
    stdio: ["inherit", "inherit", "pipe"],
    encoding: "utf8",
    env: { ...baseEnv, ...env },
    shell: process.platform === "win32",
  });
  const stderr = result.stderr ?? "";
  if (stderr !== "") process.stderr.write(stderr);
  if (result.error || result.status !== 0) {
    fail(
      describeChildFailure({
        command,
        args: cmdArgs,
        status: result.status,
        signal: result.signal,
        stderr: `${stderr}${result.error ? result.error.message : ""}`,
      }),
    );
  }
}

function walk(dir, predicate, hits = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, predicate, hits);
    else if (predicate(full)) hits.push(full);
  }
  return hits;
}

// ── 0. Release preflight ─────────────────────────────────────────────

let signing = null;
if (shouldPackage) {
  const mismatch = tagMismatch({ refType: process.env.GITHUB_REF_TYPE, refName: process.env.GITHUB_REF_NAME, version: rootVersion });
  if (mismatch) fail(mismatch);
  if (channel) {
    try {
      signing = resolveSigning(channel, process.env);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
    step(`Channel ${channel}: ${signing.mode}${signing.set ? ` (${signing.set.join(", ")})` : ""}`);
  } else {
    signing = { mode: "unsigned" };
  }
}

// ── 1. Export ────────────────────────────────────────────────────────

if (reuseExport && !electronOnly) {
  const target = join(outPath, ".build-target.json");
  if (!existsSync(target)) fail(`--reuse-export: no earlier export in ${outPath} (no .build-target.json).`);
  step(`Reusing the export in ${relative(repoRoot, outPath)} (built against ${JSON.parse(readFileSync(target, "utf8")).apiUrl})`);
}

if (!electronOnly && !reuseExport) {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL?.trim();
  if (!apiUrl) {
    fail(
      "NEXT_PUBLIC_API_URL is not set.\n" +
        "  It is baked into the bundle at build time — unset, the app resolves every\n" +
        "  request against app://- and fails with a green build.\n\n" +
        "  Local, in a worktree (see CLAUDE.md):\n" +
        "    API_PORT=51591 PORT=33921 pnpm run dev\n" +
        "    NEXT_PUBLIC_API_URL=http://localhost:51591 pnpm electron:preview",
    );
  }
  let apiOrigin;
  try {
    apiOrigin = new URL(apiUrl);
  } catch {
    fail(`NEXT_PUBLIC_API_URL is not a valid URL: ${apiUrl}`);
  }
  if (apiOrigin.pathname !== "/" || apiOrigin.search || apiOrigin.hash) {
    fail(
      `NEXT_PUBLIC_API_URL must be an origin with no path — got ${apiUrl}.\n` +
        "  The clients append /api/trpc, /api/auth and /api/ws themselves.",
    );
  }

  step("Preflight");
  const devLock = resolve(repoRoot, "packages/client/.next/dev/lock");
  if (existsSync(devLock)) {
    let pid = NaN;
    try {
      pid = Number(JSON.parse(readFileSync(devLock, "utf8"))?.pid);
    } catch {
      pid = NaN;
    }
    let running = false;
    if (Number.isFinite(pid)) {
      try {
        process.kill(pid, 0);
        running = true;
      } catch {
        running = false; // stale lock
      }
    }
    if (running) {
      fail(
        `A Next dev server for this checkout is running (PID ${pid}) and owns\n` +
          "  packages/client/.next, which this build also needs.\n\n" +
          `  Stop it:                 kill ${pid}\n` +
          "  Or give dev its own:     INSTANCE_ID=<name> pnpm run dev",
      );
    }
  }
  console.log("    no dev server owns packages/client/.next");

  step(`Building the desktop export against ${apiUrl}`);
  // Stale files from an earlier export would survive into the package.
  rmSync(outPath, { recursive: true, force: true });
  run("pnpm", ["build:client"], {
    // Set, never inherited: scripts/dev.mjs exports a per-worktree
    // NEXT_DIST_DIR, which would put this export somewhere else entirely.
    NEXT_DIST_DIR: DESKTOP_OUT_DIR,
    NEXT_PUBLIC_API_URL: apiUrl,
  });

  step("Verifying the export");
  for (const required of ["index.html", "404.html", "app/track/index.html"]) {
    if (!existsSync(join(outPath, required))) {
      fail(`No ${required} in ${outPath} — the export did not land where expected.`);
    }
  }
  const htmlFiles = walk(outPath, (f) => f.endsWith(".html"));
  const relativeRefs = htmlFiles.filter((f) => readFileSync(f, "utf8").includes('"./_next'));
  if (relativeRefs.length) {
    fail(
      'Emitted HTML references "./_next". app://- has a root, and a relative prefix\n' +
        "  404s every chunk on every route but /. Did an assetPrefix get into next.config.ts?\n" +
        relativeRefs
          .slice(0, 5)
          .map((f) => `    ${f}`)
          .join("\n"),
    );
  }
  console.log(`    ${htmlFiles.length} HTML files, all root-absolute`);

  const chunkDir = join(outPath, "_next/static/chunks");
  const chunks = existsSync(chunkDir) ? walk(chunkDir, (f) => f.endsWith(".js")) : [];
  if (!chunks.some((f) => readFileSync(f, "utf8").includes(apiUrl))) {
    fail(
      `The literal ${apiUrl} does not appear in any emitted chunk.\n` +
        "  NEXT_PUBLIC_API_URL did not reach the client bundle.",
    );
  }
  console.log(`    ${apiUrl} is baked into the bundle`);

  writeFileSync(
    join(outPath, ".build-target.json"),
    `${JSON.stringify({ apiUrl, builtAt: new Date().toISOString() }, null, 2)}\n`,
  );
}

// ── 2. Main and preload ──────────────────────────────────────────────

step("Bundling electron/src → electron/dist");
rmSync(electronDist, { recursive: true, force: true });
const electronVersion = JSON.parse(readFileSync(require.resolve("electron/package.json"), "utf8")).version;
const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  // Electron 42 ships Node 24.
  target: "node24",
  external: ["electron"],
  sourcemap: false,
  logLevel: "warning",
  absWorkingDir: repoRoot,
};
await esbuild({ ...common, entryPoints: ["electron/src/main.ts"], outfile: "electron/dist/main.js" });
// The preload runs sandboxed, where `require` knows only Electron's renderer
// modules — so everything else has to be inlined, and it is.
await esbuild({ ...common, entryPoints: ["electron/src/preload.ts"], outfile: "electron/dist/preload.js" });
// The tray icons (scripts/icons-brand.mjs) sit beside the bundle, where
// electron/src/desktop.ts looks for them in both a packaged and an unpackaged run.
const trayIcons = resolve(repoRoot, "electron/assets/tray");
if (!existsSync(join(trayIcons, "trayTemplate.png"))) {
  fail("No tray icons in electron/assets/tray. Run: pnpm icons:brand");
}
cpSync(trayIcons, join(electronDist, "tray"), { recursive: true });
console.log(`    electron/dist/main.js, electron/dist/preload.js, electron/dist/tray/ (Electron ${electronVersion})`);

// ── 3. Package ───────────────────────────────────────────────────────

if (shouldPackage) {
  if (electronOnly) fail("--package needs the export; drop --electron-only.");

  // electron-builder downloads its own Electron zip, but the harness and
  // dev:desktop run node_modules/electron — make sure it is really there.
  ensureElectron();

  const icons = process.platform === "win32" ? ["build/icon.ico"] : process.platform === "darwin" ? ["build/icon.icns"] : [];
  if (icons.some((icon) => !existsSync(resolve(repoRoot, icon)))) {
    step("Generating desktop icons (build/icon.png → icns/ico)");
    run("pnpm", ["icons:desktop"]);
  }

  // The Mac App Store entitlements name the team, so they are written per
  // build. Written for every package (electron-builder reads them only for
  // mas), so the config never points at a file that is not there.
  const generated = resolve(repoRoot, "build/generated");
  mkdirSync(generated, { recursive: true });
  writeFileSync(
    join(generated, "entitlements.mas.plist"),
    masEntitlementsPlist({ teamId: process.env.APPLE_TEAM_ID ?? "", appId: "com.trebeljahr.trackyourtime" }),
  );

  step(`electron-builder ${builderArgs.join(" ")}`.trim());
  // Without a channel, and for any unsigned channel, keychain identity
  // discovery is off: otherwise electron-builder finds a local "Developer ID
  // Application" identity on its own and signs even a --dir build, which is
  // slow and differs per machine. Signing only ever comes from a channel's
  // complete secret set.
  const builderEnv = builderEnvFor(channel ?? "local", process.env, signing);
  // release/ keeps whatever earlier runs left (another channel's unpacked
  // app, an old dmg). Only what this run wrote is checked: a stale folder
  // must neither pass for this build nor fail it.
  const packagedSince = Date.now() - 2000;
  run("pnpm", ["exec", "electron-builder", "--config", "electron-builder.config.mjs", "--publish", "never", ...builderArgs], {}, builderEnv);

  step("Verifying the asar");
  const releaseDir = resolve(repoRoot, "release");
  const fresh = (file) => statSync(file).mtimeMs >= packagedSince;
  const asars = existsSync(releaseDir) ? walk(releaseDir, (f) => f.endsWith(`${sep}app.asar`) && fresh(f)) : [];
  if (!asars.length) fail(`No app.asar written under ${releaseDir} by this run.`);
  const asarLib = createRequire(require.resolve("app-builder-lib/package.json", { paths: [require.resolve("electron-builder/package.json")] }))(
    "@electron/asar",
  );
  const allowed = ["/package.json", "/electron/dist/", "/packages/client/out-desktop/"];
  for (const asar of asars) {
    const entries = asarLib.listPackage(asar, { isPack: false }).map((e) => e.split(sep).join("/"));
    const files = entries.filter((e) => !allowed.some((a) => e === a.replace(/\/$/, "") || e.startsWith(a) || a.startsWith(`${e}/`)));
    const capacitor = entries.filter((e) => e.includes("@capacitor") || e.includes("capacitor-secure-storage"));
    if (capacitor.length) fail(`${relative(repoRoot, asar)} contains Capacitor:\n    ${capacitor.slice(0, 5).join("\n    ")}`);
    if (files.length) fail(`${relative(repoRoot, asar)} contains unexpected entries:\n    ${files.slice(0, 10).join("\n    ")}`);
    const bytes = statSync(asar).size;
    const packedVersion = JSON.parse(asarLib.extractFile(asar, "package.json").toString("utf8")).version;
    if (packedVersion !== rootVersion) {
      fail(`${relative(repoRoot, asar)} reports version ${packedVersion}; package.json says ${rootVersion}.`);
    }
    console.log(`    ${relative(repoRoot, asar)}: ${entries.length} entries, ${(bytes / 1e6).toFixed(1)} MB, no node_modules, version ${packedVersion}`);
  }

  if (process.platform === "darwin") {
    const apps = readdirSync(releaseDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .flatMap((d) => readdirSync(join(releaseDir, d.name)).filter((n) => n.endsWith(".app")).map((n) => join(releaseDir, d.name, n)))
      .filter((appPath) => fresh(join(appPath, "Contents/Resources/app.asar")));
    const plistValue = (appPath, key) => {
      const out = spawnSync("plutil", ["-extract", key, "raw", join(appPath, "Contents/Info.plist")], { encoding: "utf8" });
      return out.status === 0 ? out.stdout.trim() : null;
    };
    for (const appPath of apps) {
      const bundleVersion = plistValue(appPath, "CFBundleShortVersionString");
      if (bundleVersion !== rootVersion) {
        fail(`${relative(repoRoot, appPath)} has CFBundleShortVersionString "${bundleVersion}"; package.json says ${rootVersion}.`);
      }
      // A Mac App Store build: the keys electron-builder only takes from
      // mac.extendInfo (electron-builder.config.mjs) must have arrived.
      if (/[\\/]mas(-dev)?(-[a-z0-9]+)?$/.test(dirname(appPath))) {
        const encryption = plistValue(appPath, "ITSAppUsesNonExemptEncryption");
        if (encryption !== "false") fail(`${relative(repoRoot, appPath)} lacks ITSAppUsesNonExemptEncryption=false.`);
        const team = process.env.APPLE_TEAM_ID?.trim();
        if (signing?.mode === "signed" && plistValue(appPath, "ElectronTeamID") !== team) {
          fail(`${relative(repoRoot, appPath)} has no ElectronTeamID ${team}; the sandboxed app could not open its IPC channels.`);
        }
      }
      console.log(`    ${relative(repoRoot, appPath)}: CFBundleShortVersionString ${bundleVersion}`);
    }
  }
}

console.log("\n  Desktop build ready.\n");
