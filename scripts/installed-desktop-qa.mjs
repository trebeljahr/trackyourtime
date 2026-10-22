#!/usr/bin/env node
// Ephemeral native CI only. Installs exact release assets into a disposable
// directory, exercises the real updater and preserves the same isolated profile.
// Before publication, only the old install's external feed configuration is
// changed: a loopback server serves the unmodified draft feed and signed bytes.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile, chmod, stat, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

assert.equal(process.env.GITHUB_ACTIONS, "true", "Run only on disposable GitHub runners");
const from = process.env.QA_FROM ?? "0.2.2";
const to = process.env.QA_TO ?? "0.3.0";
for (const version of [from, to]) assert.match(version, /^\d+\.\d+\.\d+$/);
assert.notEqual(from, to);
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
const result = { from, to, platform: process.platform, arch: process.arch, publicFeed, assets: [], ok: false };
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
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
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
const arch = process.arch === "arm64" ? "arm64" : "x86_64";
const filename = (version) => windows ? `TrackYourTime-Setup-${version}.exe` : `TrackYourTime-${version}-linux-${arch}.AppImage`;
const oldFile = join(oldDir, filename(from));
const feed = windows ? "latest.yml" : `latest-linux${process.arch === "arm64" ? "-arm64" : ""}.yml`;
async function connect(port) {
  await until(async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).ok, "CDP endpoint");
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = await until(() => browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith("app://-")), "app page");
  activePage = page;
  page.on("pageerror", (error) => { result.pageErrors ??= []; result.pageErrors.push(String(error)); });
  await page.waitForFunction(() => !!window.electronAPI?.desktop?.updates);
  await page.locator("body").waitFor({ state: "visible" });
  await page.waitForFunction(() => (document.body?.innerText.trim().length ?? 0) > 30, undefined, { timeout: 60_000 });
  assert.ok((await page.locator("body").innerText()).length > 30, "Rendered app content");
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
    // AppImage's updater relaunches without the parent's CDP flags.
    try { run("pkill", ["-x", "trackyourtime"], { stdio: "ignore" }); }
    catch (error) { if (error.status !== 1) throw error; }
  }
}
try {
  await download(from, oldDir, [filename(from)]);
  const extras = windows ? [`${filename(to)}.blockmap`] : [
    `trackyourtime_${to}_${process.arch === "arm64" ? "arm64" : "amd64"}.deb`,
    `trackyourtime-${to}.${process.arch === "arm64" ? "aarch64" : "x86_64"}.rpm`,
  ];
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
      } catch { response.writeHead(404); response.end(); }
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const config = join(resources, "app-update.yml");
    const original = await readFile(config, "utf8");
    // Retain publisherName and updaterCacheDirName, including signature checks.
    await writeFile(config, original.replace(/^provider:.*$/m, "provider: generic") + `\nurl: http://127.0.0.1:${server.address().port}/\n`);
  }
  const env = { TRACKYOURTIME_USER_DATA_DIR: profile, TRACKYOURTIME_HEADLESS: "0", APPIMAGE: oldFile, APPDIR: join(installed, "squashfs-root"), APPIMAGE_EXTRACT_AND_RUN: "1" };
  const port = 59843;
  start(executable, [`--remote-debugging-port=${port}`, "--mute-audio", ...(windows ? [] : ["--password-store=basic"])], env);
  let page = await connect(port);
  const status = () => page.evaluate(() => window.electronAPI.desktop.updates.getStatus());
  assert.equal((await status()).currentVersion, from);
  await page.evaluate(() => localStorage.setItem("installed-release-qa", "preserve-me"));
  await page.screenshot({ path: join(out, "before.png") });
  const oldAsarHash = windows ? await hash(join(resources, "app.asar")) : null;
  await page.evaluate(() => window.electronAPI.desktop.updates.check());
  result.downloaded = await until(async () => {
    const snapshot = await status();
    if (snapshot.status.kind === "error" || snapshot.status.kind === "disabled") throw new Error(JSON.stringify(snapshot));
    return snapshot.status.kind === "ready" ? snapshot : false;
  }, "real updater download", 300_000);
  assert.equal(result.downloaded.status.version, to);
  await page.screenshot({ path: join(out, "update-ready.png") });
  await page.evaluate(() => window.electronAPI.desktop.updates.restart()).catch(() => {});
  await until(async () => windows
    ? await hash(join(resources, "app.asar")) !== oldAsarHash
    : await hash(join(oldDir, filename(to))) === await hash(join(newDir, filename(to))), "installed update replacement", 180_000);
  await pause(5000);
  await stopInstalled().catch((error) => { if (windows || error.status !== 1) throw error; });
  if (!windows) {
    await rm(join(installed, "squashfs-root"), { recursive: true, force: true });
    env.APPIMAGE = join(oldDir, filename(to));
    run(env.APPIMAGE, ["--appimage-extract"], { cwd: installed });
  }
  start(executable, [`--remote-debugging-port=${port}`, "--mute-audio", ...(windows ? [] : ["--password-store=basic"])], env);
  page = await connect(port);
  result.after = await status();
  assert.equal(result.after.currentVersion, to);
  assert.equal(await page.evaluate(() => localStorage.getItem("installed-release-qa")), "preserve-me");
  await page.screenshot({ path: join(out, "after.png") });
  assert.equal(result.pageErrors?.length ?? 0, 0);
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
  await new Promise((r) => server ? server.close(r) : r());
  await writeFile(join(out, "result.json"), JSON.stringify(result, null, 2) + "\n");
  await writeFile(join(out, "app.log"), logs.join(""));
  console.log(JSON.stringify(result, null, 2));
}
