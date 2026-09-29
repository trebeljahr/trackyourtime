#!/usr/bin/env node
/*
 * Linux smoke test for ONE PACKAGED artifact — a .AppImage, .deb or .rpm — in
 * Docker, headless. The sibling of linux-smoke.mjs, which takes an unpacked
 * build and therefore never exercises the packaging itself: the desktop entry,
 * the icon paths, the AppImage runtime, the declared dependencies and the
 * install scriptlets. Project-agnostic: see README.md in this folder.
 *
 *   node scripts/crossplat/linux-package-smoke.mjs \
 *     --package release/myapp_1.2.3_arm64.deb \
 *     [--expect-url-prefix app://-] [--exec /opt/My App/myapp] \
 *     [--appimage-mode extract|fuse] [--with-recommends] \
 *     [--env KEY=VALUE]... [--arg --flag]... \
 *     [--settle-ms 5000] [--timeout-ms 90000] [--out <dir>]
 *
 * Each kind is installed the way a person installs it, in an image that carries
 * only the test harness:
 *
 *   .deb  — `apt-get install ./file.deb` on Debian, so Depends is resolved for
 *           real. A missing dependency fails the install.
 *   .rpm  — `dnf install ./file.rpm` on Fedora, same reason.
 *   .AppImage — unpacked with its own `--appimage-extract` and started from the
 *           AppDir, because a container has no /dev/fuse. `--appimage-mode
 *           fuse` tests the mounting path instead and adds the device for it.
 *
 * It then reads the installed desktop entry, checks its Exec and Icon resolve,
 * and hands the program to ../linux-smoke/probe.mjs — the same CDP attach,
 * settle, screenshot and still-running check the unpacked smoke uses. Leaves
 * install.json, result.json, screenshot.png and app.log in --out.
 *
 * Needs a `docker` CLI talking to a daemon of the same architecture as the
 * package, and the package must sit under a path that daemon shares with the
 * host. Safe for agents and CI: nothing opens on the host's screen.
 */
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  APPIMAGE_MODES,
  appimageDockerFlags,
  archMatches,
  dockerfileFor,
  imageTagFor,
  normalizeArch,
  packageKind,
} from "./linux-package-smoke/package-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));

export function fail(message) {
  console.error(`\n  linux-package-smoke — ${message}\n`);
  process.exit(1);
}

/**
 * The same flag grammar as linux-smoke.mjs, plus the flags a packaged artifact
 * needs. `--with-recommends` is a bare switch; everything else takes a value.
 */
export function parsePackageSmokeArgs(argv) {
  const opts = {
    env: [],
    arg: [],
    expectUrlPrefix: "",
    settleMs: "5000",
    // Longer than the unpacked runner's default: an install runs first.
    timeoutMs: "90000",
    appimageMode: "extract",
    withRecommends: false,
    exec: "",
    out: null,
    package: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith("--")) return { error: `unexpected argument ${key}` };
    const name = key.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase());
    if (name === "withRecommends") {
      opts.withRecommends = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) return { error: `${key} needs a value` };
    if (name === "env" || name === "arg") opts[name].push(value);
    else if (Object.hasOwn(opts, name)) opts[name] = value;
    else return { error: `unknown option ${key}` };
    i++;
  }
  if (!opts.package) return { error: "--package is required" };
  if (!APPIMAGE_MODES.includes(opts.appimageMode)) {
    return { error: `--appimage-mode must be one of ${APPIMAGE_MODES.join(", ")}` };
  }
  return { opts };
}

/** e_machine of an ELF binary, as Docker names the architecture. */
export function elfArch(file) {
  const fd = openSync(file, "r");
  const header = Buffer.alloc(20);
  try {
    readSync(fd, header, 0, 20, 0);
  } finally {
    closeSync(fd);
  }
  if (header.readUInt32BE(0) !== 0x7f454c46) return null;
  const machine = header.readUInt16LE(18);
  return machine === 0xb7 ? "aarch64" : machine === 0x3e ? "x86_64" : `elf-machine-${machine}`;
}

function docker(args, options = {}) {
  return spawnSync("docker", args, { encoding: "utf8", ...options });
}

/** The `docker build` arguments for one kind's image. */
export function buildArgsFor(kind, crossplatDir) {
  const image = imageTagFor(kind);
  const source = dockerfileFor(kind);
  const context = join(crossplatDir, source.context);
  const file = source.dockerfile ? ["-f", join(context, source.dockerfile)] : [];
  return ["build", "-q", "-t", image, ...file, context];
}

function main(argv) {
  const parsed = parsePackageSmokeArgs(argv);
  if (parsed.error) fail(parsed.error);
  const opts = parsed.opts;

  const pkgPath = resolve(opts.package);
  if (!existsSync(pkgPath)) fail(`${pkgPath} does not exist`);
  const kind = packageKind(pkgPath);
  if (!kind) fail(`${basename(pkgPath)} is not a .AppImage, .deb or .rpm`);

  const info = docker(["info", "--format", "{{.Architecture}}"]);
  if (info.error) {
    fail("no `docker` CLI on PATH. Install one (`brew install docker`) and a daemon (`colima start`, OrbStack or Docker Desktop).");
  }
  if (info.status !== 0) fail(`the Docker daemon is not reachable (start it: \`colima start\`):\n    ${info.stderr.trim()}`);
  const daemonArch = normalizeArch(info.stdout);

  // An AppImage is an ELF file, so the wrong architecture costs nothing to spot
  // here. A .deb or .rpm is read by its own tool inside the container instead.
  if (kind === "appimage") {
    const appArch = elfArch(pkgPath);
    if (appArch === null) fail(`${basename(pkgPath)} is not an ELF executable; is it really an AppImage?`);
    if (!archMatches(appArch, daemonArch)) {
      fail(`${basename(pkgPath)} is built for ${appArch}, the Docker daemon runs ${daemonArch}; test that one on a ${appArch} machine`);
    }
  }

  const image = imageTagFor(kind);
  console.log(`\n  Building ${image} (cached after the first run)`);
  const build = docker(buildArgsFor(kind, here), { stdio: ["ignore", "ignore", "inherit"] });
  if (build.status !== 0) fail(`docker build failed for ${image}`);

  const out = resolve(opts.out ?? join(process.cwd(), "test-results", "linux-package-smoke"));
  mkdirSync(out, { recursive: true });
  // A run that dies before writing must not report the previous run's verdict.
  for (const name of ["install.json", "result.json", "screenshot.png", "app.log"]) rmSync(join(out, name), { force: true });

  const envFlags = opts.env.flatMap((pair) => ["-e", pair]);
  console.log(`  Installing and running ${basename(pkgPath)} under Xvfb (${kind}, ${daemonArch})`);
  const run = docker(
    [
      "run", "--rm", "--init", "--shm-size=1g",
      // Root, because installing a package needs to be. The installer gives the
      // output directory back to this user before it exits.
      "-e", "HOME=/tmp",
      "-e", `SMOKE_PACKAGE=/pkg/${basename(pkgPath)}`,
      "-e", `SMOKE_APPIMAGE_MODE=${opts.appimageMode}`,
      "-e", `SMOKE_WITH_RECOMMENDS=${opts.withRecommends ? "1" : "0"}`,
      "-e", `SMOKE_EXEC_OVERRIDE=${opts.exec}`,
      "-e", `SMOKE_OUT_UID=${process.getuid?.() ?? 0}`,
      "-e", `SMOKE_OUT_GID=${process.getgid?.() ?? 0}`,
      "-e", `SMOKE_ARGS=${JSON.stringify(opts.arg)}`,
      "-e", `SMOKE_EXPECT_URL_PREFIX=${opts.expectUrlPrefix}`,
      "-e", `SMOKE_SETTLE_MS=${opts.settleMs}`,
      "-e", `SMOKE_TIMEOUT_MS=${opts.timeoutMs}`,
      ...envFlags,
      ...(kind === "appimage" ? appimageDockerFlags(opts.appimageMode) : []),
      "-v", `${dirname(pkgPath)}:/pkg:ro`,
      "-v", `${join(here, "linux-package-smoke")}:/crossplat-package:ro`,
      "-v", `${join(here, "linux-smoke")}:/crossplat-smoke:ro`,
      "-v", `${out}:/out`,
      image, "node", "/crossplat-package/install.mjs",
    ],
    { stdio: "inherit" },
  );

  const installFile = join(out, "install.json");
  if (existsSync(installFile)) {
    const installed = JSON.parse(readFileSync(installFile, "utf8"));
    console.log(`\n  package:  ${installed.package} (${installed.kind}, ${installed.packageArch})`);
    if (installed.appimageMode) console.log(`  appimage: ${installed.appimageMode}`);
    console.log(`  desktop:  ${installed.desktopFile ?? "none"}`);
    console.log(`  icon:     ${installed.icon?.path ?? installed.icon?.value ?? "none"}`);
    console.log(`  program:  ${installed.exec ?? "none"}`);
  }
  const resultFile = join(out, "result.json");
  if (existsSync(resultFile)) {
    const result = JSON.parse(readFileSync(resultFile, "utf8"));
    console.log(`  url:      ${result.url}\n  title:    ${result.title}`);
    if (result.consoleErrors.length) {
      console.log(`  console errors (${result.consoleErrors.length}):\n    ${result.consoleErrors.slice(0, 5).join("\n    ")}`);
    }
  }
  console.log(`  screenshot: ${join(out, "screenshot.png")}\n  app log:    ${join(out, "app.log")}\n`);
  process.exit(run.status ?? 1);
}

// Importable for its rules; only the CLI run touches Docker.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2));
}
