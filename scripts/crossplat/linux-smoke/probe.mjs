/*
 * Runs INSIDE the linux-smoke container (see ../linux-smoke.mjs, which
 * mounts the app at /app, this folder at /crossplat and the output at /out).
 *
 * Two ways to probe an app, picked by SMOKE_MODE:
 *
 *   cdp (default)  For an app with its own Chromium (Electron): launch it with
 *                  a CDP port, attach playwright-core, wait for a page whose
 *                  URL starts with SMOKE_EXPECT_URL_PREFIX, let it settle,
 *                  screenshot it and check the process is still alive.
 *   report         For an app on the system WebView (Tauri, WebKitGTK), which
 *                  has no CDP: the app must support a smoke mode of its own —
 *                  given a file path in the variable SMOKE_REPORT_ENV names,
 *                  it loads, waits for its page, writes a JSON report
 *                  `{ ok, href, title, problems: [] }` there and exits (0 on
 *                  ok). The screenshot is read from Xvfb's own framebuffer
 *                  file (-fbdir), so nothing extra is installed in the image.
 *
 * Writes /out/result.json, /out/screenshot.png and /out/app.log; exits 0 on a
 * pass.
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { createRequire } from "node:module";
import { deflateSync } from "node:zlib";

const mode = process.env.SMOKE_MODE === "report" ? "report" : "cdp";

const exec = process.env.SMOKE_EXEC;
const extraArgs = JSON.parse(process.env.SMOKE_ARGS ?? "[]");
const expectPrefix = process.env.SMOKE_EXPECT_URL_PREFIX ?? "";
const settleMs = Number(process.env.SMOKE_SETTLE_MS ?? "5000");
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? "60000");
const port = 9222;

const result = { ok: false, url: null, title: null, consoleErrors: [], pageErrors: [], screenshot: false, problem: null, appLogTail: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The app's last words, so a failure explains itself without a second look. */
function appLogTail(lines = 12) {
  try {
    return readFileSync("/out/app.log", "utf8").split("\n").filter((line) => line.trim() !== "").slice(-lines);
  } catch {
    return [];
  }
}

function finish(problem) {
  result.problem = problem;
  result.ok = problem === null;
  if (!result.ok) result.appLogTail = appLogTail();
  writeFileSync("/out/result.json", `${JSON.stringify(result, null, 2)}\n`);
  if (result.ok) console.log("PASS");
  else {
    console.log(`FAIL: ${problem}`);
    for (const line of result.appLogTail) console.log(`    | ${line}`);
  }
  process.exit(result.ok ? 0 : 1);
}

if (!exec) finish("SMOKE_EXEC is not set");

mkdirSync(fbDir, { recursive: true });
// -fbdir keeps the screen in a file (XWD format), which report mode reads its
// screenshot from.
const fbDir = "/tmp/smoke-fb";
const xvfb = spawn("Xvfb", [":99", "-screen", "0", "1280x800x24", "-nolisten", "tcp", ...(mode === "report" ? ["-fbdir", fbDir] : [])], {
  stdio: "ignore",
});

process.on("exit", () => xvfb.kill());
// A session bus, so Chromium and libnotify have one to talk to. The system
// bus stays absent; its connection errors in app.log are expected.
const busAddress = "unix:path=/tmp/smoke-session-bus";
const bus = spawn("dbus-daemon", ["--session", "--nofork", `--address=${busAddress}`], { stdio: "ignore" });
process.on("exit", () => bus.kill());
await sleep(500);

// Written synchronously, not piped into a stream: every finish() ends in
// process.exit(), which drops whatever a stream still had buffered — and the
// one line that explains a failed start ("error while loading shared libraries:
// libgbm.so.1") is written by the loader immediately before the app dies, so it
// is exactly the line a buffered write loses.
const logFd = openSync("/out/app.log", "a");
process.on("exit", () => {
  try {
    closeSync(logFd);
  } catch {
    // Already closed, or never opened: nothing to report at exit.
  }
});
const record = (chunk) => {
  try {
    writeSync(logFd, chunk);
  } catch {
    // A full or closed /out must not take the verdict down with it.
  }
};
if (mode === "report") await reportProbe();

/**
 * Report mode: start the app with the report path in its environment, keep
 * the newest non-blank frame while it runs, and judge by its own report.
 */
async function reportProbe() {
  const reportEnv = process.env.SMOKE_REPORT_ENV;
  if (!reportEnv || !/^[A-Z_][A-Z0-9_]*$/.test(reportEnv)) finish("SMOKE_MODE=report needs SMOKE_REPORT_ENV, the name of the app's report variable");
  const reportPath = "/out/app-report.json";
  const child = spawn(exec, extraArgs, {
    env: { ...process.env, DISPLAY: ":99", DBUS_SESSION_BUS_ADDRESS: busAddress, [reportEnv]: reportPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", record);
  child.stderr.on("data", record);
  let ended = null;
  child.on("exit", (code, signal) => {
    ended = { code, signal };
  });
  child.on("error", (err) => {
    ended = { code: null, signal: null, error: String(err) };
  });
  process.on("exit", () => child.kill("SIGKILL"));

  const frameFile = `${fbDir}/Xvfb_screen0`;
  let lastFrame = null;
  const deadline = Date.now() + timeoutMs;
  while (!ended && Date.now() < deadline) {
    try {
      const frame = readFileSync(frameFile);
      if (!frameIsBlank(frame)) lastFrame = frame;
    } catch {
      // Xvfb has not written its screen yet.
    }
    await sleep(250);
  }
  if (!ended) {
    child.kill("SIGKILL");
    finish(`the app wrote no report and did not exit within ${timeoutMs} ms; see app.log`);
  }
  if (lastFrame) {
    try {
      writeFileSync("/out/screenshot.png", xwdToPng(lastFrame));
      result.screenshot = true;
    } catch (err) {
      result.screenshotError = String(err);
    }
  }
  if (ended.error) finish(`the app could not start: ${ended.error}`);
  if (!existsSync(reportPath)) finish(`the app exited (code ${ended.code}, signal ${ended.signal}) without writing ${reportEnv}; see app.log`);
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch (err) {
    finish(`the app's report is not JSON: ${String(err)}`);
  }
  result.report = report;
  result.url = report.href ?? null;
  result.title = report.title ?? null;
  result.pageErrors = Array.isArray(report.problems) ? report.problems : [];
  if (!String(report.href ?? "").startsWith(expectPrefix)) finish(`the page is ${report.href}, not under "${expectPrefix}"`);
  if (result.pageErrors.length) finish(`${result.pageErrors.length} page problem(s): ${result.pageErrors[0]}`);
  if (report.ok !== true) finish("the app's report says ok: false; see app-report.json");
  if (ended.code !== 0) finish(`the app reported ok but exited with code ${ended.code}`);
  if (!result.screenshot) finish(`no screenshot: ${result.screenshotError ?? "Xvfb never showed a non-blank frame"}`);
  finish(null);
}

/** Every pixel the same: Xvfb's screen before anything has been drawn. */
function frameIsBlank(frame) {
  const xwd = parseXwd(frame);
  const { data, offset } = xwd;
  const first = data.readUInt32LE(offset);
  // Every 97th pixel: about ten thousand samples of a 1280x800 screen.
  for (let i = offset; i + 4 <= data.length; i += 4 * 97) if (data.readUInt32LE(i) !== first) return false;
  return true;
}

/**
 * The header of an XWD file (X11's XWDFileHeader: 25 CARD32s), in whichever
 * byte order the writer used — Xvfb writes its host's.
 */
function parseXwd(data) {
  let read = (i) => data.readUInt32BE(i * 4);
  if (read(1) !== 7) read = (i) => data.readUInt32LE(i * 4);
  if (read(1) !== 7) throw new Error("not an XWD (version 7) file");
  const header = {
    headerSize: read(0),
    width: read(4),
    height: read(5),
    byteOrder: read(7),
    bitsPerPixel: read(11),
    bytesPerLine: read(12),
    masks: [read(14), read(15), read(16)],
    ncolors: read(19),
  };
  return { ...header, data, offset: header.headerSize + header.ncolors * 12 };
}

/** A 24-bit TrueColor XWD frame as a PNG, with zlib and nothing else. */
function xwdToPng(frame) {
  const xwd = parseXwd(frame);
  if (xwd.bitsPerPixel !== 32) throw new Error(`a ${xwd.bitsPerPixel}-bit frame; expected 32`);
  const shifts = xwd.masks.map((mask) => (mask === 0 ? 0 : Math.log2(mask & -mask)));
  const rows = Buffer.alloc((xwd.width * 3 + 1) * xwd.height);
  for (let y = 0; y < xwd.height; y++) {
    const out = y * (xwd.width * 3 + 1);
    for (let x = 0; x < xwd.width; x++) {
      const at = xwd.offset + y * xwd.bytesPerLine + x * 4;
      const pixel = xwd.byteOrder === 0 ? frame.readUInt32LE(at) : frame.readUInt32BE(at);
      for (let c = 0; c < 3; c++) rows[out + 1 + x * 3 + c] = (pixel & xwd.masks[c]) >>> shifts[c];
    }
  }
  const chunk = (type, body) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "latin1"), body])));
    return Buffer.concat([length, Buffer.from(type, "latin1"), body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(xwd.width, 0);
  ihdr.writeUInt32BE(xwd.height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ── CDP mode ─────────────────────────────────────────────────────────

const require = createRequire(`${process.env.NODE_PATH ?? "/usr/local/lib/node_modules"}/`);
const { chromium } = require("playwright-core");

const app = spawn(exec, ["--no-sandbox", `--remote-debugging-port=${port}`, ...extraArgs], {
  env: { ...process.env, DISPLAY: ":99", DBUS_SESSION_BUS_ADDRESS: busAddress },
  stdio: ["ignore", "pipe", "pipe"],
});
app.stdout.on("data", record);
app.stderr.on("data", record);
let exited = null;
app.on("exit", (code, signal) => {
  exited = { code, signal };
});
process.on("exit", () => app.kill("SIGKILL"));

const deadline = Date.now() + timeoutMs;
let cdpUp = false;
while (Date.now() < deadline && !exited) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    if (res.ok) {
      cdpUp = true;
      break;
    }
  } catch {
    // not listening yet
  }
  await sleep(250);
}
if (exited) finish(`the app exited before opening CDP (code ${exited.code}, signal ${exited.signal}); see app.log`);
if (!cdpUp) finish(`no CDP endpoint on :${port} within ${timeoutMs} ms; see app.log`);

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
let page = null;
while (Date.now() < deadline && !page) {
  page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith(expectPrefix)) ?? null;
  if (!page) await sleep(250);
}
if (!page) {
  const seen = browser.contexts().flatMap((c) => c.pages()).map((p) => p.url());
  finish(`no page with a URL starting "${expectPrefix}" (saw: ${seen.join(", ") || "none"})`);
}
page.on("console", (msg) => {
  if (msg.type() === "error") result.consoleErrors.push(msg.text());
});
page.on("pageerror", (err) => result.pageErrors.push(String(err)));

await page.waitForLoadState("load", { timeout: Math.max(1000, deadline - Date.now()) }).catch(() => {});
await sleep(settleMs);
result.url = page.url();
result.title = await page.title().catch(() => null);
// A window that was never shown produces no frames on X11, and the capture
// then waits forever: an app run with its own "headless" switch has to show
// its window here (Xvfb is virtual, so nothing reaches a real screen).
let screenshotError = null;
await page
  .screenshot({ path: "/out/screenshot.png", timeout: 15000 })
  .then(() => {
    result.screenshot = true;
  })
  .catch((err) => {
    screenshotError = String(err).split("\n")[0];
  });

if (exited) finish(`the app exited after ${settleMs} ms (code ${exited.code}, signal ${exited.signal}); see app.log`);
if (result.pageErrors.length) finish(`${result.pageErrors.length} uncaught page error(s): ${result.pageErrors[0]}`);
if (screenshotError) finish(`no screenshot (is the window shown?): ${screenshotError}`);
finish(null);
