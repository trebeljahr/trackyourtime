#!/usr/bin/env node
/*
 * Track Your Time's Linux smoke test (pnpm test:desktop:linux): build the
 * unpacked Linux app for the Docker daemon's architecture, then start it in a
 * container under Xvfb through the project-agnostic runner in
 * scripts/crossplat/linux-smoke.mjs. docs/cross-platform-testing.md.
 *
 *   pnpm test:desktop:linux                  # build, then smoke
 *   pnpm test:desktop:linux --reuse-export   # package the export already in out-desktop
 *   pnpm test:desktop:linux --skip-build     # smoke whatever release/ holds
 *
 * Safe for agents: nothing opens on the host's screen.
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

function fail(message) {
  console.error(`\n  test:desktop:linux — ${message}\n`);
  process.exit(1);
}

function run(command, cmdArgs, env = {}) {
  const result = spawnSync(command, cmdArgs, { cwd: repoRoot, stdio: "inherit", env: { ...process.env, ...env } });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// Asked first, so a missing daemon costs seconds rather than a whole build.
const info = spawnSync("docker", ["info", "--format", "{{.Architecture}}"], { encoding: "utf8" });
if (info.error) fail("no `docker` CLI on PATH (`brew install docker`, then `colima start`).");
if (info.status !== 0) fail("the Docker daemon is not reachable; start it with `colima start`.");
const arch = info.stdout.trim() === "aarch64" ? "arm64" : "x64";
// electron-builder names the x64 folder without an arch suffix.
const appDir = arch === "arm64" ? "release/linux-arm64-unpacked" : "release/linux-unpacked";

if (!args.includes("--skip-build")) {
  // No API is needed to boot to the login screen; a dead loopback port keeps
  // the build's API check honest without pointing a test at a real server.
  const env = process.env.NEXT_PUBLIC_API_URL ? {} : { NEXT_PUBLIC_API_URL: "http://127.0.0.1:59999" };
  const reuse = args.includes("--reuse-export") ? ["--reuse-export"] : [];
  run("node", ["scripts/build-desktop.mjs", ...reuse, "--package", "--linux", `--${arch}`, "--dir"], env);
}

run("node", [
  "scripts/crossplat/linux-smoke.mjs",
  "--app-dir", appDir,
  "--exec", "trackyourtime",
  "--expect-url-prefix", "app://-",
  // Not TRACKYOURTIME_HEADLESS: a never-shown window gives CDP no frames on
  // X11, and Xvfb is virtual, so a shown window reaches no real screen.
  "--env", "TRACKYOURTIME_USER_DATA_DIR=/tmp/trackyourtime-smoke",
  "--out", "test-results/linux-smoke",
]);
