#!/usr/bin/env node
/**
 * Renders the three GitHub social preview cards (1280×640 PNG) from
 * docs/marketing/social-preview/template.html.
 *
 *   node scripts/marketing/render-social-preview.mjs
 *
 * The template reads the captures in docs/marketing/screenshots/ (made by
 * capture-readme.mjs). Writes docs/marketing/social-preview/social-preview-{a,b,c}.png
 * and fails when a card reaches GitHub's 1 MB limit. GitHub takes the card in
 * the repository settings; no script uploads it.
 */
import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

const dir = resolve(import.meta.dirname, "../../docs/marketing/social-preview");
const template = pathToFileURL(join(dir, "template.html")).href;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 1 });
  for (const v of ["a", "b", "c"]) {
    await page.goto(`${template}?v=${v}`);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => [...document.images].every((img) => img.complete));
    const out = join(dir, `social-preview-${v}.png`);
    await page.screenshot({ path: out });
    const kb = Math.round(statSync(out).size / 1024);
    console.log(`social-preview-${v}.png ${kb} KB`);
    if (kb >= 1024) throw new Error(`social-preview-${v}.png is ${kb} KB, over GitHub's 1 MB limit`);
  }
} finally {
  await browser.close();
}
