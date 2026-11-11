#!/usr/bin/env node
// Ephemeral native CI only (installed-desktop-qa.yml). Installs an Electron
// release exactly as a person did, lets ITS OWN updater (electron-updater)
// update it to a Tauri release through the legacy feed that release publishes,
// and checks that what is installed afterwards is the Tauri app, in the same
// profile, and that it starts. This is the migration every Electron install
// (≤ LAST_ELECTRON_RELEASE) goes through, so it is tested end to end on the
// OSes where it runs: Windows (the NSIS hook removes the Electron install) and
// Linux (electron-updater replaces the AppImage file).
//
// Before publication only the old install's feed configuration is changed: a
// loopback server serves the unmodified draft feed and the signed bytes. The
// new app is judged by its smoke mode (TRACKYOURTIME_SMOKE_REPORT), because a
// WebKit app has no CDP; the old Electron app is still driven over CDP.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, writeFile, chmod, stat, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

import { artifactName, electronUninstallKeys, LAST_ELECTRON_RELEASE, LEGACY_FEED_FILES } from "./lib/desktop-release.mjs";
import { SMOKE_REPORT_ENV } from "./lib/desktop-tauri.mjs";

assert.equal(process.env.GITHUB_ACTIONS, "true", "Run only on disposable GitHub runners");
const from = process.env.QA_FROM ?? LAST_ELECTRON_RELEASE;
const to = process.env.QA_TO;
for (const version of [from, to]) assert.match(version ?? "", /^\d+\.\d+\.\d+$/);
assert.notEqual(from, to);
const atOrBefore = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return true;
};
// A Tauri release build has no remote control: its updater checks by itself
// 30 seconds after launch and installs when the person quits, and nothing
// outside the app can ask it to do either. Tauri → Tauri is covered by the
// updater's own tests and the e2e harness's update hooks, not here.
assert.ok(atOrBefore(from, LAST_ELECTRON_RELEASE), `QA_FROM ${from} is a Tauri release; this QA installs an Electron one (≤ ${LAST_ELECTRON_RELEASE}).`);
assert.ok(!atOrBefore(to, LAST_ELECTRON_RELEASE), `QA_TO ${to} is an Electron release; this QA updates to a Tauri one.`);
const windows = process.platform === "win32";
assert.ok(windows || process.platform === "linux");
const publicFeed = process.env.QA_PUBLIC_FEED === "true";
const out = resolve("test-results/installed-desktop");
const profile = join(out, "profile");
const oldDir = join(out, "downloads/old");
const newDir = join(out, "downloads/new");
await mkdir(profile, { recursive: true });
await mkdir(oldDir, { recursive: true });
await mkdir(newDir, { recursive: true });
const result = { from, to, platform: process.platform, arch: process.arch, publicFeed, assets: [], ok: false, unverified: [] };
const children = new Set();
const logs = [];
let browser;
let activePage;
let server;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (file, args, options = {}) => execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
const hash = async (file) => createHash("sha256").update(await readFile(file)).digest("hex");
async function until(fn, label, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await pause(500);
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ""}`);
}
function start(file, args, env = {}) {
  const child = spawn(file, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  child.stdout.on("data", (chunk) => logs.push(chunk.toString()));
  child.stderr.on("data", (chunk) => logs.push(chunk.toString()));
  child.on("error", (error) => logs.push(String(error)));
  child.on("exit", () => children.delete(child));
  return child;
}
async function download(version, dir, names) {
  try {
    run("gh", ["release", "download", `v${version}`, "--dir", dir, ...["SHA256SUMS.txt", ...names].flatMap((name) => ["--pattern", name])]);
  } catch (error) {
    if (version !== to || publicFeed || !String(error.stderr).includes("release not found")) throw error;
    const sourceRun = process.env.QA_SOURCE_RUN;
    assert.match(sourceRun ?? "", /^\d+$/);
    const source = JSON.parse(run("gh", ["run", "view", sourceRun, "--json", "headSha,headBranch,conclusion,workflowName"]));
    const tagSha = run("gh", ["api", `repos/${process.env.GITHUB_REPOSITORY}/commits/v${version}`, "--jq", ".sha"]).trim();
    assert.equal(source.headSha, tagSha, "Build artifacts must come from the exact release tag");
    assert.equal(source.workflowName, "Desktop Release");
    assert.equal(source.conclusion, "success");
    const artifact = windows ? "desktop-win-signed" : `desktop-linux-${process.arch === "arm64" ? "arm64" : "x64"}-unsigned`;
    run("gh", ["run", "download", sourceRun, "--name", artifact, "--dir", dir]);
    // Captured directly from the existing draft, never derived from the
    // fallback artifacts themselves. Any changed/mismatched byte fails QA.
    const expected = join(dirname(fileURLToPath(import.meta.url)), "fixtures/releases", `v${version}.sha256`);
    await writeFile(join(dir, "SHA256SUMS.txt"), await readFile(expected));
    result.artifactSource = { run: sourceRun, artifact, commit: source.headSha };
  }
  const checksums = await readFile(join(dir, "SHA256SUMS.txt"), "utf8");
  for (const name of names.filter((name) => /\.(exe|AppImage|deb|rpm)$/.test(name))) {
    const line = checksums.split("\n").find((line) => line.trim().endsWith(name));
    assert.ok(line, `Missing checksum: ${name}`);
    const actual = await hash(join(dir, name));
    assert.equal(actual, line.split(/\s+/)[0], `Checksum: ${name}`);
    result.assets.push({ name, sha256: actual });
  }
}
const arch = process.arch === "arm64" ? "arm64" : "x64";
// The Electron installer carried both Windows architectures; the Tauri one the
// legacy feed names is the x64 installer (legacyFeedNames).
const filename = (version) => (windows ? artifactName("nsis", { version, arch: "x64" }) : artifactName("appimage", { version, arch }));
const oldFile = join(oldDir, filename(from));
const feed = windows ? LEGACY_FEED_FILES.win : LEGACY_FEED_FILES[`linux-${arch}`];
async function connect(port) {
  await until(async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).ok, "CDP endpoint");
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = await until(() => browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith("app://-")), "app page");
  activePage = page;
  page.on("pageerror", (error) => {
    result.pageErrors ??= [];
    result.pageErrors.push(String(error));
  });
  await page.waitForFunction(() => !!window.electronAPI?.desktop?.updates);
  // The shell first paints /app, then redirects a fresh profile to /login.
  await page.getByRole("heading", { name: "Log in", exact: true }).waitFor({ state: "visible", timeout: 60_000 });
  return page;
}
async function stopInstalled() {
  await browser?.close().catch(() => {});
  browser = undefined;
  if (windows) {
    // The runner owns every process with this exact product name.
    run("pwsh", ["-NoProfile", "-Command", "Get-Process -Name 'Track Your Time' -ErrorAction SilentlyContinue | Stop-Process -Force; exit 0"]);
  } else {
    for (const child of children) if (child.spawnfile !== "Xvfb" && child.spawnfile !== "dbus-daemon") child.kill("SIGKILL");
    try {
      run("pkill", ["-x", "trackyourtime"], { stdio: "ignore" });
    } catch (error) {
      if (error.status !== 1) throw error;
    }
  }
}
/** Start the installed Tauri app in its smoke mode and read its verdict. */
async function smoke(executable, env) {
  const reportPath = join(out, "tauri-report.json");
  await rm(reportPath, { force: true });
  const child = start(executable, [], { ...env, [SMOKE_REPORT_ENV]: reportPath, TRACKYOURTIME_HEADLESS: "0" });
  const code = await new Promise((done) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done("timeout");
    }, 120_000);
    child.once("exit", (exitCode) => {
      clearTimeout(timer);
      done(exitCode);
    });
  });
  assert.ok(existsSync(reportPath), `The Tauri app wrote no smoke report (exit ${code})`);
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  result.tauriReport = report;
  assert.equal(code, 0, `The Tauri app's smoke run exited with ${code}`);
  assert.equal(report.ok, true, "The Tauri app's smoke report says ok: false");
  assert.equal(report.bridge, true, "The desktop bridge was not installed");
  return report;
}
try {
  await download(from, oldDir, [filename(from)]);
  const extras = windows
    ? [artifactName("nsis", { version: to, arch: "arm64" })]
    : [artifactName("deb", { version: to, arch }), artifactName("rpm", { version: to, arch })];
  await download(to, newDir, [filename(to), feed, ...extras]);
  if (publicFeed) assert.equal(run("gh", ["release", "view", `v${to}`, "--json", "isDraft", "--jq", ".isDraft"]).trim(), "false");
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  const installed = join(out, "installed");
  let executable;
  let resources;
  if (windows) {
    for (const file of [oldFile, join(newDir, filename(to))]) {
      const escaped = file.replaceAll("'", "''");
      const status = run("pwsh", ["-NoProfile", "-Command", `(Get-AuthenticodeSignature -LiteralPath '${escaped}').Status.ToString()`]).trim();
      assert.equal(status, "Valid", `Authenticode: ${basename(file)}`);
    }
    const escaped = oldFile.replaceAll("'", "''");
    const dest = installed.replaceAll("'", "''");
    run("pwsh", ["-NoProfile", "-Command", `$p = Start-Process -FilePath '${escaped}' -ArgumentList '/S','/D=${dest}' -Wait -PassThru; exit $p.ExitCode`]);
    executable = join(installed, "Track Your Time.exe");
    resources = join(installed, "resources");
  } else {
    start("Xvfb", [":99", "-screen", "0", "1280x800x24", "-nolisten", "tcp"]);
    start("dbus-daemon", ["--session", "--nofork", `--address=unix:path=${out}/bus`]);
    process.env.DISPLAY = ":99";
    process.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${out}/bus`;
    await chmod(oldFile, 0o755);
    await mkdir(installed, { recursive: true });
    run(oldFile, ["--appimage-extract"], { cwd: installed });
    executable = join(installed, "squashfs-root/AppRun");
    resources = join(installed, "squashfs-root/resources");
  }
  if (!publicFeed) {
    server = createServer(async (request, response) => {
      try {
        const name = basename(decodeURIComponent(new URL(request.url, "http://localhost").pathname));
        const file = join(newDir, name);
        const size = (await stat(file)).size;
        response.writeHead(200, { "Content-Length": size, "Content-Type": "application/octet-stream" });
        createReadStream(file).pipe(response);
      } catch {
        response.writeHead(404);
        response.end();
      }
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const config = join(resources, "app-update.yml");
    const original = await readFile(config, "utf8");
    // Retain publisherName and updaterCacheDirName, including signature checks:
    // electron-updater refuses an installer whose publisher differs.
    await writeFile(config, original.replace(/^provider:.*$/m, "provider: generic") + `\nurl: http://127.0.0.1:${server.address().port}/\n`);
  }
  const env = {
    TRACKYOURTIME_USER_DATA_DIR: profile,
    TRACKYOURTIME_HEADLESS: "0",
    APPIMAGE: oldFile,
    APPDIR: join(installed, "squashfs-root"),
    APPIMAGE_EXTRACT_AND_RUN: "1",
  };
  const port = 59843;
  start(executable, [`--remote-debugging-port=${port}`, "--mute-audio", ...(windows ? [] : ["--password-store=basic"])], env);
  const page = await connect(port);
  const status = () => page.evaluate(() => window.electronAPI.desktop.updates.getStatus());
  assert.equal((await status()).currentVersion, from);
  await page.evaluate(() => localStorage.setItem("installed-release-qa", "preserve-me"));
  await page.screenshot({ path: join(out, "before.png") });
  await page.evaluate(() => window.electronAPI.desktop.updates.check());
  result.downloaded = await until(
    async () => {
      const snapshot = await status();
      if (snapshot.status.kind === "error" || snapshot.status.kind === "disabled") throw new Error(JSON.stringify(snapshot));
      return snapshot.status.kind === "ready" ? snapshot : false;
    },
    "electron-updater download of the Tauri release",
    300_000,
  );
  assert.equal(result.downloaded.status.version, to);
  await page.screenshot({ path: join(out, "update-ready.png") });
  await page.evaluate(() => window.electronAPI.desktop.updates.restart()).catch(() => {});

  let tauri;
  if (windows) {
    // The Tauri installer ran with /S; its pre-install hook ran the Electron
    // uninstaller (build/windows/installer-hooks.nsh).
    tauri = join(process.env.LOCALAPPDATA, "Track Your Time", "Track Your Time.exe");
    await until(() => existsSync(tauri), "the Tauri install", 240_000);
    const { uninstall } = electronUninstallKeys();
    await until(async () => {
      try {
        run("reg", ["query", `HKCU\\${uninstall}`]);
        return false;
      } catch {
        return true;
      }
    }, "the Electron uninstall entry to be removed", 120_000);
    await until(() => !existsSync(executable), "the Electron install to be removed", 60_000);
    const version = run("pwsh", ["-NoProfile", "-Command", `(Get-Item -LiteralPath '${tauri.replaceAll("'", "''")}').VersionInfo.ProductVersion`]).trim().replace(/^(\d+\.\d+\.\d+)\.0$/, "$1");
    assert.equal(version, to, `The installed app reports version ${version}`);
    result.installedVersion = version;
  } else {
    // AppImageUpdater writes the new image beside the old one under its name.
    const replaced = join(oldDir, filename(to));
    await until(async () => existsSync(replaced) && (await hash(replaced)) === (await hash(join(newDir, filename(to)))), "installed update replacement", 180_000);
  }
  await pause(5000);
  await stopInstalled().catch((error) => {
    if (windows || error.status !== 1) throw error;
  });

  if (!windows) {
    const image = join(oldDir, filename(to));
    await chmod(image, 0o755);
    const next = join(out, "installed-tauri");
    await mkdir(next, { recursive: true });
    run(image, ["--appimage-extract"], { cwd: next });
    tauri = join(next, "squashfs-root/AppRun");
    env.APPIMAGE = image;
    env.APPDIR = join(next, "squashfs-root");
  }
  const report = await smoke(tauri, { TRACKYOURTIME_USER_DATA_DIR: profile, ...(windows ? {} : { APPIMAGE: env.APPIMAGE, APPDIR: env.APPDIR }) });
  // What the smoke report does not (yet) carry is recorded, not assumed.
  if (report.version !== undefined) assert.equal(report.version, to);
  else result.unverified.push("the version the running Tauri app reports (smoke report has no `version`)");
  if (report.storageMarker !== undefined) assert.equal(report.storageMarker, "preserve-me", "localStorage did not survive the migration");
  else result.unverified.push("that the Electron app's localStorage reached the Tauri app (smoke report has no `storageMarker`)");
  result.ok = true;
} catch (error) {
  result.error = error.stack;
  result.body = await activePage?.locator("body").innerText({ timeout: 3000 }).catch(() => null);
  await activePage?.screenshot({ path: join(out, "failure.png"), timeout: 5000 }).catch(() => {});
  process.exitCode = 1;
} finally {
  await stopInstalled().catch(() => {});
  for (const child of children) child.kill("SIGKILL");
  server?.closeAllConnections();
  await new Promise((r) => (server ? server.close(r) : r()));
  await writeFile(join(out, "result.json"), JSON.stringify(result, null, 2) + "\n");
  await writeFile(join(out, "app.log"), logs.join(""));
  console.log(JSON.stringify(result, null, 2));
}
