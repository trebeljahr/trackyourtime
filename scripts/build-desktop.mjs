#!/usr/bin/env node
/*
 * Build the desktop app (Tauri 2, desktop/src-tauri): the desktop static
 * export, then the Rust build that embeds it, then — with --package — the
 * channel's installers, renamed to the names the Electron releases used. One
 * script, so no half of it can be run against the wrong other half.
 *
 *   NEXT_PUBLIC_API_URL=… node scripts/build-desktop.mjs --export-only
 *   NEXT_PUBLIC_API_URL=… node scripts/build-desktop.mjs --e2e          # the harness's global setup
 *   NEXT_PUBLIC_API_URL=… node scripts/build-desktop.mjs --package --dir  # export + unpacked app (pnpm build:desktop)
 *   NEXT_PUBLIC_API_URL=… node scripts/build-desktop.mjs --package        # + this host's installers, unsigned
 *   node scripts/build-desktop.mjs --channel mac --package --arch arm64 --arch x64
 *   node scripts/build-desktop.mjs --channel mas --package --arch universal
 *   node scripts/build-desktop.mjs --channel win --package --arch x64 --arch arm64
 *   node scripts/build-desktop.mjs --channel win-store --package --arch x64 --arch arm64
 *   node scripts/build-desktop.mjs --channel linux --package --bundles appimage,deb,rpm,targz,snap
 *   node scripts/build-desktop.mjs --reuse-export --package …       # package the export already in out-desktop
 *   node scripts/build-desktop.mjs --package --dir --target aarch64-pc-windows-msvc   # pnpm prod:win, from a Mac (cargo-xwin)
 *   node scripts/build-desktop.mjs --open --package --dir           # pnpm prod:desktop; for people, never agents
 *
 * `--channel <mac|mas|win|win-store|linux>` is how a release is built (the
 * workflow always passes it): the signing secrets for that channel are checked
 * first, a partial set refuses, and no secrets builds files named -unsigned
 * (scripts/lib/desktop-release.mjs → resolveSigning, resolveUpdater). Without
 * --channel every package is unsigned, has no update feed and says -unsigned.
 *
 * Why each check exists:
 *
 *   1. Its own export directory, `packages/client/out-desktop`. `out/` is
 *      written by the web build and by Playwright, which bakes a throwaway
 *      127.0.0.1 API port — packaging whatever sits there ships an app bound
 *      to a dead port. The mobile build learned this first (`out-mobile`).
 *      The Rust build embeds this directory (tauri.conf.json → frontendDist,
 *      and desktop/src-tauri/build.rs refuses to build without it).
 *
 *   2. `NEXT_PUBLIC_API_URL` is required and searched for in the emitted
 *      chunks. It is baked in at build time; unset, every request resolves
 *      against the app's own origin and the build stays green.
 *
 *   3. No emitted HTML may reference "./_next". The app is served from the
 *      app:// scheme, which has a root; a relative asset prefix breaks every
 *      route but `/`.
 *
 *   4. A dev server of this checkout owns `packages/client/.next`, which a
 *      production export also builds in (with `output: "export"` a custom
 *      distDir only moves the export). Building beside it corrupts one of them.
 *
 *   5. After packaging, the version inside every package (Info.plist, the
 *      deb's and rpm's own fields) must be the root package.json's, and on a
 *      tag run the tag must be v<that version>. A release named 0.4.0 that
 *      reports 0.3.0 would be offered its own update forever.
 *
 *   6. Every update payload's minisign signature is checked against the
 *      committed public key (build/updater.pub) right where it is made. A
 *      payload signed with another key is rejected by every installed app,
 *      and nothing before that moment would say so.
 *
 *   7. On macOS the bundle must carry the compiled Icon Composer icon
 *      (Assets.car + CFBundleIconName) and icon.icns, which needs Xcode 26's
 *      actool on the packaging Mac; and a signed build is notarized and
 *      stapled before any archive is made of it, so the zip electron-updater
 *      installs and the tar.gz the Tauri updater installs both carry the
 *      ticket.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import yaml from "./lib/electron-yaml.mjs";

import { describeChildFailure } from "./lib/child-failure.mjs";
import { appleSigning, createNotarizer } from "./lib/desktop-apple.mjs";
import {
  artifactName,
  CHANNEL_BUNDLES,
  feedDigest,
  hostChannel,
  legacyFeedNames,
  LEGACY_FEED_FILES,
  masEntitlementsPlist,
  resolveSigning,
  resolveUpdater,
  tagMismatch,
  targetChannelProblem,
  tauriEnvFor,
  UPDATER_PUBKEY_FILE,
  updaterFragmentName,
  updaterTargets,
  legacyFeedText,
} from "./lib/desktop-release.mjs";
import {
  APP_ID,
  archOfTarget,
  BUNDLER_OUTPUTS,
  bundlerTargets,
  CARGO_MANIFEST,
  infoPlistFor,
  LINUX_NAME,
  mainBinaryFor,
  msixVersion,
  platformOfTarget,
  PRODUCT_NAME,
  RUST_TARGETS,
  TAURI_DIR,
  tauriBuildArgs,
  tauriConfigFor,
  unpackedDirName,
  updaterFragment,
  verifyMinisign,
} from "./lib/desktop-tauri.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

export const DESKTOP_OUT_DIR = "out-desktop";
const outPath = resolve(repoRoot, "packages/client", DESKTOP_OUT_DIR);
const tauriDir = resolve(repoRoot, TAURI_DIR);
const generatedDir = join(tauriDir, ".generated");
const releaseDir = resolve(repoRoot, "release");
/** Where the e2e harness reads which binary to launch (e2e/desktop/support.ts). */
const E2E_BINARY_INFO = resolve(repoRoot, "desktop/target/e2e-binary.json");
const targetDir = resolve(repoRoot, process.env.CARGO_TARGET_DIR || "desktop/target");
const rootVersion = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;

function fail(message) {
  console.error(`\n  build:desktop — ${message}\n`);
  process.exit(1);
}

function step(message) {
  console.log(`\n  ${message}`);
}

// ── Arguments ────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { exportOnly: false, reuseExport: false, e2e: false, package: false, dir: false, open: false, channel: null, archs: [], target: null, bundles: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      // Checked before anything is built: a typo here must not cost an export.
      if (!next || next.startsWith("--")) fail(`${arg} needs a value.`);
      return next;
    };
    if (arg === "--export-only") opts.exportOnly = true;
    else if (arg === "--reuse-export") opts.reuseExport = true;
    else if (arg === "--e2e") opts.e2e = true;
    else if (arg === "--package") opts.package = true;
    else if (arg === "--dir") opts.dir = true;
    else if (arg === "--open") opts.open = true;
    else if (arg === "--channel") opts.channel = value();
    else if (arg === "--arch") opts.archs.push(...value().split(","));
    else if (arg === "--target") opts.target = value();
    else if (arg === "--bundles") opts.bundles = value().split(",").map((b) => b.trim().toLowerCase()).filter(Boolean);
    else fail(`unknown argument ${arg}. See the header of scripts/build-desktop.mjs.`);
  }
  if ([opts.exportOnly, opts.e2e, opts.package].filter(Boolean).length > 1) fail("--export-only, --e2e and --package are separate modes; pass one.");
  if (opts.open && !(opts.package && opts.dir)) fail("--open launches the unpacked app, so it needs --package --dir.");
  if (opts.dir && opts.channel) fail("--dir builds an unsigned local app; drop --channel (a channel builds its installers).");
  if (opts.dir && opts.bundles) fail("--dir builds the unpacked app only; drop --bundles.");
  if (opts.target && opts.archs.length) fail("--target names one Rust target; drop --arch.");
  if (opts.e2e && opts.reuseExport) fail("--e2e reuses an export built for the same API by itself (DESKTOP_E2E_REBUILD=1 rebuilds it).");
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

function run(command, cmdArgs, { env = process.env, cwd = repoRoot, quiet = false } = {}) {
  const result = spawnSync(command, cmdArgs, {
    cwd,
    stdio: ["inherit", quiet ? "pipe" : "inherit", "pipe"],
    encoding: "utf8",
    env,
    shell: process.platform === "win32" && !/\.(exe)$/i.test(command) && !["powershell", "pwsh"].includes(command),
  });
  const stderr = result.stderr ?? "";
  if (stderr !== "" && !quiet) process.stderr.write(stderr);
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
  return result.stdout ?? "";
}

function walk(dir, predicate, hits = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, predicate, hits);
    else if (predicate(full)) hits.push(full);
  }
  return hits;
}

// ── 0. What this run builds ──────────────────────────────────────────

const targetPlatform = opts.target ? platformOfTarget(opts.target) : process.platform;
let targets = [];
let bundles = [];
let signing = { mode: "unsigned" };
let updater = { feed: false, reason: "no --channel" };
let pubkey = null;
const effectiveChannel = opts.channel ?? hostChannel(targetPlatform);

if (opts.package) {
  const mismatch = tagMismatch({ refType: process.env.GITHUB_REF_TYPE, refName: process.env.GITHUB_REF_NAME, version: rootVersion });
  if (mismatch) fail(mismatch);
  if (targetPlatform !== process.platform) {
    // The one cross build: an unpacked Windows app from a Mac, for a person's
    // VM (pnpm prod:win). Installers are only ever made on their own OS.
    if (!(process.platform === "darwin" && targetPlatform === "win32" && opts.dir)) {
      fail(`A ${targetPlatform} package is built on ${targetPlatform}. From a Mac only the unpacked Windows app cross-builds (--dir --target …-windows-msvc).`);
    }
  }
  const knownTargets = RUST_TARGETS[targetPlatform];
  if (!knownTargets) fail(`No desktop build for ${targetPlatform}.`);
  if (opts.target) {
    if (!Object.values(knownTargets).includes(opts.target)) fail(`Unknown target ${opts.target}. Known: ${Object.values(knownTargets).join(", ")}.`);
    targets = [opts.target];
  } else {
    const defaultArch = effectiveChannel === "mas" ? "universal" : process.arch === "arm64" ? "arm64" : "x64";
    const archs = opts.archs.length ? opts.archs : [defaultArch];
    for (const arch of archs) {
      if (!knownTargets[arch]) fail(`No ${arch} build on ${targetPlatform}. Known: ${Object.keys(knownTargets).join(", ")}.`);
      if (effectiveChannel === "mas" && arch !== "universal") fail("The Mac App Store takes one universal binary per build (--arch universal).");
      if (effectiveChannel === "mac" && arch === "universal") fail("The Developer ID downloads are split per architecture (--arch arm64 --arch x64).");
    }
    targets = archs.map((arch) => knownTargets[arch]);
  }

  if (!opts.dir) {
    bundles = opts.bundles ?? [...(CHANNEL_BUNDLES[effectiveChannel] ?? [])];
    const problem = targetChannelProblem(opts.channel, bundles, targetPlatform);
    if (problem) fail(problem);
  }

  if (opts.channel) {
    try {
      signing = resolveSigning(opts.channel, process.env);
      pubkey = existsSync(resolve(repoRoot, UPDATER_PUBKEY_FILE)) ? readFileSync(resolve(repoRoot, UPDATER_PUBKEY_FILE), "utf8").trim() : null;
      updater = resolveUpdater({ channel: opts.channel, signing, env: process.env, pubkey });
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  }
  // A Mac App Store pkg needs the installer identity; unsigned there is no pkg
  // at all, and the run checks the config by building the .app alone.
  if (effectiveChannel === "mas" && signing.mode !== "signed") bundles = bundles.filter((b) => b !== "pkg");
  step(
    `Channel ${opts.channel ?? `${effectiveChannel} (local)`}: ${signing.mode}${signing.set ? ` (${signing.set.join(", ")})` : ""}; ` +
      `update feed ${updater.feed ? "on" : `off — ${updater.reason}`}; ${targets.join(", ")}${opts.dir ? ", unpacked" : `, ${bundles.join(" ") || "app only"}`}`,
  );
}

// ── 1. Export ────────────────────────────────────────────────────────

const buildTargetFile = join(outPath, ".build-target.json");
const readBuildTarget = () => (existsSync(buildTargetFile) ? JSON.parse(readFileSync(buildTargetFile, "utf8")) : null);

function requireApiUrl() {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL?.trim();
  if (!apiUrl) {
    fail(
      "NEXT_PUBLIC_API_URL is not set.\n" +
        "  It is baked into the bundle at build time — unset, the app resolves every\n" +
        "  request against its own origin and fails with a green build.\n\n" +
        "  Local, in a worktree (see CLAUDE.md):\n" +
        "    API_PORT=51591 PORT=33921 pnpm run dev\n" +
        "    NEXT_PUBLIC_API_URL=http://localhost:51591 pnpm build:desktop",
    );
  }
  let apiOrigin;
  try {
    apiOrigin = new URL(apiUrl);
  } catch {
    fail(`NEXT_PUBLIC_API_URL is not a valid URL: ${apiUrl}`);
  }
  if (apiOrigin.pathname !== "/" || apiOrigin.search || apiOrigin.hash) {
    fail(`NEXT_PUBLIC_API_URL must be an origin with no path — got ${apiUrl}.\n  The clients append /api/trpc, /api/auth and /api/ws themselves.`);
  }
  return apiUrl;
}

function buildExport(apiUrl) {
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
  // Stale files from an earlier export would be embedded into the binary.
  rmSync(outPath, { recursive: true, force: true });
  run("pnpm", ["build:client"], {
    env: {
      ...process.env,
      // Set, never inherited: scripts/dev.mjs exports a per-worktree
      // NEXT_DIST_DIR, which would put this export somewhere else entirely.
      NEXT_DIST_DIR: DESKTOP_OUT_DIR,
      NEXT_PUBLIC_API_URL: apiUrl,
    },
  });

  step("Verifying the export");
  for (const required of ["index.html", "404.html", "app/track/index.html"]) {
    if (!existsSync(join(outPath, required))) fail(`No ${required} in ${outPath} — the export did not land where expected.`);
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
    fail(`The literal ${apiUrl} does not appear in any emitted chunk.\n  NEXT_PUBLIC_API_URL did not reach the client bundle.`);
  }
  console.log(`    ${apiUrl} is baked into the bundle`);
  // Read by the e2e reuse check below, by --reuse-export, and by build.rs as
  // its rerun trigger, so a new export always reaches the next cargo build.
  writeFileSync(buildTargetFile, `${JSON.stringify({ apiUrl, builtAt: new Date().toISOString() }, null, 2)}\n`);
}

if (opts.reuseExport) {
  const target = readBuildTarget();
  if (!target || !existsSync(join(outPath, "index.html"))) fail(`--reuse-export: no earlier export in ${outPath} (no .build-target.json).`);
  step(`Reusing the export in ${relative(repoRoot, outPath)} (built against ${target.apiUrl})`);
} else if (opts.e2e) {
  const apiUrl = requireApiUrl();
  const target = readBuildTarget();
  if (process.env.DESKTOP_E2E_REBUILD !== "1" && target?.apiUrl === apiUrl && existsSync(join(outPath, "index.html"))) {
    step(`Reusing the export in ${relative(repoRoot, outPath)} (built against ${apiUrl}; DESKTOP_E2E_REBUILD=1 rebuilds it)`);
  } else {
    buildExport(apiUrl);
  }
} else {
  buildExport(requireApiUrl());
}

if (opts.exportOnly) {
  console.log("\n  Desktop export ready.\n");
  process.exit(0);
}

// ── 2. The e2e build ─────────────────────────────────────────────────

if (opts.e2e) {
  step(`cargo build --features e2e (debug) → ${relative(repoRoot, targetDir)}`);
  run("cargo", ["build", "--manifest-path", resolve(repoRoot, CARGO_MANIFEST), "--features", "e2e"], {
    env: { ...process.env, CARGO_TARGET_DIR: targetDir },
  });
  const binary = join(targetDir, "debug", process.platform === "win32" ? "trackyourtime-desktop.exe" : "trackyourtime-desktop");
  if (!existsSync(binary)) fail(`cargo wrote no ${binary}.`);
  mkdirSync(dirname(E2E_BINARY_INFO), { recursive: true });
  writeFileSync(E2E_BINARY_INFO, `${JSON.stringify({ path: binary, apiUrl: readBuildTarget()?.apiUrl ?? null }, null, 2)}\n`);
  console.log(`    ${relative(repoRoot, binary)} (written to ${relative(repoRoot, E2E_BINARY_INFO)})`);
  console.log("\n  Desktop e2e build ready.\n");
  process.exit(0);
}

if (!opts.package) {
  console.log("\n  Nothing to package: pass --package (with --dir for the unpacked app), --e2e or --export-only.\n");
  process.exit(0);
}

// ── 3. Generated inputs ──────────────────────────────────────────────

mkdirSync(generatedDir, { recursive: true });
mkdirSync(releaseDir, { recursive: true });

const icons = ["icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png", "icons/icon.png", "icons/icon.icns", "icons/icon.ico"];
if (icons.some((icon) => !existsSync(join(tauriDir, icon)))) {
  step("Generating desktop icons (build/icon.png → desktop/src-tauri/icons)");
  run("pnpm", ["icons:desktop"]);
}

let assetCatalog = null;
if (targetPlatform === "darwin") {
  // The macOS icon is an Icon Composer document only Xcode 26's actool
  // compiles. Said here, rather than as a blank icon after a 10-minute build.
  if (!existsSync(resolve(repoRoot, "build/AppIcon.icon/icon.json"))) fail("No build/AppIcon.icon. Run: pnpm icons:brand");
  const actool = spawnSync("xcrun", ["actool", "--version"], { encoding: "utf8" });
  const actoolVersion = /<key>short-bundle-version<\/key>\s*<string>(\d+)/.exec(actool.stdout ?? "")?.[1];
  if (!actoolVersion || Number(actoolVersion) < 26) {
    fail(`The macOS icon needs Xcode 26 or later (actool ${actoolVersion ?? "not found"}). Install it and run xcode-select -s.`);
  }
  const icons = join(generatedDir, "icons");
  rmSync(icons, { recursive: true, force: true });
  mkdirSync(icons, { recursive: true });
  // prettier-ignore
  run("xcrun", [
    "actool", resolve(repoRoot, "build/AppIcon.icon"), "--compile", icons,
    "--output-format", "human-readable-text", "--notices", "--warnings",
    "--output-partial-info-plist", join(icons, "partial.plist"),
    "--app-icon", "AppIcon", "--include-all-app-icons",
    "--enable-on-demand-resources", "NO", "--development-region", "en",
    "--target-device", "mac", "--minimum-deployment-target", "12.0", "--platform", "macosx",
  ], { quiet: true });
  assetCatalog = join(icons, "Assets.car");
  if (!existsSync(assetCatalog)) fail("actool wrote no Assets.car.");
}

const paths = {
  macEntitlements: resolve(repoRoot, "build/entitlements.tauri.plist"),
  masEntitlements: join(generatedDir, "entitlements.mas.plist"),
  infoPlist: join(generatedDir, "Info.plist"),
  assetCatalog,
  provisioningProfile: process.env.MAS_PROVISIONING_PROFILE?.trim() || null,
  nsisHooks: resolve(repoRoot, "build/windows/installer-hooks.nsh"),
  signWindows: resolve(repoRoot, "scripts/desktop/sign-windows.ps1"),
  desktopTemplate: resolve(repoRoot, "build/linux/trackyourtime.desktop.hbs"),
  preinstall: resolve(repoRoot, "build/linux/preinstall.sh"),
};
// The store entitlements name the team, so they are written per build.
writeFileSync(paths.masEntitlements, masEntitlementsPlist({ teamId: process.env.APPLE_TEAM_ID ?? "", appId: APP_ID }));
writeFileSync(paths.infoPlist, infoPlistFor({ assetCatalog }));

// ── 4. Build ─────────────────────────────────────────────────────────

const unsigned = signing.mode !== "signed" && effectiveChannel !== "linux" && effectiveChannel !== "win-store";
const tauriBin = resolve(repoRoot, "node_modules/.bin", process.platform === "win32" ? "tauri.cmd" : "tauri");
if (!existsSync(tauriBin)) fail("No tauri CLI in node_modules. Run: pnpm install");
const outputs = []; // { kind, arch, file } written this run
const fragmentEntries = []; // { targets, file, signature }

/** Remove the release files a previous run wrote under the names this run writes. */
function claim(file) {
  rmSync(file, { recursive: true, force: true });
  return file;
}

function find(dir, match, what) {
  const hits = existsSync(dir) ? readdirSync(dir).filter(match) : [];
  if (hits.length !== 1) fail(`Expected one ${what} in ${dir}, found ${hits.length}${hits.length ? `: ${hits.join(", ")}` : ""}.`);
  return join(dir, hits[0]);
}

/**
 * A bundler output, which names itself after the version it was built with
 * (`Track Your Time_0.4.0_x64-setup.exe`, `trackyourtime_0.4.0_amd64.AppImage`).
 * The version comes from tauri.conf.json → `../../package.json`; a name that
 * says otherwise is a package that would be offered its own update forever.
 */
function findVersioned(dir, match, what) {
  const file = find(dir, match, what);
  const name = file.split(/[\\/]/).pop();
  if (!name.includes(`_${rootVersion}`) && !name.includes(`-${rootVersion}`)) fail(`${name} does not carry version ${rootVersion} (package.json).`);
  return file;
}

function signUpdate(file, arch, kind) {
  // An unset password makes `tauri signer` prompt for one, which a CI run
  // would wait on forever; an empty one is a key without a password.
  const env = { ...process.env, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "" };
  run(tauriBin, ["signer", "sign", file], { env, quiet: true });
  const signature = readFileSync(`${file}.sig`, "utf8").trim();
  const verdict = verifyMinisign({ publicKey: pubkey, signature, data: readFileSync(file) });
  if (!verdict.ok) fail(`${relative(repoRoot, file)}: ${verdict.reason} Installed apps would reject this update; check TAURI_SIGNING_PRIVATE_KEY against ${UPDATER_PUBKEY_FILE}.`);
  fragmentEntries.push({ targets: updaterTargets(kind, arch), file: file.split(/[\\/]/).pop(), signature });
  console.log(`    ${relative(repoRoot, file)}: update signature verified against ${UPDATER_PUBKEY_FILE}`);
}

function plistValue(appPath, key) {
  const out = spawnSync("plutil", ["-extract", key, "raw", join(appPath, "Contents/Info.plist")], { encoding: "utf8" });
  return out.status === 0 ? out.stdout.trim() : null;
}

function verifyMacApp(appPath) {
  const problems = [];
  const version = plistValue(appPath, "CFBundleShortVersionString");
  if (version !== rootVersion) problems.push(`CFBundleShortVersionString is "${version}"; package.json says ${rootVersion}`);
  if (plistValue(appPath, "CFBundleIdentifier") !== APP_ID) problems.push(`CFBundleIdentifier is not ${APP_ID}`);
  if (plistValue(appPath, "CFBundleExecutable") !== PRODUCT_NAME) problems.push(`CFBundleExecutable is not "${PRODUCT_NAME}"`);
  if (plistValue(appPath, "ITSAppUsesNonExemptEncryption") !== "false") problems.push("ITSAppUsesNonExemptEncryption is not false");
  const resources = join(appPath, "Contents/Resources");
  const iconName = plistValue(appPath, "CFBundleIconName");
  const iconFile = plistValue(appPath, "CFBundleIconFile");
  if (!iconName || !existsSync(join(resources, "Assets.car"))) problems.push(`no compiled app icon (CFBundleIconName ${iconName}, Assets.car missing?)`);
  else {
    const catalog = spawnSync("xcrun", ["assetutil", "--info", join(resources, "Assets.car")], { encoding: "utf8" });
    if (!(catalog.stdout ?? "").includes(`"Name" : "${iconName}"`)) problems.push(`Assets.car holds no image set named ${iconName}`);
  }
  if (!iconFile || !existsSync(join(resources, iconFile.endsWith(".icns") ? iconFile : `${iconFile}.icns`))) problems.push(`CFBundleIconFile ${iconFile} is not in Contents/Resources`);
  if (problems.length) fail(`${relative(repoRoot, appPath)}:\n    ${problems.join("\n    ")}`);
  console.log(`    ${relative(repoRoot, appPath)}: ${APP_ID} ${version} (${plistValue(appPath, "CFBundleVersion")}), icon ${iconName} (Assets.car + ${iconFile})`);
}

const notarize = signing.mode === "signed" && effectiveChannel === "mac" ? createNotarizer({ env: process.env }) : null;
let apple = null;
try {
  if (targetPlatform === "darwin" && signing.mode === "signed") {
    step("Importing the signing certificate into a throwaway keychain");
    apple = appleSigning(process.env, { mas: effectiveChannel === "mas" });
    console.log(`    ${apple.identity}${apple.installerIdentity ? `; installer: ${apple.installerIdentity}` : ""}`);
  }

  const config = tauriConfigFor({
    channel: opts.channel,
    platform: targetPlatform,
    signing,
    updater,
    pubkey,
    identity: apple?.identity ?? null,
    buildNumber: effectiveChannel === "mas" ? process.env.DESKTOP_BUILD_NUMBER?.trim() || null : null,
    paths,
  });
  const configPath = join(generatedDir, "tauri.release.json");
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const tauriEnv = { ...tauriEnvFor({ env: process.env, signing, updater }), CARGO_TARGET_DIR: targetDir };
  // As in signUpdate: the bundler signs the update payloads with the same key.
  if (updater.feed) tauriEnv.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= "";

  for (const target of targets) {
    const arch = archOfTarget(target);
    const tauriBundles = bundlerTargets({ channel: effectiveChannel, platform: targetPlatform, bundles, dir: opts.dir });
    const features = effectiveChannel === "mas" ? ["mas"] : [];
    const runner = targetPlatform === "win32" && process.platform !== "win32" ? "cargo-xwin" : null;
    const releaseOut = join(targetDir, target, "release");
    rmSync(join(releaseOut, "bundle"), { recursive: true, force: true });
    step(`tauri build --target ${target}${tauriBundles.length ? ` --bundles ${tauriBundles.join(",")}` : " --no-bundle"}${features.length ? ` --features ${features.join(",")}` : ""}`);
    run(tauriBin, tauriBuildArgs({ configPath, target, bundles: tauriBundles, features, runner, locked: Boolean(process.env.CI) }), { env: tauriEnv, cwd: tauriDir });
    const bundleDir = join(releaseOut, "bundle");
    const unpacked = claim(join(releaseDir, unpackedDirName({ platform: targetPlatform, arch, channel: effectiveChannel })));
    mkdirSync(unpacked, { recursive: true });

    if (targetPlatform === "darwin") {
      const app = join(unpacked, `${PRODUCT_NAME}.app`);
      cpSync(find(join(bundleDir, BUNDLER_OUTPUTS.app.dir), BUNDLER_OUTPUTS.app.match, `${PRODUCT_NAME}.app`), app, { recursive: true, verbatimSymlinks: true });
      step(`Verifying ${relative(repoRoot, app)}`);
      verifyMacApp(app);
      if (effectiveChannel === "mas") {
        if (signing.mode === "signed") {
          if (!existsSync(join(app, "Contents/embedded.provisionprofile"))) fail(`${relative(repoRoot, app)} has no embedded.provisionprofile.`);
          const pkg = claim(join(releaseDir, artifactName("mas", { version: rootVersion, arch, unsigned: false })));
          step(`productbuild → ${relative(repoRoot, pkg)}`);
          run("productbuild", ["--component", app, "/Applications", "--sign", apple.installerIdentity, pkg]);
          outputs.push({ kind: "mas", arch, file: pkg });
        }
        continue;
      }
      if (notarize) {
        step(`Notarizing ${PRODUCT_NAME}.app (${arch})`);
        await notarize(app, { app: true });
      }
      if (opts.dir) continue;
      if (bundles.includes("zip")) {
        // electron-updater installs this zip on every Electron install it
        // migrates (MacUpdater → Squirrel.Mac, which checks the new app's
        // signature against the running app's designated requirement: same
        // team, same identifier). ditto keeps the signature's extended
        // attributes; a plain `zip` would break it.
        const zip = claim(join(releaseDir, artifactName("zip", { version: rootVersion, arch, unsigned })));
        run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, zip]);
        outputs.push({ kind: "zip", arch, file: zip });
      }
      if (bundles.includes("dmg")) {
        const dmg = claim(join(releaseDir, artifactName("dmg", { version: rootVersion, arch, unsigned })));
        const stage = mkdtempSync(join(tmpdir(), "trackyourtime-dmg-"));
        try {
          run("ditto", [app, join(stage, `${PRODUCT_NAME}.app`)]);
          symlinkSync("/Applications", join(stage, "Applications"));
          run("hdiutil", ["create", "-volname", PRODUCT_NAME, "-srcfolder", stage, "-ov", "-format", "UDZO", dmg], { quiet: true });
        } finally {
          rmSync(stage, { recursive: true, force: true });
        }
        if (signing.mode === "signed") {
          run("codesign", ["--force", "--sign", apple.identity, "--timestamp", dmg]);
          step(`Notarizing ${relative(repoRoot, dmg)}`);
          await notarize(dmg);
        }
        outputs.push({ kind: "dmg", arch, file: dmg });
      }
      if (updater.feed) {
        // Made from the stapled app, never the bundler's own archive, which
        // predates notarization.
        const archive = claim(join(releaseDir, artifactName("macUpdater", { version: rootVersion, arch })));
        rmSync(`${archive}.sig`, { force: true });
        run("tar", ["-czf", archive, "-C", unpacked, `${PRODUCT_NAME}.app`], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
        signUpdate(archive, arch, "macUpdater");
        outputs.push({ kind: "macUpdater", arch, file: archive });
      }
    }

    if (targetPlatform === "win32") {
      const exe = join(unpacked, mainBinaryFor("win32"));
      cpSync(join(releaseOut, mainBinaryFor("win32")), exe);
      if (effectiveChannel === "win-store") {
        const appx = claim(join(releaseDir, artifactName("appx", { version: rootVersion, arch })));
        step(`MSIX → ${relative(repoRoot, appx)}`);
        // prettier-ignore
        run("pwsh", ["-NoProfile", "-NonInteractive", "-File", resolve(repoRoot, "scripts/desktop/msix.ps1"),
          "-Source", unpacked, "-Output", appx, "-Version", msixVersion(rootVersion), "-Arch", arch, "-Assets", resolve(repoRoot, "build/appx")]);
        outputs.push({ kind: "appx", arch, file: appx });
        continue;
      }
      if (opts.dir) continue;
      const installer = claim(join(releaseDir, artifactName("nsis", { version: rootVersion, arch, unsigned })));
      const built = findVersioned(join(bundleDir, BUNDLER_OUTPUTS.nsis.dir), BUNDLER_OUTPUTS.nsis.match, "NSIS installer");
      cpSync(built, installer);
      outputs.push({ kind: "nsis", arch, file: installer });
      if (updater.feed) {
        // The bundler signed it with the update key already; the signature
        // covers the bytes, so it holds for the renamed copy.
        cpSync(`${built}.sig`, `${installer}.sig`);
        const signature = readFileSync(`${installer}.sig`, "utf8").trim();
        const verdict = verifyMinisign({ publicKey: pubkey, signature, data: readFileSync(installer) });
        if (!verdict.ok) fail(`${relative(repoRoot, installer)}: ${verdict.reason}`);
        fragmentEntries.push({ targets: updaterTargets("nsis", arch), file: installer.split(/[\\/]/).pop(), signature });
        console.log(`    ${relative(repoRoot, installer)}: update signature verified against ${UPDATER_PUBKEY_FILE}`);
      }
    }

    if (targetPlatform === "linux") {
      const binary = join(unpacked, LINUX_NAME);
      cpSync(join(releaseOut, LINUX_NAME), binary);
      if (opts.dir) continue;
      const wants = (b) => bundles.includes(b);
      if (wants("deb") || wants("snap")) {
        const deb = claim(join(releaseDir, artifactName("deb", { version: rootVersion, arch })));
        cpSync(findVersioned(join(bundleDir, BUNDLER_OUTPUTS.deb.dir), BUNDLER_OUTPUTS.deb.match, ".deb"), deb);
        const fields = spawnSync("dpkg-deb", ["-f", deb, "Package", "Version"], { encoding: "utf8" });
        if (fields.status === 0) {
          const [pkg, version] = fields.stdout.trim().split("\n").map((line) => line.split(": ")[1]);
          if (pkg !== LINUX_NAME || version !== rootVersion) fail(`${relative(repoRoot, deb)} is package ${pkg} ${version}; expected ${LINUX_NAME} ${rootVersion}.`);
        }
        if (wants("deb")) outputs.push({ kind: "deb", arch, file: deb });
        if (wants("snap")) buildSnap({ deb, arch });
        if (!wants("deb")) rmSync(deb, { force: true });
      }
      if (wants("rpm")) {
        const rpm = claim(join(releaseDir, artifactName("rpm", { version: rootVersion, arch })));
        cpSync(findVersioned(join(bundleDir, BUNDLER_OUTPUTS.rpm.dir), BUNDLER_OUTPUTS.rpm.match, ".rpm"), rpm);
        const fields = spawnSync("rpm", ["-qp", "--nosignature", "--qf", "%{NAME} %{VERSION}", rpm], { encoding: "utf8" });
        if (fields.status === 0 && fields.stdout.trim() !== `${LINUX_NAME} ${rootVersion}`) {
          fail(`${relative(repoRoot, rpm)} is ${fields.stdout.trim()}; expected ${LINUX_NAME} ${rootVersion}.`);
        }
        outputs.push({ kind: "rpm", arch, file: rpm });
      }
      if (wants("appimage")) {
        const image = claim(join(releaseDir, artifactName("appimage", { version: rootVersion, arch })));
        const built = findVersioned(join(bundleDir, BUNDLER_OUTPUTS.appimage.dir), BUNDLER_OUTPUTS.appimage.match, ".AppImage");
        cpSync(built, image);
        outputs.push({ kind: "appimage", arch, file: image });
        if (updater.feed) {
          cpSync(`${built}.sig`, `${image}.sig`);
          const signature = readFileSync(`${image}.sig`, "utf8").trim();
          const verdict = verifyMinisign({ publicKey: pubkey, signature, data: readFileSync(image) });
          if (!verdict.ok) fail(`${relative(repoRoot, image)}: ${verdict.reason}`);
          fragmentEntries.push({ targets: updaterTargets("appimage", arch), file: image.split("/").pop(), signature });
          console.log(`    ${relative(repoRoot, image)}: update signature verified against ${UPDATER_PUBKEY_FILE}`);
        }
      }
      if (wants("targz")) {
        // The portable archive, and what the Flathub manifest repackages
        // (packaging/flatpak/): the executable, its desktop entry, its icon
        // and the licence, under one top-level folder.
        const archive = claim(join(releaseDir, artifactName("targz", { version: rootVersion, arch })));
        const top = artifactName("targz", { version: rootVersion, arch }).replace(/\.tar\.gz$/, "");
        const stage = mkdtempSync(join(tmpdir(), "trackyourtime-targz-"));
        try {
          mkdirSync(join(stage, top));
          cpSync(join(releaseOut, LINUX_NAME), join(stage, top, LINUX_NAME));
          cpSync(join(tauriDir, "icons/icon.png"), join(stage, top, "icon.png"));
          cpSync(resolve(repoRoot, "LICENSE"), join(stage, top, "LICENSE"));
          writeFileSync(
            join(stage, top, `${LINUX_NAME}.desktop`),
            readFileSync(paths.desktopTemplate, "utf8")
              .replace(/\{\{exec\}\}/g, LINUX_NAME)
              .replace(/\{\{icon\}\}/g, LINUX_NAME)
              .replace(/\{\{comment\}\}/g, "Free, open-source time tracking"),
          );
          run("tar", ["-czf", archive, "-C", stage, top]);
        } finally {
          rmSync(stage, { recursive: true, force: true });
        }
        outputs.push({ kind: "targz", arch, file: archive });
      }
    }
  }
} finally {
  apple?.close();
}

/**
 * The snap, packed by snapcraft from the deb this run built
 * (packaging/snap/snapcraft.yaml.template): core24 with the GNOME extension,
 * whose content snap carries WebKitGTK 4.1. Packed in destructive mode on the
 * runner itself, which is an Ubuntu 24.04 (the base core24 is built from), so
 * the staged libraries and the base agree.
 */
function buildSnap({ deb, arch }) {
  const snapArch = { x64: "amd64", arm64: "arm64" }[arch];
  const snap = claim(join(releaseDir, artifactName("snap", { version: rootVersion, arch })));
  const project = mkdtempSync(join(tmpdir(), "trackyourtime-snap-"));
  try {
    mkdirSync(join(project, "snap"), { recursive: true });
    cpSync(deb, join(project, "app.deb"));
    const template = readFileSync(resolve(repoRoot, "packaging/snap/snapcraft.yaml.template"), "utf8");
    writeFileSync(join(project, "snap/snapcraft.yaml"), template.replace(/\{\{version\}\}/g, rootVersion).replace(/\{\{arch\}\}/g, snapArch));
    step(`snapcraft pack (${snapArch}) → ${relative(repoRoot, snap)}`);
    run("snapcraft", ["pack", "--destructive-mode", "--output", snap], { cwd: project });
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
  outputs.push({ kind: "snap", arch, file: snap });
}

// ── 5. Update feeds ──────────────────────────────────────────────────

if (updater.feed && !opts.dir) {
  const leg = effectiveChannel === "linux" ? `linux-${archOfTarget(targets[0])}` : effectiveChannel;
  if (effectiveChannel === "linux" && targets.length !== 1) fail("A Linux leg builds one architecture.");
  const archs = targets.map(archOfTarget);
  const feedName = LEGACY_FEED_FILES[leg];
  const names = legacyFeedNames({ leg, version: rootVersion, archs });
  const files = names.map((name) => {
    const file = join(releaseDir, name);
    if (!existsSync(file)) fail(`${feedName} would name ${name}, which this run did not write.`);
    return { url: name, ...feedDigest(readFileSync(file)) };
  });
  const feedFile = claim(join(releaseDir, feedName));
  writeFileSync(feedFile, legacyFeedText({ version: rootVersion, files, releaseDate: new Date().toISOString(), dump: yaml.dump }));
  const fragmentFile = claim(join(releaseDir, updaterFragmentName(leg)));
  writeFileSync(fragmentFile, `${JSON.stringify(updaterFragment({ version: rootVersion, entries: fragmentEntries }), null, 2)}\n`);
  step(`Update feeds: ${feedName} (${names.join(", ")}) and ${updaterFragmentName(leg)} (${Object.keys(updaterFragment({ version: rootVersion, entries: fragmentEntries }).platforms).join(", ")})`);
}

console.log("\n  Desktop build ready:");
for (const { file } of outputs) console.log(`    ${relative(repoRoot, file)} (${(statSync(file).size / 1e6).toFixed(1)} MB)`);
if (opts.dir || outputs.length === 0) {
  for (const target of targets) {
    console.log(`    ${relative(repoRoot, join(releaseDir, unpackedDirName({ platform: targetPlatform, arch: archOfTarget(target), channel: effectiveChannel })))}/`);
  }
}
console.log("");

if (opts.open) {
  // For a person trying a build by hand: it shows and focuses a real window,
  // so tests and agents never pass it.
  const dir = join(releaseDir, unpackedDirName({ platform: targetPlatform, arch: archOfTarget(targets[0]), channel: effectiveChannel }));
  const launch = targetPlatform === "darwin" ? join(dir, `${PRODUCT_NAME}.app`) : join(dir, mainBinaryFor(targetPlatform));
  if (!existsSync(launch)) fail(`No unpacked app at ${launch}.`);
  console.log(`  Opening ${relative(repoRoot, launch)}\n`);
  if (process.platform === "darwin") execFileSync("open", [launch], { stdio: "inherit" });
  else spawn(launch, [], { detached: true, stdio: "ignore" }).unref();
}
