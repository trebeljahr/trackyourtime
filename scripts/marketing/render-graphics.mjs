#!/usr/bin/env node
/**
 * Composes the store graphics from real captures: a short caption beside or
 * above a screenshot, rendered at each store's exact pixel size.
 *
 *   node scripts/marketing/render-graphics.mjs <captures-dir> <out-dir>
 *
 * `<captures-dir>` holds what capture-web.mjs, capture-extension.mjs and the
 * simulator captures wrote. A graphic whose capture is missing is skipped
 * with a note, so the web and extension sets can be rendered before the
 * phone captures exist.
 *
 * Captions follow the house copy rules: one claim each, no adjective the
 * screenshot beside it does not prove.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";

const [capturesDir, outDir] = process.argv.slice(2).map((p) => p && resolve(p));
if (!capturesDir || !outDir) {
  console.error("Usage: render-graphics.mjs <captures-dir> <out-dir>");
  process.exit(1);
}

const MARK = await readFile(resolve("packages/client/public/brand/mark-tile.svg"), "utf8");
const dataUri = async (file) => `data:image/png;base64,${(await readFile(file)).toString("base64")}`;

const BASE_CSS = `
  * { box-sizing: border-box; margin: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", Arial, sans-serif;
         -webkit-font-smoothing: antialiased; overflow: hidden; }
  .dark { background: radial-gradient(120% 120% at 100% 0%, #312e81 0%, #1e1b4b 45%, #0b0b1a 100%); color: #fff; }
  .light { background: linear-gradient(160deg, #eef2ff 0%, #f8fafc 60%, #ffffff 100%); color: #0f172a; }
  .brand { display: flex; align-items: center; gap: .4em; font-weight: 600; letter-spacing: -0.02em; }
  .brand svg { width: 1.5em; height: 1.5em; }
  .brand b { font-weight: 600; color: #818cf8; }
  .light .brand b { color: #4f46e5; }
  h1 { font-weight: 700; letter-spacing: -0.03em; line-height: 1.08; text-wrap: balance; }
  p.sub { opacity: .72; line-height: 1.35; text-wrap: pretty; }
  img.shot { display: block; border-radius: 18px; box-shadow: 0 30px 80px rgba(15, 23, 42, .28), 0 0 0 1px rgba(15, 23, 42, .08); }
`;

const brand = (size) =>
  `<div class="brand" style="font-size:${size}px">${MARK}<span>track<b>time</b></span></div>`;

/** Caption on the left, capture on the right. */
const sideBySide = ({ width, height, theme = "light", title, sub, shot, shotWidth }) => `
  <div class="${theme}" style="width:${width}px;height:${height}px;display:flex;align-items:center;gap:${width * 0.05}px;padding:0 ${width * 0.06}px">
    <div style="flex:1;display:flex;flex-direction:column;gap:${height * 0.04}px">
      ${brand(height * 0.04)}
      <h1 style="font-size:${height * 0.075}px">${title}</h1>
      ${sub ? `<p class="sub" style="font-size:${height * 0.032}px">${sub}</p>` : ""}
    </div>
    <img class="shot" src="${shot}" style="width:${shotWidth}px;height:auto;max-height:${height * 0.88}px;object-fit:cover;object-position:top" />
  </div>`;

/** Caption on top, capture below and bleeding off the bottom edge — the phone store layout. */
const stacked = ({ width, height, theme = "dark", title, shot, shotWidth, radius }) => `
  <div class="${theme}" style="width:${width}px;height:${height}px;display:flex;flex-direction:column;align-items:center;padding-top:${height * 0.07}px;gap:${height * 0.045}px">
    <h1 style="font-size:${width * 0.078}px;text-align:center;padding:0 ${width * 0.08}px">${title}</h1>
    <img class="shot" src="${shot}" style="width:${shotWidth}px;border-radius:${radius}px" />
  </div>`;

const centered = ({ width, height, theme = "dark", title, sub, brandSize }) => `
  <div class="${theme}" style="width:${width}px;height:${height}px;display:flex;flex-direction:column;justify-content:center;gap:${height * 0.06}px;padding:0 ${width * 0.07}px">
    ${brand(brandSize)}
    <h1 style="font-size:${height * 0.11}px">${title}</h1>
    ${sub ? `<p class="sub" style="font-size:${height * 0.045}px">${sub}</p>` : ""}
  </div>`;

const c = (name) => join(capturesDir, name);

const GRAPHICS = [
  // Link previews for every public page.
  {
    out: "og.png", width: 1200, height: 630, needs: [],
    html: async () => centered({
      width: 1200, height: 630, brandSize: 44,
      title: "Name the work once.<br/>Report on it across every client.",
      sub: "Time tracking for billable work. Open source under AGPL-3.0.",
    }),
  },

  // Chrome Web Store: screenshots 1280x800, small promo tile 440x280, marquee 1400x560.
  {
    out: "chrome/screenshot-1-timer.png", width: 1280, height: 800, needs: ["ext/popup-running.png"],
    html: async () => sideBySide({
      width: 1280, height: 800, shotWidth: 420, shot: await dataUri(c("ext/popup-running.png")),
      title: "Start and stop your timer from the toolbar",
      sub: "Project, task, tags and billable, in a popup. No tab to find.",
    }),
  },
  {
    out: "chrome/screenshot-2-autocomplete.png", width: 1280, height: 800, needs: ["ext/popup-autocomplete.png"],
    html: async () => sideBySide({
      width: 1280, height: 800, shotWidth: 420, shot: await dataUri(c("ext/popup-autocomplete.png")),
      title: "Descriptions complete from all your past work",
      sub: "The search runs on the server, so last spring's entries still appear.",
    }),
  },
  {
    out: "chrome/screenshot-3-entries.png", width: 1280, height: 800, needs: ["ext/popup-entries.png"],
    html: async () => sideBySide({
      width: 1280, height: 800, shotWidth: 420, shot: await dataUri(c("ext/popup-entries.png")),
      title: "Edit, continue or delete any entry",
      sub: "Step back through earlier days. Changes made offline are sent when you reconnect.",
    }),
  },
  {
    out: "chrome/screenshot-4-web-app.png", width: 1280, height: 800, needs: ["web/web-reports.png"],
    html: async () => stacked({
      width: 1280, height: 800, theme: "light", shotWidth: 1100, radius: 14,
      shot: await dataUri(c("web/web-reports.png")),
      title: "Reports and invoices are one click away in the web app",
    }).replace("font-size:99.84px", "font-size:46px"),
  },
  {
    out: "chrome/promo-small-440x280.png", width: 440, height: 280, needs: [],
    html: async () => centered({ width: 440, height: 280, brandSize: 26, title: "Time tracking for billable work" }),
  },
  {
    out: "chrome/promo-marquee-1400x560.png", width: 1400, height: 560, needs: ["ext/popup-running.png"],
    html: async () => sideBySide({
      width: 1400, height: 560, theme: "dark", shotWidth: 330, shot: await dataUri(c("ext/popup-running.png")),
      title: "Your timer, in the Chrome toolbar",
      sub: "Signs in with your web app session. Keeps working offline.",
    }),
  },

  // App Store: iPhone 6.9" 1320x2868, iPad 13" 2064x2752. Google Play: phone 1080x1920.
  ...[
    ["1-track", "Start a timer. It keeps running with no signal."],
    ["2-reports", "See what your week earned"],
    ["3-more", "Every screen of the web app, one tab away"],
    ["4-invoice", "Invoice the hours at the rate you logged them"],
  ].flatMap(([name, title]) => [
    {
      out: `app-store/iphone-6.9-${name}.png`, width: 1320, height: 2868, needs: [`phone/iphone-${name}.png`],
      html: async () => stacked({ width: 1320, height: 2868, title, shotWidth: 1100, radius: 64, shot: await dataUri(c(`phone/iphone-${name}.png`)) }),
    },
    {
      out: `app-store/ipad-13-${name}.png`, width: 2064, height: 2752, needs: [`phone/ipad-${name}.png`],
      html: async () => stacked({ width: 2064, height: 2752, title, shotWidth: 1720, radius: 36, shot: await dataUri(c(`phone/ipad-${name}.png`)) }).replace(/font-size:[\d.]+px;text-align/, "font-size:112px;text-align"),
    },
    {
      // 1080x1920: Play refuses a screenshot whose long side is more than twice its short side.
      out: `google-play/phone-${name}.png`, width: 1080, height: 1920, needs: [`phone/android-${name}.png`],
      html: async () => stacked({ width: 1080, height: 1920, title, shotWidth: 780, radius: 40, shot: await dataUri(c(`phone/android-${name}.png`)) }),
    },
  ]),

  // Google Play feature graphic 1024x500.
  {
    out: "google-play/feature-graphic-1024x500.png", width: 1024, height: 500, needs: [],
    html: async () => centered({
      width: 1024, height: 500, brandSize: 36,
      title: "Track billable time, with or without a signal",
    }),
  },
];

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch();
for (const graphic of GRAPHICS) {
  const missing = graphic.needs.filter((n) => !existsSync(c(n)));
  if (missing.length > 0) {
    console.log(`skip ${graphic.out} (missing ${missing.join(", ")})`);
    continue;
  }
  const page = await browser.newPage({ viewport: { width: graphic.width, height: graphic.height }, deviceScaleFactor: 1 });
  await page.setContent(`<html><head><style>${BASE_CSS}</style></head><body>${await graphic.html()}</body></html>`);
  await page.waitForTimeout(200);
  const file = join(outDir, graphic.out);
  await mkdir(join(file, ".."), { recursive: true });
  await page.screenshot({ path: file, omitBackground: false });
  await page.close();
  console.log(`rendered ${graphic.out}`);
}
await browser.close();
