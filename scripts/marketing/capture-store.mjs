#!/usr/bin/env node
/**
 * Captures the App Store Connect screenshot sets, each at a size its slot
 * accepts, into docs/marketing/app-store/ (or <out-dir>).
 *
 *   node scripts/marketing/capture-store.mjs <web-origin> <email> <password> [out-dir] [--only <set,…>]
 *
 * Run it against a local server seeded by seed-demo.mjs, never production:
 * the screens show whatever account it signs in to. The usual loop is
 * `pnpm run dev:auto` (or the static export through serve.mjs), then
 * `seed-demo.mjs <api> <web>`, then this with the account seed-demo printed.
 *
 * The iPhone and iPad sets are the web app at the device's CSS viewport and
 * pixel ratio with touch emulation — the same bundle the Capacitor shell
 * loads, and the same phone layout (styles/mobile.css). The Mac set is the
 * same bundle in the desktop app's mode: Chromium at the Mac slot's size with
 * an in-memory stand-in for the desktop bridge (`DESKTOP_BRIDGE_STUB` below),
 * so the page draws the desktop chrome (`html.electron[data-platform=darwin]`:
 * the sidebar title bar, the traffic-light inset). The system WebView has no
 * protocol to screenshot it with, and a screenshot of the Electron window was
 * only its page too — never the OS title bar.
 *
 * Sizes are App Store Connect's (Screenshot specifications, checked
 * 2026-10-08). Every file is flattened to opaque RGB: App Store Connect
 * refuses an alpha channel.
 */
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import sharp from "sharp";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * One entry per App Store Connect slot. `viewport` × `scale` is the exact
 * pixel size the slot takes; `ascType` is the API's screenshotDisplayType.
 */
const STORE_SETS = [
  // Dynamic Island (large), 6.9″: 1320 × 2868.
  { name: "iphone-6.9", ascType: "APP_IPHONE_67", viewport: { width: 440, height: 956 }, scale: 3, mobile: true },
  // iPhone Duo, outer display: 1398 × 2034.
  { name: "iphone-duo-outer", ascType: "APP_IPHONE_DUO", viewport: { width: 466, height: 678 }, scale: 3, mobile: true },
  // iPhone Duo, inner display: 2007 × 2853.
  { name: "iphone-duo-inner", ascType: "APP_IPHONE_DUO", viewport: { width: 669, height: 951 }, scale: 3, mobile: true },
  // iPad 13″: 2064 × 2752.
  { name: "ipad-13", ascType: "APP_IPAD_PRO_3GEN_129", viewport: { width: 1032, height: 1376 }, scale: 2, mobile: true },
  // Mac, 16:10: 2880 × 1800.
  { name: "mac", ascType: "APP_DESKTOP", viewport: { width: 1440, height: 900 }, scale: 2, electron: true },
];

const ymd = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const fourWeeksAgo = new Date(Date.now() - 27 * 86_400_000);
const REPORTS = `/app/reports/?group=task&from=${ymd(fourWeeksAgo)}&to=${ymd(new Date())}`;

/** The four screens every set shows, in listing order. */
const SCREENS = [
  { file: "1-track", path: "/app/track/", ready: "main" },
  { file: "2-reports", path: REPORTS, ready: "main" },
  // Phones and tablets: the More drawer, which is how every other screen is
  // reached. The Mac shows its sidebar anyway, so it shows the calendar.
  { file: "3-more", path: "/app/track/", ready: '[data-testid="tab-more"]', open: '[data-testid="tab-more"]', desktop: { file: "3-calendar", path: "/app/calendar/", ready: "main" } },
  { file: "4-invoice", path: "/app/invoices/", ready: '[data-testid^="invoice-open-"]', open: '[data-testid^="invoice-open-"]', after: '[data-testid="invoice-detail"]' },
];

function usage() {
  console.error("Usage: capture-store.mjs <web-origin> <email> <password> [out-dir] [--only iphone-6.9,mac,…]");
  process.exit(1);
}

const argv = process.argv.slice(2);
const onlyAt = argv.indexOf("--only");
const only = onlyAt >= 0 ? argv.splice(onlyAt, 2)[1]?.split(",") : null;
const [origin, email, password, outArg] = argv;
if (!origin || !email || !password) usage();
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+\/?$/.test(origin)) {
  console.error("capture-store.mjs signs in to the server it is given; point it at a local, seeded one.");
  process.exit(1);
}
const outDir = resolve(outArg ?? join(repoRoot, "docs/marketing/app-store"));
const sets = STORE_SETS.filter((set) => !only || only.includes(set.name));
if (!sets.length) usage();
await mkdir(outDir, { recursive: true });

async function signIn(page) {
  // `next dev` compiles each route on its first visit.
  page.setDefaultNavigationTimeout(180_000);
  await page.goto(`${origin}/login/`);
  await page.getByTestId("login-email").fill(email);
  await page.getByTestId("login-password").fill(password);
  await page.getByTestId("login-submit").click();
  await page.waitForURL(/\/track\/?$/, { timeout: 120_000 });
}

async function save(buffer, set, file) {
  const { width, height } = set.viewport;
  const target = join(outDir, `${set.name}-${file}.png`);
  // A Retina display gives the Electron capture its own pixel ratio; the
  // slot wants exactly viewport × scale.
  await sharp(buffer)
    .resize(width * set.scale, height * set.scale, { fit: "fill" })
    .flatten({ background: "#ffffff" })
    .removeAlpha()
    .png({ compressionLevel: 9 })
    .toFile(target);
  console.log(`  ${target.replace(`${repoRoot}/`, "")}  ${width * set.scale}×${height * set.scale}`);
}

async function shoot(page, set) {
  for (const base of SCREENS) {
    const screen = set.electron && base.desktop ? base.desktop : base;
    await page.goto(`${origin}${screen.path}`);
    await page.locator(screen.ready).first().waitFor({ timeout: 120_000 });
    await page.waitForLoadState("networkidle");
    if (screen.open) {
      await page.locator(screen.open).first().click();
      if (screen.after) await page.locator(screen.after).first().waitFor();
    }
    // `next dev` draws its own badge into the page; a store image must not.
    await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
    // Activity capture is refused in a Mac App Store build (the sandbox;
    // desktop/crates/activity → activity_capture_support), which hides its nav item. This
    // run is not one, so the store image hides it the same way.
    if (set.electron) await page.addStyleTag({ content: 'a[href^="/app/activity"] { display: none !important; }' });
    // A pointer left over a chart opens a tooltip in the capture.
    await page.mouse.move(1, 1);
    await page.waitForTimeout(1200);
    await save(await page.screenshot(), set, screen.file);
  }
}

const theme = "light";
const browserSets = sets.filter((set) => !set.electron);
if (browserSets.length) {
  const browser = await chromium.launch();
  for (const set of browserSets) {
    console.log(`${set.name} (${set.ascType})`);
    const context = await browser.newContext({
      viewport: set.viewport,
      deviceScaleFactor: set.scale,
      isMobile: set.mobile,
      hasTouch: set.mobile,
      colorScheme: theme,
    });
    const page = await context.newPage();
    await signIn(page);
    await shoot(page, set);
    await context.close();
  }
  await browser.close();
}

/**
 * What the desktop shell would install as `window.electronAPI`, enough for
 * the screens above to render in desktop mode: the token lives in memory,
 * every command and subscription is a no-op, and there is no activity
 * capture (a Mac App Store build has none either).
 */
const DESKTOP_BRIDGE_STUB = `(() => {
  let token = null;
  const off = () => () => {};
  const none = () => Promise.resolve(null);
  window.electronAPI = Object.freeze({
    isDesktop: true,
    platform: "darwin",
    quit: none,
    openExternal: () => Promise.resolve(false),
    getIdleState: () => Promise.resolve({ state: "active", idleSeconds: 0 }),
    onIdleState: off,
    secureStore: {
      getToken: () => Promise.resolve(token),
      setToken: (value) => { token = value; return Promise.resolve({ persistent: false, backend: "memory" }); },
      deleteToken: () => { token = null; return Promise.resolve(); },
      status: () => Promise.resolve({ persistent: false, backend: "memory" }),
    },
    desktop: {
      window: { getState: () => Promise.resolve({ mode: "full", alwaysOnTop: false }), setMode: none, setAlwaysOnTop: none, onChanged: off },
      publishTimerState: none, onCommand: off, getSettings: none, updateSettings: none, onSettingsChanged: off,
      suspendShortcuts: none, showWindow: none, notify: () => Promise.resolve(false),
    },
  });
})();`;

for (const set of sets.filter((s) => s.electron)) {
  console.log(`${set.name} (${set.ascType}, desktop mode)`);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: set.viewport, deviceScaleFactor: set.scale, colorScheme: theme });
  await context.addInitScript(DESKTOP_BRIDGE_STUB);
  const page = await context.newPage();
  await signIn(page);
  await shoot(page, set);
  await browser.close();
}
