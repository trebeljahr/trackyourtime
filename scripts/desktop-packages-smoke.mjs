#!/usr/bin/env node
/*
 * Track Your Time's PACKAGED Linux smoke test (pnpm test:desktop:packages):
 * take the .AppImage, .deb and .rpm a release actually ships and prove each one
 * installs and starts. The sibling of scripts/desktop-linux-smoke.mjs, which
 * runs an unpacked build and therefore never touches the packaging — the
 * desktop entry, the icon paths, the AppImage runtime, the declared
 * dependencies or the install scriptlets. Both drive the project-agnostic
 * runners in scripts/crossplat/. docs/cross-platform-testing.md.
 *
 *   pnpm test:desktop:packages                     # every package in release/
 *   pnpm test:desktop:packages --dir <dir>         # somewhere else, e.g. a `gh release download`
 *   pnpm test:desktop:packages <file>...           # exactly these
 *   pnpm test:desktop:packages --appimage-mode fuse
 *   pnpm test:desktop:packages --with-recommends   # plain `apt install ./x.deb`
 *
 * Only the Docker daemon's own architecture can be tested here, so a package
 * built for the other one is SKIPPED with a notice rather than emulated. Safe
 * for agents: nothing opens on the host's screen.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The architecture a release artifact is built for, from the name
 * electron-builder gives it: `-linux-arm64.AppImage` / `-linux-x86_64.AppImage`
 * (electron-builder.config.mjs `names.linux`), `_arm64.deb` / `_amd64.deb` and
 * `.aarch64.rpm` / `.x86_64.rpm`. Kept here rather than in scripts/crossplat/
 * because it is this project's naming, not a rule about packages.
 */
export function artifactArch(file) {
  const name = basename(String(file ?? "")).toLowerCase();
  if (/(^|[-_.])(arm64|aarch64)([-_.]|$)/.test(name)) return "aarch64";
  if (/(^|[-_.])(x86_64|amd64|x64)([-_.]|$)/.test(name)) return "x86_64";
  return null;
}

/** The packaged Linux artifacts in a directory, in a stable order. */
export function findPackages(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /\.(appimage|deb|rpm)$/i.test(name))
    .sort()
    .map((name) => join(dir, name));
}

/**
 * What to do with each artifact on a daemon of `daemonArch`. A package for the
 * other architecture is skipped: emulating it would test qemu rather than the
 * package, and the other architecture has its own runner in CI.
 */
export function planPackageRuns(files, daemonArch) {
  return files.map((file) => {
    const arch = artifactArch(file);
    if (arch === null) return { file, run: false, reason: "its architecture is not in the file name" };
    if (arch !== daemonArch) return { file, run: false, reason: `it is built for ${arch}, this Docker daemon runs ${daemonArch}` };
    return { file, run: true, arch };
  });
}

/** `test-results/linux-packages/<appimage|deb|rpm>-<arch>`, one per artifact. */
export function outDirFor(file) {
  const name = basename(file).toLowerCase();
  const kind = name.endsWith(".appimage") ? "appimage" : name.endsWith(".deb") ? "deb" : "rpm";
  return join("test-results", "linux-packages", `${kind}-${artifactArch(file) ?? "unknown"}`);
}

function fail(message) {
  console.error(`\n  test:desktop:packages — ${message}\n`);
  process.exit(1);
}

function main(argv) {
  const files = [];
  let dir = null;
  let appimageMode = null;
  let withRecommends = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dir") dir = argv[++i];
    else if (arg === "--appimage-mode") appimageMode = argv[++i];
    else if (arg === "--with-recommends") withRecommends = true;
    else if (arg.startsWith("--")) fail(`unknown option ${arg}`);
    else files.push(arg);
  }

  const info = spawnSync("docker", ["info", "--format", "{{.Architecture}}"], { encoding: "utf8" });
  if (info.error) fail("no `docker` CLI on PATH (`brew install docker`, then `colima start`).");
  if (info.status !== 0) fail("the Docker daemon is not reachable; start it with `colima start`.");
  const daemonArch = info.stdout.trim() === "aarch64" ? "aarch64" : "x86_64";

  const searched = resolve(repoRoot, dir ?? "release");
  const candidates = files.length ? files.map((file) => resolve(file)) : findPackages(searched);
  if (!candidates.length) {
    fail(
      `no .AppImage, .deb or .rpm in ${searched}. Build them (\`node scripts/build-desktop.mjs --package --linux --${daemonArch === "aarch64" ? "arm64" : "x64"}\`) ` +
        "or download a release's (`gh release download <tag> --dir <dir>`) and pass --dir.",
    );
  }
  for (const file of candidates) if (!existsSync(file)) fail(`${file} does not exist`);

  // The container has to be able to see the file, and the daemon shares only
  // some of the host: colima shares the home directory but not /tmp.
  for (const file of candidates) {
    if (!statSync(file).isFile()) fail(`${file} is not a file`);
  }

  const plan = planPackageRuns(candidates, daemonArch);
  const results = [];
  for (const step of plan) {
    const name = basename(step.file);
    if (!step.run) {
      console.log(`\n  SKIP ${name} — ${step.reason}`);
      results.push({ name, status: "skipped" });
      continue;
    }
    console.log(`\n${"=".repeat(72)}\n  ${name}\n${"=".repeat(72)}`);
    const args = [
      "scripts/crossplat/linux-package-smoke.mjs",
      "--package", step.file,
      "--expect-url-prefix", "app://-",
      // Not TRACKYOURTIME_HEADLESS: a never-shown window gives CDP no frames on
      // X11, and Xvfb is virtual, so a shown window reaches no real screen.
      "--env", "TRACKYOURTIME_USER_DATA_DIR=/tmp/trackyourtime-package-smoke",
      "--out", outDirFor(step.file),
    ];
    if (appimageMode) args.push("--appimage-mode", appimageMode);
    if (withRecommends) args.push("--with-recommends");
    const run = spawnSync("node", args, { cwd: repoRoot, stdio: "inherit" });
    results.push({ name, status: run.status === 0 ? "passed" : "failed" });
  }

  console.log(`\n${"=".repeat(72)}`);
  for (const result of results) console.log(`  ${result.status.toUpperCase().padEnd(8)} ${result.name}`);
  const failed = results.filter((result) => result.status === "failed");
  const ran = results.filter((result) => result.status !== "skipped");
  console.log(`${"=".repeat(72)}\n  ${ran.length - failed.length}/${ran.length} passed, ${results.length - ran.length} skipped\n`);
  process.exit(failed.length ? 1 : 0);
}

// Importable for its rules; only the CLI run touches Docker.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2));
}
