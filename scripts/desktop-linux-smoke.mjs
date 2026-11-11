#!/usr/bin/env node
/*
 * Track Your Time's Linux smoke test (pnpm test:desktop:linux): build the
 * unpacked Linux app for the Docker daemon's architecture, then start it in a
 * container under Xvfb through the project-agnostic runner in
 * scripts/crossplat/linux-smoke.mjs. docs/cross-platform-testing.md.
 *
 *   pnpm test:desktop:linux                  # build, then smoke
 *   pnpm test:desktop:linux --reuse-export   # build from the export already in out-desktop
 *   pnpm test:desktop:linux --skip-build     # smoke whatever release/ holds
 *
 * On Linux the app is built here (build-desktop.mjs --package --dir). On a Mac
 * there is no WebKitGTK to link against, so it is built in a container of the
 * daemon's own architecture (scripts/desktop/linux-build.Dockerfile), from the
 * export built on the host, into desktop/target/linux-docker/.
 *
 * The app runs in its smoke mode (TRACKYOURTIME_SMOKE_REPORT, which release
 * builds honour too): it loads, waits for its page, writes a report and
 * exits. A WebKitGTK app has no CDP to drive, so that report is the verdict.
 * Not TRACKYOURTIME_HEADLESS: a window that is never shown paints nothing on
 * X11, and Xvfb is virtual, so a shown window reaches no real screen.
 *
 * Safe for agents: nothing opens on the host's screen.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SMOKE_REPORT_ENV } from "./lib/desktop-tauri.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

function fail(message) {
  console.error(`\n  test:desktop:linux — ${message}\n`);
  process.exit(1);
}

function run(command, cmdArgs, env = {}) {
  const result = spawnSync(command, cmdArgs, { cwd: repoRoot, stdio: "inherit", env: { ...process.env, ...env } });
  if (result.error) fail(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// Asked first, so a missing daemon costs seconds rather than a whole build.
const info = spawnSync("docker", ["info", "--format", "{{.Architecture}}"], { encoding: "utf8" });
if (info.error) fail("no `docker` CLI on PATH (`brew install docker`, then `colima start`).");
if (info.status !== 0) fail("the Docker daemon is not reachable; start it with `colima start`.");
const arch = ["aarch64", "arm64"].includes(info.stdout.trim()) ? "arm64" : "x64";
const appDir = resolve(repoRoot, arch === "arm64" ? "release/linux-arm64-unpacked" : "release/linux-unpacked");

if (!args.includes("--skip-build")) {
  // No API is needed to boot to the login screen; a dead loopback port keeps
  // the build's API check honest without pointing a test at a real server.
  const env = process.env.NEXT_PUBLIC_API_URL ? {} : { NEXT_PUBLIC_API_URL: "http://127.0.0.1:59999" };
  const reuse = args.includes("--reuse-export");
  if (process.platform === "linux") {
    run("node", ["scripts/build-desktop.mjs", ...(reuse ? ["--reuse-export"] : []), "--package", "--dir"], env);
  } else {
    if (!reuse) run("node", ["scripts/build-desktop.mjs", "--export-only"], env);
    const image = "trackyourtime-linux-build:1";
    run("docker", ["build", "-q", "-t", image, "-f", join(repoRoot, "scripts/desktop/linux-build.Dockerfile"), join(repoRoot, "scripts/desktop")]);
    // The target and the cargo cache live in the checkout (desktop/target is
    // ignored), owned by the caller: colima shares the home directory with
    // the VM, and a root-owned target would outlive the run.
    const cache = join(repoRoot, "desktop/target/linux-docker");
    mkdirSync(join(cache, "cargo-home"), { recursive: true });
    // prettier-ignore
    run("docker", [
      "run", "--rm", "--user", `${process.getuid()}:${process.getgid()}`,
      "-e", "HOME=/tmp", "-e", "CARGO_HOME=/work/desktop/target/linux-docker/cargo-home",
      "-e", "CARGO_TARGET_DIR=/work/desktop/target/linux-docker/target",
      "-v", `${repoRoot}:/work`, "-w", "/work",
      image, "cargo", "build", "--release", "--locked", "--manifest-path", "desktop/src-tauri/Cargo.toml",
    ]);
    mkdirSync(appDir, { recursive: true });
    // cargo's own name; `tauri build` would rename it to the Linux mainBinaryName.
    copyFileSync(join(cache, "target/release/trackyourtime-desktop"), join(appDir, "trackyourtime"));
  }
}
if (!existsSync(join(appDir, "trackyourtime"))) fail(`no ${join(appDir, "trackyourtime")}; build first (drop --skip-build).`);

run("node", [
  "scripts/crossplat/linux-smoke.mjs",
  "--app-dir", appDir,
  "--exec", "trackyourtime",
  "--mode", "report",
  "--report-env", SMOKE_REPORT_ENV,
  "--expect-url-prefix", "app://-",
  "--env", "TRACKYOURTIME_USER_DATA_DIR=/tmp/trackyourtime-smoke",
  "--out", "test-results/linux-smoke",
]);
