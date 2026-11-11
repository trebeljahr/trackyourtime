#!/usr/bin/env node
/*
 * Generate the Tauri app's icon set (desktop/src-tauri/icons/) from
 * build/icon.png, which `pnpm icons:brand` derives from the brand mark:
 *
 *   32x32.png, 128x128.png, 128x128@2x.png, icon.png (512)  — Linux and the window
 *   icon.icns                                               — macOS 11–15
 *   icon.ico                                                — Windows
 *
 * Exactly the files tauri.conf.json's `bundle.icon` lists, and nothing in
 * icons/tray/ (the tray icons are icons:brand's). The macOS 26 icon is not
 * here: it is build/AppIcon.icon, an Icon Composer document that
 * scripts/build-desktop.mjs compiles with actool into the bundle's Assets.car.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import iconGen from "icon-gen";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "build", "icon.png");
const out = path.join(root, "desktop", "src-tauri", "icons");
mkdirSync(out, { recursive: true });

for (const [name, size] of [
  ["32x32.png", 32],
  ["128x128.png", 128],
  ["128x128@2x.png", 256],
  ["icon.png", 512],
]) {
  await sharp(src).resize(size, size).png().toFile(path.join(out, name));
  console.log(`  ${path.relative(root, path.join(out, name))}`);
}

await iconGen(src, out, { report: false, ico: { name: "icon" }, icns: { name: "icon" } });
console.log(`  ${path.relative(root, path.join(out, "icon.icns"))}\n  ${path.relative(root, path.join(out, "icon.ico"))}`);
