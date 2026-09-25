#!/usr/bin/env node
/*
 * Build the Capacitor web bundle and sync it into the native projects —
 * as ONE operation, because the two halves are only correct together.
 *
 * Why this is a script and not `pnpm build:client && cap sync`:
 *
 *   1. `cap sync` copies whatever is sitting in `webDir` right now. The web
 *      build and the Playwright E2E build both write `packages/client/out`
 *      (playwright.config.ts bakes NEXT_PUBLIC_API_URL=http://127.0.0.1:<port>
 *      into it), and `cap run` syncs implicitly. So a bare `cap run ios` after
 *      a test run installs an app permanently pointed at a dead E2E port, with
 *      no error anywhere. The mobile export therefore gets its OWN directory —
 *      `packages/client/out-mobile` — and nothing else ever writes there.
 *
 *   2. `NEXT_PUBLIC_API_URL` is baked in at build time. Unset, it ships a
 *      binary that resolves the API against `capacitor://localhost` and fails
 *      every request on device while the build stays green. So it is required,
 *      and the built chunks are searched for the literal afterwards.
 *
 *   3. Under SPM the Capacitor CLI DROPS any plugin without a Package.swift
 *      with a warning and exits 0 (@capacitor/cli/dist/util/spm.js), so a
 *      missing plugin is a device-only runtime error after a green build.
 *      Checked here instead.
 *
 * Output directory mechanics: with `output: "export"`, Next treats a custom
 * `distDir` as the EXPORT directory and forces the internal build directory
 * back to `.next` (next/dist/export/utils.js `hasCustomExportOutput`). That is
 * why `NEXT_DIST_DIR=out-mobile` relocates the artifact but the build still
 * uses `packages/client/.next` — which is also why a dev server running out of
 * this checkout blocks a mobile build (see the dev-lock preflight below).
 *
 * Usage:
 *   NEXT_PUBLIC_API_URL=http://localhost:51590 node scripts/build-mobile.mjs
 *   node scripts/build-mobile.mjs ios          # sync only iOS
 *   node scripts/build-mobile.mjs --require-api  # unreachable API = error
 */
import { spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeChildFailure } from "./lib/child-failure.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

/** The mobile export's own directory — never shared with web or E2E builds. */
const MOBILE_OUT_DIR = "out-mobile";
const outPath = resolve(repoRoot, "packages/client", MOBILE_OUT_DIR);

const ALL_PLATFORMS = ["ios", "android"];

const args = process.argv.slice(2);
const requireApi = args.includes("--require-api");
const requestedPlatforms = args.filter((a) => ALL_PLATFORMS.includes(a));

function fail(message) {
  console.error(`\n  build:mobile — ${message}\n`);
  process.exit(1);
}

function step(message) {
  console.log(`\n  ${message}`);
}

/*
 * stdout is inherited so a long build still shows progress live; stderr is
 * piped so the tail can be repeated next to the failure message. It is echoed
 * unconditionally afterwards, success included — a build that warns on stderr
 * must not go quiet just because this function wanted to keep a copy.
 */
function run(command, cmdArgs, env = {}) {
  const result = spawnSync(command, cmdArgs, {
    cwd: repoRoot,
    stdio: ["inherit", "inherit", "pipe"],
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  const stderr = result.stderr ?? "";
  if (stderr !== "") process.stderr.write(stderr);
  if (result.error) {
    fail(
      describeChildFailure({
        command,
        args: cmdArgs,
        status: result.status,
        signal: result.signal,
        stderr: `${stderr}${result.error.message}`,
      }),
    );
  }
  if (result.status !== 0) {
    fail(
      describeChildFailure({
        command,
        args: cmdArgs,
        status: result.status,
        signal: result.signal,
        stderr,
      }),
    );
  }
}

function capture(command, cmdArgs) {
  const result = spawnSync(command, cmdArgs, { cwd: repoRoot, encoding: "utf8" });
  return {
    ok: result.status === 0,
    out: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

// ── 1. The baked API URL ─────────────────────────────────────────────

const apiUrl = process.env.NEXT_PUBLIC_API_URL?.trim();
if (!apiUrl) {
  fail(
    "NEXT_PUBLIC_API_URL is not set.\n" +
      "  It is baked into the bundle at build time — an unset value ships an app\n" +
      "  that resolves every request against capacitor://localhost and fails on\n" +
      "  device with a green build.\n\n" +
      "  Local dev in a worktree (see CLAUDE.md):\n" +
      "    API_PORT=51590 PORT=33920 pnpm run dev\n" +
      "    NEXT_PUBLIC_API_URL=http://localhost:51590 pnpm build:mobile",
  );
}

let apiOrigin;
try {
  apiOrigin = new URL(apiUrl);
} catch {
  fail(`NEXT_PUBLIC_API_URL is not a valid URL: ${apiUrl}`);
}
if (apiOrigin.pathname !== "/") {
  fail(
    `NEXT_PUBLIC_API_URL must be an origin with no path — got ${apiUrl}.\n` +
      "  The clients append /api/trpc, /api/auth and /api/ws themselves.",
  );
}

// ── 2. Which platforms ───────────────────────────────────────────────

const presentPlatforms = ALL_PLATFORMS.filter((p) => existsSync(resolve(repoRoot, p)));

for (const platform of requestedPlatforms) {
  if (!presentPlatforms.includes(platform)) {
    fail(`No ${platform}/ directory — run \`pnpm cap:add:${platform}\` first.`);
  }
}

/**
 * Why a toolchain check decides the platform set rather than the directory
 * existing: both native trees are COMMITTED, so from the Android stage onward
 * every checkout has an `android/` whether or not the machine can do anything
 * with it — a Mac with no Android SDK, or the Linux runner that only builds
 * the AAB. A bare `pnpm build:mobile` there must not fail on the platform the
 * caller never asked for.
 *
 * So: a platform named on the command line is a demand and a missing toolchain
 * is an error; an auto-detected one is an offer and a missing toolchain skips
 * it with a note. Returns a reason string, or null when the toolchain is there.
 */
function toolchainProblem(platform) {
  if (platform === "ios") {
    if (process.platform !== "darwin") return "iOS builds need macOS.";
    // A full Xcode rather than the Command Line Tools alone. The capability is
    // probed, never the path's NAME: a runner selects a versioned bundle
    // (`/Applications/Xcode_26.6.app/Contents/Developer`), which a literal
    // "Xcode.app" test reads as no Xcode at all — it failed every CI iOS build
    // while the runner had Xcode all along. `xcodebuild -version` is the thing
    // itself: with only the Command Line Tools selected it exits non-zero with
    // "tool 'xcodebuild' requires Xcode".
    const xcodePath = capture("xcode-select", ["-p"]);
    if (!xcodePath.ok || !capture("xcodebuild", ["-version"]).ok) {
      return (
        `xcode-select points at ${xcodePath.out.trim() || "nothing"} — a full Xcode install is\n` +
        "    needed:  sudo xcode-select -s /Applications/Xcode.app"
      );
    }
    const sims = capture("xcrun", ["simctl", "list", "devices", "available"]);
    if (!sims.ok || !/^\s+iPhone .*\(/m.test(sims.out)) {
      return "No available iPhone simulator — install a runtime in Xcode → Settings → Components.";
    }
    return null;
  }

  // Android: a JDK and an SDK, found the same way scripts/android-env.sh finds
  // them, so the two cannot disagree about whether this machine is ready.
  // `/usr/bin/java` exists on every Mac and is a stub that exits non-zero when
  // no JDK is installed, so the runtime is probed rather than looked for.
  const javaHomes = [
    process.env.JAVA_HOME,
    "/Applications/Android Studio.app/Contents/jbr/Contents/Home",
  ].filter(Boolean);
  const javaHome = javaHomes.find((home) => existsSync(join(home, "bin/java")));
  if (!javaHome && !capture("java", ["-version"]).ok) {
    return (
      "No Java runtime. Install Android Studio (its bundled JBR is what\n" +
      "    scripts/android-env.sh points JAVA_HOME at) or set JAVA_HOME."
    );
  }
  const sdkHome = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    join(homedir(), "Library/Android/sdk"),
  ].find((dir) => dir && existsSync(dir));
  if (!sdkHome) {
    return "No Android SDK at $ANDROID_HOME (or ~/Library/Android/sdk).";
  }
  return null;
}

const platforms = [];
for (const platform of requestedPlatforms.length ? requestedPlatforms : presentPlatforms) {
  const problem = toolchainProblem(platform);
  if (!problem) {
    platforms.push(platform);
  } else if (requestedPlatforms.includes(platform)) {
    fail(`${platform} was asked for, but its toolchain is not usable here:\n    ${problem}`);
  } else {
    console.warn(
      `\n  Skipping ${platform}/ — its toolchain is not usable on this machine:\n` +
        `    ${problem}\n` +
        `  Pass \`${platform}\` explicitly to make that an error instead.`,
    );
  }
}

if (platforms.length === 0) {
  console.warn(
    "\n  No native platform to sync — building the export only.\n" +
      "  Add one with `pnpm cap:add:ios` / `pnpm cap:add:android`.",
  );
}

// ── 3. Preflight ─────────────────────────────────────────────────────

step("Preflight");

// 3a. A dev server for this checkout owns packages/client/.next, and a
// production build writes there too (see the header). Sharing it either
// discards the dev cache or deadlocks on Next 16's dev lock.
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

// 3b. capacitor.config.ts is covered by no tsconfig, so `cap ls` loading it is
// the only thing that validates it before a native command runs.
const capLs = capture("npx", ["cap", "ls"]);
if (!capLs.ok) {
  fail(`\`npx cap ls\` failed — capacitor.config.ts is not loading:\n\n${capLs.out}`);
}
console.log("    capacitor.config.ts loads");

// 3c. Every installed Capacitor plugin must ship a Package.swift, or the CLI
// drops it silently under SPM and the app throws "not implemented on ios".
if (platforms.includes("ios")) {
  const rootPkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
  const deps = Object.keys({ ...rootPkg.dependencies, ...rootPkg.devDependencies });
  const missing = [];
  let checked = 0;
  for (const dep of deps) {
    const pkgPath = resolve(repoRoot, "node_modules", dep, "package.json");
    if (!existsSync(pkgPath)) continue;
    let meta;
    try {
      meta = JSON.parse(readFileSync(pkgPath, "utf8"));
    } catch {
      continue;
    }
    if (!meta.capacitor?.ios) continue; // not an iOS-capable Capacitor plugin
    checked += 1;
    if (!existsSync(resolve(repoRoot, "node_modules", dep, "Package.swift"))) {
      missing.push(dep);
    }
  }
  if (missing.length) {
    fail(
      "These Capacitor plugins ship no Package.swift, so the SPM sync drops them\n" +
        "  with a warning and still exits 0 — they would be missing on device:\n" +
        missing.map((m) => `    ${m}`).join("\n"),
    );
  }
  console.log(`    ${checked} iOS plugin(s), all SPM-compatible`);
}

// 3c-bis. The native identifiers and version are hand-edits. `cap add` is a
// bare template extraction — @capacitor/cli/dist/ios/add.js and .../android/add.js
// call extractTemplate() and nothing else, so the shipped archives' own
// placeholders (com.getcapacitor.App / "My App" on iOS, com.getcapacitor.myapp +
// com.getcapacitor.app on Android) survive into the generated tree unless
// somebody edits them. `cap sync` never rewrites them either, so drift between
// them and capacitor.config.ts / package.json is invisible until a store
// rejects the upload. Asserted here, for both platforms.
{
  const rootVersion = JSON.parse(
    readFileSync(resolve(repoRoot, "package.json"), "utf8"),
  ).version;
  const capConfig = readFileSync(resolve(repoRoot, "capacitor.config.ts"), "utf8");
  const appId = capConfig.match(/appId:\s*"([^"]+)"/)?.[1];
  const appName = capConfig.match(/appName:\s*"([^"]+)"/)?.[1];
  const PLACEHOLDERS = ["com.getcapacitor", "com.example"];

  /** Every identifier the file declares must equal `expected`. */
  const assertAll = (label, file, values, expected) => {
    const found = [...new Set(values)];
    if (expected && found.some((v) => v !== expected)) {
      fail(
        `${label} (${found.join(", ") || "nothing"}) disagrees with ${expected}.\n` +
          `  Edit ${file} — every build configuration in it.`,
      );
    }
  };

  if (platforms.includes("ios")) {
    const pbxPath = "ios/App/App.xcodeproj/project.pbxproj";
    const pbxproj = readFileSync(resolve(repoRoot, pbxPath), "utf8");
    const plistPath = "ios/App/App/Info.plist";
    const plist = readFileSync(resolve(repoRoot, plistPath), "utf8");

    const placeholder = PLACEHOLDERS.find((p) => pbxproj.includes(p));
    if (placeholder) {
      fail(
        `ios/ still carries the template identifier "${placeholder}". \`cap add\` does\n` +
          "  NOT write appId into the native project — set PRODUCT_BUNDLE_IDENTIFIER in\n" +
          "  BOTH the Debug and Release build configurations by hand.",
      );
    }
    assertAll(
      "PRODUCT_BUNDLE_IDENTIFIER",
      pbxPath,
      [...pbxproj.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/g)].map((m) =>
        m[1].trim(),
      ),
      appId,
    );
    assertAll(
      "MARKETING_VERSION",
      pbxPath,
      [...pbxproj.matchAll(/MARKETING_VERSION = ([^;]+);/g)].map((m) => m[1].trim()),
      rootVersion,
    );
    const displayName = plist
      .match(/<key>CFBundleDisplayName<\/key>\s*<string>([^<]*)<\/string>/)?.[1]
      ?.trim();
    if (appName && displayName !== appName) {
      fail(
        `CFBundleDisplayName (${displayName ?? "missing"}) disagrees with\n` +
          `  capacitor.config.ts appName (${appName}). Edit ${plistPath}.`,
      );
    }
    console.log(`    ios/ is ${appId} "${displayName}" ${rootVersion}`);
  }

  if (platforms.includes("android")) {
    const gradlePath = "android/app/build.gradle";
    const gradle = readFileSync(resolve(repoRoot, gradlePath), "utf8");

    const placeholder = PLACEHOLDERS.find((p) => gradle.includes(p));
    if (placeholder) {
      fail(
        `android/ still carries the template identifier "${placeholder}". \`cap add\`\n` +
          "  does NOT write appId into the native project — set BOTH `namespace` and\n" +
          `  \`applicationId\` in ${gradlePath} by hand.`,
      );
    }
    assertAll(
      "namespace",
      gradlePath,
      [...gradle.matchAll(/^\s*namespace\s*=?\s*["']([^"']+)["']/gm)].map((m) => m[1]),
      appId,
    );
    assertAll(
      "applicationId",
      gradlePath,
      [...gradle.matchAll(/^\s*applicationId\s*=?\s*["']([^"']+)["']/gm)].map(
        (m) => m[1],
      ),
      appId,
    );
    assertAll(
      "versionName",
      gradlePath,
      [...gradle.matchAll(/^\s*versionName\s*=?\s*["']([^"']+)["']/gm)].map((m) => m[1]),
      rootVersion,
    );
    // The launcher reads the activity's label, so title_activity_main is as
    // visible as app_name and has to carry the same home-screen name.
    const stringsPath = "android/app/src/main/res/values/strings.xml";
    const strings = readFileSync(resolve(repoRoot, stringsPath), "utf8");
    for (const key of ["app_name", "title_activity_main"]) {
      const value = strings
        .match(new RegExp(`<string name="${key}">([^<]*)</string>`))?.[1]
        ?.trim();
      if (appName && value !== appName) {
        fail(
          `${key} (${value ?? "missing"}) disagrees with\n` +
            `  capacitor.config.ts appName (${appName}). Edit ${stringsPath}.`,
        );
      }
    }
    console.log(`    android/ is ${appId} "${appName}" ${rootVersion}`);
  }
}

// 3d. The per-platform toolchains were resolved in step 2 — a platform is only
// in `platforms` if its toolchain answered.
if (platforms.length) {
  console.log(`    toolchain ready for ${platforms.join(", ")}`);
}

// 3e. Is anything listening on the baked API? A dead localhost port is nearly
// always a mistake, but a build machine legitimately may not reach a remote
// API — so this warns by default and only hard-fails under --require-api.
const port = Number(apiOrigin.port || (apiOrigin.protocol === "https:" ? 443 : 80));
const reachable = await new Promise((done) => {
  const socket = createConnection({ host: apiOrigin.hostname, port, timeout: 2500 });
  const settle = (value) => {
    socket.destroy();
    done(value);
  };
  socket.on("connect", () => settle(true));
  socket.on("error", () => settle(false));
  socket.on("timeout", () => settle(false));
});
if (reachable) {
  console.log(`    API reachable at ${apiOrigin.hostname}:${port}`);
} else if (requireApi) {
  fail(`Nothing is listening on ${apiOrigin.hostname}:${port} (--require-api).`);
} else {
  console.warn(
    `    WARNING: nothing is listening on ${apiOrigin.hostname}:${port} right now.\n` +
      `    The bundle will still be built against ${apiUrl} — make sure that is the\n` +
      "    port the API will actually be on when the app runs.",
  );
}

// ── 4. Build the export ──────────────────────────────────────────────

step(`Building the mobile export against ${apiUrl}`);

run("pnpm", ["build:client"], {
  // Its own output directory (see the header): never the web/E2E `out`.
  NEXT_DIST_DIR: MOBILE_OUT_DIR,
  NEXT_PUBLIC_API_URL: apiUrl,
});

// ── 5. Verify the artifact ───────────────────────────────────────────

step("Verifying the export");

if (!existsSync(join(outPath, "index.html"))) {
  fail(`No index.html in ${outPath} — the export did not land where expected.`);
}

function walk(dir, predicate, hits = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, predicate, hits);
    else if (predicate(full)) hits.push(full);
  }
  return hits;
}

const htmlFiles = walk(outPath, (f) => f.endsWith(".html"));
const relativeRefs = htmlFiles.filter((f) => readFileSync(f, "utf8").includes('"./_next'));
if (relativeRefs.length) {
  fail(
    'Emitted HTML references "./_next" — Capacitor resolves assets from the bundle\n' +
      "  root, so a relative prefix 404s on every route but /. Did an assetPrefix\n" +
      `  get into next.config.ts?\n${relativeRefs.slice(0, 5).map((f) => `    ${f}`).join("\n")}`,
  );
}
console.log(`    ${htmlFiles.length} HTML files, all root-absolute`);

const chunkDir = join(outPath, "_next/static/chunks");
const chunks = existsSync(chunkDir) ? walk(chunkDir, (f) => f.endsWith(".js")) : [];
const baked = chunks.some((f) => readFileSync(f, "utf8").includes(apiUrl));
if (!baked) {
  fail(
    `The literal ${apiUrl} does not appear in any emitted chunk.\n` +
      "  NEXT_PUBLIC_API_URL did not reach the client bundle — the app would fall\n" +
      "  back to its own origin (capacitor://localhost) on device.",
  );
}
console.log(`    ${apiUrl} is baked into the bundle`);

// A marker so a human (or a later script) can tell what these bytes are bound
// to without grepping a minified chunk.
writeFileSync(
  join(outPath, ".build-target.json"),
  `${JSON.stringify({ apiUrl, builtAt: new Date().toISOString(), platforms }, null, 2)}\n`,
);

// ── 6. Sync ──────────────────────────────────────────────────────────

for (const platform of platforms) {
  step(`Syncing ${platform}`);
  run("npx", ["cap", "sync", platform]);
}

// ios/App/CapApp-SPM/Package.swift is regenerated by every sync and IS tracked,
// so a diff there after a build is expected rather than a bug. Say so, because
// the alternative is somebody stashing it away.
if (platforms.includes("ios")) {
  const spmDiff = capture("git", ["status", "--porcelain", "ios/App/CapApp-SPM/Package.swift"]);
  if (spmDiff.ok && spmDiff.out.trim()) {
    console.log(
      "\n  Note: ios/App/CapApp-SPM/Package.swift changed — it is regenerated by every\n" +
        "  sync. Commit it when the plugin set changed; otherwise checkout it back.",
    );
  }
}

console.log(`\n  Mobile bundle ready — ${apiUrl} → ${platforms.join(", ") || "no platform"}\n`);
