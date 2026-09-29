/*
 * Runs INSIDE a linux-package-smoke container (see ../linux-package-smoke.mjs,
 * which mounts the package at /pkg, this folder at /crossplat-package, the
 * unpacked runner's probe at /crossplat-smoke and the output at /out).
 *
 * Installs ONE packaged Linux artifact the way a person would — apt for a .deb,
 * dnf for an .rpm, the AppImage's own runtime for an .AppImage — then reads the
 * installed desktop entry to find the program and its icon, and hands that
 * program to the unpacked runner's probe, which drives it over CDP and takes
 * the screenshot. Writes /out/install.json; the probe writes /out/result.json.
 *
 * Runs as root, because installing a package needs to. The output directory is
 * given back to SMOKE_OUT_UID:SMOKE_OUT_GID at the end so the files a bind
 * mount leaves on the host are the caller's, not root's.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  chownSync,
  closeSync,
  copyFileSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import {
  archMatches,
  desktopExecPath,
  iconLookup,
  installCommand,
  normalizeArch,
  packageKind,
  parseDesktopEntry,
} from "./package-lib.mjs";

const pkgFile = process.env.SMOKE_PACKAGE ?? "";
const appimageMode = process.env.SMOKE_APPIMAGE_MODE === "fuse" ? "fuse" : "extract";
const withRecommends = process.env.SMOKE_WITH_RECOMMENDS === "1";
const execOverride = process.env.SMOKE_EXEC_OVERRIDE ?? "";
const outUid = Number(process.env.SMOKE_OUT_UID ?? "0");
const outGid = Number(process.env.SMOKE_OUT_GID ?? "0");

const install = {
  ok: false,
  kind: null,
  package: basename(pkgFile),
  packageArch: null,
  hostArch: normalizeArch(spawnSync("uname", ["-m"], { encoding: "utf8" }).stdout ?? ""),
  appimageMode: null,
  withRecommends,
  installedFiles: 0,
  desktopFile: null,
  desktopEntry: null,
  exec: null,
  icon: null,
  problem: null,
};

/** Give /out back to the caller, so root does not own the results on the host. */
function releaseOutput() {
  if (!outUid) return;
  for (const name of readdirSync("/out")) {
    try {
      chownSync(join("/out", name), outUid, outGid);
    } catch {
      // A file the probe is still writing is not worth failing the run over.
    }
  }
  try {
    chownSync("/out", outUid, outGid);
  } catch {
    // The mount point itself may not be ours to change.
  }
}

function writeInstall() {
  writeFileSync("/out/install.json", `${JSON.stringify(install, null, 2)}\n`);
}

function fail(problem) {
  install.problem = problem;
  install.ok = false;
  writeInstall();
  console.error(`\n  install — ${problem}\n`);
  releaseOutput();
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
}

/** A step whose output belongs in the log the person reads on a failure. */
function runLoud(command, args, what, options = {}) {
  console.log(`\n  $ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) fail(`${what} could not start: ${result.error.message}`);
  if (result.status !== 0) fail(`${what} failed (exit ${result.status}); its own output is above`);
}

/** The first 20 bytes of a file, without reading the rest of a 100 MB package. */
function elfHeader(file) {
  const header = Buffer.alloc(20);
  const fd = openSync(file, "r");
  try {
    readSync(fd, header, 0, 20, 0);
  } finally {
    closeSync(fd);
  }
  return header;
}

if (!pkgFile) fail("SMOKE_PACKAGE is not set");
if (!existsSync(pkgFile)) {
  fail(
    `${pkgFile} is not visible inside the container. The artifact has to sit under a path the Docker ` +
      "daemon shares with the host — colima shares the home directory but not /tmp, and Docker Desktop " +
      "shares what its Settings → Resources → File sharing lists.",
  );
}
const kind = packageKind(pkgFile);
install.kind = kind;
if (!kind) fail(`${basename(pkgFile)} is not a .AppImage, .deb or .rpm`);

/* ---------- the package's own architecture, read with its own tool ---------- */

if (kind === "deb") {
  const field = run("dpkg-deb", ["-f", pkgFile, "Architecture"]);
  if (field.status !== 0) fail(`dpkg-deb could not read ${basename(pkgFile)}: ${field.stderr.trim()}`);
  install.packageArch = normalizeArch(field.stdout);
} else if (kind === "rpm") {
  const field = run("rpm", ["-qp", "--nosignature", "--qf", "%{ARCH}", pkgFile]);
  if (field.status !== 0) fail(`rpm could not read ${basename(pkgFile)}: ${field.stderr.trim()}`);
  install.packageArch = normalizeArch(field.stdout);
} else {
  // An AppImage is an ELF executable with a squashfs image appended.
  const header = elfHeader(pkgFile);
  if (header.readUInt32BE(0) !== 0x7f454c46) fail(`${basename(pkgFile)} is not an ELF executable`);
  const machine = header.readUInt16LE(18);
  install.packageArch = machine === 0xb7 ? "aarch64" : machine === 0x3e ? "x86_64" : `elf-machine-${machine}`;
}
if (!archMatches(install.packageArch, install.hostArch)) {
  fail(
    `${basename(pkgFile)} is built for ${install.packageArch} and this container runs ${install.hostArch}. ` +
      "Only the Docker daemon's own architecture can be tested; the other one belongs on a runner of that architecture.",
  );
}

/* ---------------------------- install it for real --------------------------- */

/** Files the package put on disk, so the desktop entry is found rather than guessed. */
let installedFiles = [];
let appDir = null;
/** The chmod +x copy an AppImage is actually started from in `fuse` mode. */
let fuseTarget = null;

if (kind === "deb") {
  const name = run("dpkg-deb", ["-f", pkgFile, "Package"]).stdout.trim();
  if (!name) fail("the .deb declares no Package name");
  runLoud("apt-get", ["update"], "apt-get update");
  runLoud(...splitCommand(installCommand(kind, pkgFile, { recommends: withRecommends })), "the .deb install");
  installedFiles = run("dpkg", ["-L", name]).stdout.split("\n").map((line) => line.trim()).filter(Boolean);
} else if (kind === "rpm") {
  const name = run("rpm", ["-qp", "--nosignature", "--qf", "%{NAME}", pkgFile]).stdout.trim();
  if (!name) fail("the .rpm declares no NAME");
  runLoud(...splitCommand(installCommand(kind, pkgFile, { recommends: withRecommends })), "the .rpm install");
  installedFiles = run("rpm", ["-ql", name]).stdout.split("\n").map((line) => line.trim()).filter(Boolean);
} else {
  install.appimageMode = appimageMode;
  // A downloaded AppImage is not executable and /pkg is mounted read-only, so
  // copy it somewhere writable and `chmod +x` — which is the step the AppImage
  // instructions give a person, and part of what is being tested.
  const runnable = join("/tmp", basename(pkgFile));
  copyFileSync(pkgFile, runnable);
  chmodSync(runnable, 0o755);
  if (appimageMode === "extract") {
    // The AppImage runtime cannot mount itself without /dev/fuse, so unpack it
    // with its own flag instead. This is what --appimage-extract-and-run does.
    runLoud(runnable, ["--appimage-extract"], "the AppImage extraction", { cwd: "/tmp" });
    appDir = "/tmp/squashfs-root";
    if (!existsSync(appDir)) fail("--appimage-extract wrote no squashfs-root");
    installedFiles = readdirSync(appDir).map((name) => join(appDir, name));
  } else {
    // The mounting path, which needs the FUSE device the runner adds for it.
    appDir = null;
    installedFiles = [];
    fuseTarget = runnable;
  }
}
install.installedFiles = installedFiles.length;

/** `installCommand` returns one array; spawn wants the program and its arguments apart. */
function splitCommand(command) {
  return [command[0], command.slice(1)];
}

/* -------------------- the desktop entry, icon and program ------------------- */

function findDesktopFile() {
  const fromPackage = installedFiles.filter((file) => file.endsWith(".desktop") && existsSync(file));
  if (fromPackage.length) return fromPackage[0];
  // An extracted AppDir keeps its entry at the root; a fuse run has no listing.
  for (const root of [appDir, "/usr/share/applications"]) {
    if (!root || !existsSync(root)) continue;
    const hit = readdirSync(root).find((name) => name.endsWith(".desktop"));
    if (hit) return join(root, hit);
  }
  return null;
}

const desktopFile = findDesktopFile();
if (desktopFile) {
  install.desktopFile = desktopFile;
  const entry = parseDesktopEntry(readFileSync(desktopFile, "utf8"));
  install.desktopEntry = entry;
  const icon = iconLookup(entry.Icon);
  install.icon = { value: entry.Icon ?? null, path: null, found: false };
  if (icon.absolute) {
    install.icon.path = icon.absolute;
    install.icon.found = existsSync(icon.absolute);
  } else if (icon.names.length) {
    const roots = [appDir, "/usr/share/icons", "/usr/share/pixmaps", appDir && join(appDir, "usr/share/icons")].filter(
      Boolean,
    );
    const hit = findFirst(roots, icon.names);
    install.icon.path = hit;
    install.icon.found = hit !== null;
  }
} else if (kind !== "appimage" || appimageMode !== "fuse") {
  // A deb or rpm with no desktop entry has nothing for a launcher to show.
  fail("the package installed no .desktop file, so no launcher can start it");
}

/** The first of `names` anywhere under one of `roots`, or null. */
function findFirst(roots, names) {
  const queue = [...roots];
  const wanted = new Set(names);
  let budget = 20000;
  while (queue.length && budget-- > 0) {
    const dir = queue.shift();
    let items = [];
    try {
      items = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const item of items) {
      const full = join(dir, item.name);
      if (item.isDirectory()) queue.push(full);
      else if (wanted.has(item.name)) return full;
    }
  }
  return null;
}

/**
 * What to start. The desktop entry's own Exec is the honest answer for a deb or
 * an rpm: it is the line a launcher runs, so a wrong path there is exactly the
 * packaging bug worth catching. An extracted AppImage starts at its AppRun.
 */
function resolveExec() {
  if (execOverride) return execOverride;
  if (kind === "appimage") {
    if (appimageMode === "fuse") return fuseTarget;
    const appRun = join(appDir, "AppRun");
    if (existsSync(appRun)) return appRun;
    const fromEntry = desktopExecPath(install.desktopEntry?.Exec);
    if (fromEntry) return fromEntry.startsWith("/") ? fromEntry : join(appDir, fromEntry);
    return null;
  }
  return desktopExecPath(install.desktopEntry?.Exec);
}

const execPath = resolveExec();
if (!execPath) fail(`no program to start: the desktop entry's Exec is ${JSON.stringify(install.desktopEntry?.Exec)}`);
install.exec = execPath;
if (!existsSync(execPath)) fail(`the desktop entry points at ${execPath}, which the package did not install`);
try {
  const mode = statSync(execPath).mode;
  if (!(mode & 0o111)) fail(`${execPath} is not executable (mode ${(mode & 0o777).toString(8)})`);
} catch (err) {
  fail(`${execPath} cannot be inspected: ${String(err)}`);
}
if (install.icon && !install.icon.found) {
  fail(`the desktop entry's Icon=${install.icon.value} matches no installed icon file`);
}

install.ok = true;
writeInstall();
console.log(`\n  installed ${install.package} (${install.kind}, ${install.packageArch})`);
console.log(`  desktop entry: ${install.desktopFile ?? "none"}`);
console.log(`  icon:          ${install.icon?.path ?? "none"}`);
console.log(`  program:       ${install.exec}`);

/* --------- hand the installed program to the unpacked runner's probe -------- */

// Reused byte-for-byte from ../linux-smoke/probe.mjs: the CDP attach, the page
// wait, the settle, the screenshot and the still-running check are one
// implementation, so the packaged and unpacked smokes cannot drift apart.
const probe = spawn("node", ["/crossplat-smoke/probe.mjs"], {
  stdio: "inherit",
  env: { ...process.env, SMOKE_EXEC: execPath, HOME: process.env.HOME ?? "/tmp" },
  cwd: dirname(execPath),
});
probe.on("exit", (code, signal) => {
  releaseOutput();
  process.exit(code ?? (signal ? 1 : 1));
});
