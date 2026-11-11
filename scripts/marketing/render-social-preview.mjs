#!/usr/bin/env node
/**
 * Renders the three GitHub social preview cards (1280×640 PNG) from
 * docs/marketing/social-preview/template.html, and the two og:image cards
 * (1200×630 PNG).
 *
 *   node scripts/marketing/render-social-preview.mjs        # all five
 *   node scripts/marketing/render-social-preview.mjs --og   # only the og:image cards
 *
 * The template reads the captures in docs/marketing/screenshots/ (made by
 * capture-readme.mjs). Writes docs/marketing/social-preview/social-preview-{a,b,c}.png
 * and fails when a card reaches GitHub's 1 MB limit. GitHub takes the card in
 * the repository settings; no script uploads it.
 *
 * The og:image cards are og-wordmark.png (card B with its wordmark and text)
 * and og-clean.png (og-clean.html, no text). They are laid out at 1280×672 CSS
 * px, the same 1.905:1 shape as 1200×630, shot at 2× and downscaled to exactly
 * 1200×630 with ImageMagick (`magick`), which must be installed.
 */
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

const dir = resolve(import.meta.dirname, "../../docs/marketing/social-preview");
const template = pathToFileURL(join(dir, "template.html")).href;
const ogOnly = process.argv.includes("--og");

/**
 * og:image cards: [output, page, override CSS]. og-wordmark.png keeps card B's
 * 1280×640 layout, moves it down 16 px and stretches only its background 16 px
 * past the top and bottom, so every margin around the text stays as designed.
 */
const ogCards = [
  [
    "og-wordmark.png",
    `${template}?v=b`,
    `html, body { height: 672px !important; }
     #b { top: 16px; overflow: visible !important; clip-path: inset(-16px 0); z-index: 0; background: none !important; }
     #b::before { content: ""; position: absolute; left: 0; right: 0; top: -16px; bottom: -16px; z-index: -1;
       background: radial-gradient(120% 120% at 100% 0%, #312e81 0%, #1e1b4b 45%, #0b0b1a 100%); }`,
  ],
  ["og-clean.png", pathToFileURL(join(dir, "og-clean.html")).href, ""],
];

/** Pipes a 2× screenshot through ImageMagick to exactly 1200×630, without date chunks. */
function downscale(png, out) {
  try {
    execFileSync("magick", ["png:-", "-resize", "1200x630!", "-define", "png:exclude-chunks=date,time", out], {
      input: png,
    });
  } catch (err) {
    if (err.code === "ENOENT") throw new Error("the og:image cards need ImageMagick's `magick` (brew install imagemagick)");
    throw err;
  }
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 1 });
  for (const v of ogOnly ? [] : ["a", "b", "c"]) {
    await page.goto(`${template}?v=${v}`);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => [...document.images].every((img) => img.complete));
    const out = join(dir, `social-preview-${v}.png`);
    await page.screenshot({ path: out });
    const kb = Math.round(statSync(out).size / 1024);
    console.log(`social-preview-${v}.png ${kb} KB`);
    if (kb >= 1024) throw new Error(`social-preview-${v}.png is ${kb} KB, over GitHub's 1 MB limit`);
  }

  const og = await browser.newPage({ viewport: { width: 1280, height: 672 }, deviceScaleFactor: 2 });
  for (const [name, url, css] of ogCards) {
    await og.goto(url, { waitUntil: "networkidle" });
    if (css) await og.addStyleTag({ content: css });
    await og.evaluate(() => document.fonts.ready);
    await og.evaluate(() => Promise.all([...document.images].map((img) => img.decode().catch(() => {}))));
    const out = join(dir, name);
    downscale(await og.screenshot(), out);
    console.log(`${name} ${Math.round(statSync(out).size / 1024)} KB`);
  }
} finally {
  await browser.close();
}
