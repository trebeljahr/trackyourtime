#!/usr/bin/env node
/**
 * Writes docs/marketing/manifest.json for the GitHub set: every file in
 * docs/marketing/screenshots/ and docs/marketing/social-preview/ with its
 * pixel size, byte size, SHA-256 and the script that made it.
 *
 *   node scripts/marketing/write-github-manifest.mjs
 *
 * The store sets under app-store/, chrome/ and google-play/ are indexed in
 * docs/marketing/README.md and are not part of this manifest.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../docs/marketing");

const PURPOSE = {
  "screenshots/web-track-light.jpg": "Track screen: running timer and today's entries. README hero.",
  "screenshots/web-reports-light.jpg": "Reports grouped by task over four weeks.",
  "screenshots/web-calendar-light.jpg": "Calendar week view.",
  "screenshots/web-track-dark.jpg": "Track screen in the dark theme.",
  "screenshots/web-reports-dark.jpg": "Reports in the dark theme. Used by social preview C.",
  "screenshots/phone-track-light.jpg": "Track screen at phone width (390 px). Used by social preview C.",
  "social-preview/social-preview-a.png": "GitHub social preview option A: screenshot-led.",
  "social-preview/social-preview-b.png": "GitHub social preview option B: typographic, brand-led.",
  "social-preview/social-preview-c.png": "GitHub social preview option C: dark reports with the phone view.",
};

/** Width and height from a PNG IHDR or a JPEG SOFn marker. */
function dimensions(buf) {
  if (buf.readUInt32BE(0) === 0x89504e47) return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
  let i = 2;
  while (i < buf.length) {
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xc3) return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)];
    i += 2 + buf.readUInt16BE(i + 2);
  }
  throw new Error("unknown image format");
}

const files = [];
for (const dir of ["screenshots", "social-preview"]) {
  for (const name of readdirSync(join(root, dir)).sort()) {
    if (!/\.(png|jpg)$/.test(name)) continue;
    const path = `${dir}/${name}`;
    const buf = readFileSync(join(root, path));
    const [width, height] = dimensions(buf);
    files.push({
      path,
      purpose: PURPOSE[path] ?? "",
      width,
      height,
      bytes: buf.length,
      sha256: createHash("sha256").update(buf).digest("hex"),
      source:
        dir === "screenshots"
          ? "scripts/marketing/capture-readme.mjs against a local server seeded by seed-demo.mjs"
          : "scripts/marketing/render-social-preview.mjs over social-preview/template.html",
    });
  }
}

writeFileSync(
  join(root, "manifest.json"),
  `${JSON.stringify({ generated: new Date().toISOString().slice(0, 10), files }, null, 2)}\n`,
);
console.log(`docs/marketing/manifest.json: ${files.length} files`);
