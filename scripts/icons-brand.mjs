#!/usr/bin/env node
/*
 * Rasterize every bitmap the app ships from the one brand mark.
 *
 * `mark-tile.svg` is the canonical mark. The bare timer arc draws a neutral
 * track ring meant for a page background, which disappears against browser
 * chrome, a macOS dock or a menu bar; the tile carries its own indigo ground
 * and reads the same everywhere. So every raster surface derives from the
 * tile, and this script is what keeps them derived instead of drifting into
 * hand-edited binaries nobody can regenerate. (They had: before this script
 * existed, every PNG below except the extension's was a flat #6366F1 square
 * with no mark in it at all — the starter placeholder, inherited by the
 * Electron, Raycast and Capacitor builds in turn.)
 *
 * The generated files are committed, because the toolchains that consume them
 * cannot rasterize an SVG themselves: Chrome's `icons` manifest key takes PNG
 * only, `capacitor-assets` takes a PNG source, and Raycast
 * reads PNG from `assets/`.
 *
 * Run after any change to the mark:  pnpm run icons:brand
 * Then re-run the downstream generators that fan these out further:
 *   pnpm run icons:desktop   build/icon.png  -> icns + ico
 *   pnpm run mobile:assets   resources/*.png -> ios/ + android/
 *
 * resources/ holds five inputs, all generated here: icon.png (the launcher
 * icon's source), splash.png / splash-dark.png, and the icon-foreground.png /
 * icon-background.png pair Android's adaptive icon needs.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const brand = path.join(root, "packages/client/public/brand");

/** The mark's own viewBox, needed to turn a target pixel size into a DPI. */
const SVG_VIEWBOX_PX = 64;
/** librsvg's baseline DPI — density scales the render relative to this. */
const BASE_DPI = 72;
/** Render at 4x and downsample, so curved edges land on antialiased pixels. */
const SUPERSAMPLE = 4;

/** The splash's light ground. Matches `mobile:assets --splashBackgroundColor`. */
const SPLASH_BG = "#FFFFFF";
/**
 * The splash's dark ground. `--background` in dark mode (`0 0% 3.9%`), and the
 * same value capacitor.config.ts uses for the WebView ground — a splash that
 * hands over to a differently-coloured WebView is a visible seam.
 */
const SPLASH_BG_DARK = "#0A0A0A";
/** How much of the splash square the mark occupies. */
const SPLASH_MARK_FRACTION = 0.25;
/** The mark's own indigo. The tile's ground, and the adaptive icon's. */
const BRAND_INDIGO = "#4F46E5";

const tile = await readFile(path.join(brand, "mark-tile.svg"));
const adaptiveForeground = await readFile(
  path.join(brand, "mark-adaptive-foreground.svg"),
);

/** Rasterize an SVG buffer to an exact square, transparent behind it. */
async function render(svg, size) {
  const density = Math.round((BASE_DPI * size * SUPERSAMPLE) / SVG_VIEWBOX_PX);
  return sharp(svg, { density })
    .resize(size, size, { fit: "contain", background: "#00000000" })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function emit(relPath, buffer) {
  const out = path.join(root, relPath);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, buffer);
  console.log(`${relPath}  ${buffer.length} bytes`);
}

/**
 * Every square PNG target, and why it exists.
 *
 * Sizes are what each consumer asks for at its largest: the downstream
 * generators (icon-gen, capacitor-assets) produce the smaller
 * variants from these, so there is no point committing those by hand.
 */
const TARGETS = [
  // Chrome: toolbar (16/32), management page (48), Web Store (128).
  ["packages/extension/public/icons/16.png", 16],
  ["packages/extension/public/icons/32.png", 32],
  ["packages/extension/public/icons/48.png", 48],
  ["packages/extension/public/icons/128.png", 128],
  // electron-builder reads this directly for Linux, and `icons:desktop`
  // derives icon.icns / icon.ico from it.
  ["build/icon.png", 512],
  // Raycast's store listing and every command's icon.
  ["packages/raycast/assets/icon.png", 512],
  // Raycast's menu bar item. Rendered around 16pt, so 64px covers 2x displays
  // with room to spare; Raycast downscales.
  ["packages/raycast/assets/menu-bar.png", 64],
  // capacitor-assets' source for the iOS and Android launcher icons.
  ["resources/icon.png", 1024],
];

for (const [relPath, size] of TARGETS) {
  await emit(relPath, await render(tile, size));
}

/*
 * The splash is the one composite: capacitor-assets wants a large square whose
 * middle is safe area on every device aspect ratio, so the mark sits small and
 * centered on a flat ground rather than filling the frame.
 */
const SPLASH_PX = 2732;
const markPx = Math.round(SPLASH_PX * SPLASH_MARK_FRACTION);
const markOnSplash = await render(tile, markPx);

/** A flat square with the mark centered on it. */
async function ground(sizePx, background, mark) {
  return sharp({
    create: { width: sizePx, height: sizePx, channels: 4, background },
  })
    .composite(mark ? [{ input: mark, gravity: "centre" }] : [])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

await emit("resources/splash.png", await ground(SPLASH_PX, SPLASH_BG, markOnSplash));

/*
 * The dark splash. capacitor-assets loads `splash-dark` as an optional input
 * (dist/project.js) and, without it, simply produces no dark variant — so a
 * dark-mode phone launches into a full-screen white rectangle before the app's
 * own pre-paint theme script has run. Same composition, dark ground.
 */
await emit(
  "resources/splash-dark.png",
  await ground(SPLASH_PX, SPLASH_BG_DARK, markOnSplash),
);

/*
 * The Android adaptive icon's two layers. The launcher crops and parallaxes
 * them independently, so the mark lives in the foreground on transparency and
 * the indigo is a layer of its own — baking the mark into the ground makes it
 * slide out of frame under the mask. Both are optional inputs to
 * capacitor-assets; absent, it falls back to the flat logo and the phone gets
 * a legacy square icon in a launcher that rounds everything else.
 */
const ADAPTIVE_PX = 1024;
await emit(
  "resources/icon-foreground.png",
  await render(adaptiveForeground, ADAPTIVE_PX),
);
await emit(
  "resources/icon-background.png",
  await ground(ADAPTIVE_PX, BRAND_INDIGO, null),
);

/*
 * The docs site's Open Graph card. Docusaurus links the PNG (crawlers do not
 * render SVG), but the SVG next to it is the editable source, so the card is
 * rasterized here rather than exported by hand.
 */
const socialSvg = await readFile(
  path.join(root, "docs-site/static/img/social-card.svg"),
);
const socialPng = await sharp(socialSvg, { density: BASE_DPI * 2 })
  .resize(1200, 630)
  .png({ compressionLevel: 9 })
  .toBuffer();
await emit("docs-site/static/img/social-card.png", socialPng);

/*
 * The web app's two bitmap icons, as Next.js file conventions in `app/`.
 *
 * `favicon.ico` because link-preview crawlers and feed readers still ask for
 * `/favicon.ico` by name and show a blank square when it 404s, whatever
 * `icon.svg` says. `apple-icon.png` because iOS ignores SVG for a home-screen
 * icon — and it is rendered full-bleed, since iOS applies its own corner mask
 * and a pre-rounded tile would come out with dark corners.
 */
const fullBleedTile = Buffer.from(tile.toString("utf8").replace('rx="14"', 'rx="0"'));
await emit("packages/client/src/app/apple-icon.png", await render(fullBleedTile, 180));

/** An ICO whose entries are PNGs — valid since Windows Vista, and what every browser reads. */
function icoFromPngs(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const directory = Buffer.alloc(16 * entries.length);
  let offset = header.length + directory.length;
  entries.forEach(({ size, png }, index) => {
    const at = index * 16;
    directory.writeUInt8(size >= 256 ? 0 : size, at);
    directory.writeUInt8(size >= 256 ? 0 : size, at + 1);
    directory.writeUInt16LE(1, at + 4);
    directory.writeUInt16LE(32, at + 6);
    directory.writeUInt32LE(png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, directory, ...entries.map((entry) => entry.png)]);
}

await emit(
  "packages/client/src/app/favicon.ico",
  icoFromPngs(
    await Promise.all([16, 32, 48].map(async (size) => ({ size, png: await render(tile, size) }))),
  ),
);

/*
 * The desktop app's tray icons (electron/assets/tray, copied beside the main
 * bundle by scripts/build-desktop.mjs), idle and running.
 *
 * macOS takes a *template* image: black on transparent, which the menu bar
 * tints for light and dark itself — so the mark is drawn bare, without the
 * indigo tile, and the running variant closes the ring and fills the centre
 * instead of adding a colour macOS would strip. The `Template` suffix is what
 * tells Electron; `@2x` is picked up for Retina.
 *
 * Windows (`.ico`, 16 and 32) and Linux (22 and 44 PNG, the AppIndicator
 * sizes) draw in colour on backgrounds nobody controls, so they use the tile,
 * and the running variant adds the red dot the web header pulses while a
 * timer runs. `overlay-running.png` is the Windows taskbar overlay badge.
 */
const trayTemplateIdle = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <circle cx="32" cy="32" r="22" fill="none" stroke="#000" stroke-opacity="0.35" stroke-width="9"/>
  <path d="M32 10A22 22 0 1 1 12.95 43" fill="none" stroke="#000" stroke-width="9" stroke-linecap="round"/>
  <circle cx="32" cy="32" r="6" fill="#000"/>
</svg>`);
const trayTemplateRunning = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <circle cx="32" cy="32" r="22" fill="none" stroke="#000" stroke-width="9"/>
  <circle cx="32" cy="32" r="11" fill="#000"/>
</svg>`);
const RUNNING_RED = "#DC2626";
const tileRunning = Buffer.from(
  tile
    .toString("utf8")
    .replace(
      "</svg>",
      `<circle cx="51" cy="13" r="12" fill="${RUNNING_RED}" stroke="#FFFFFF" stroke-width="4"/></svg>`,
    ),
);
const overlayRunning = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <circle cx="32" cy="32" r="26" fill="${RUNNING_RED}" stroke="#FFFFFF" stroke-width="8"/>
</svg>`);

const trayDir = "electron/assets/tray";
for (const [name, svg] of [
  ["trayTemplate", trayTemplateIdle],
  ["trayRunningTemplate", trayTemplateRunning],
]) {
  await emit(`${trayDir}/${name}.png`, await render(svg, 16));
  await emit(`${trayDir}/${name}@2x.png`, await render(svg, 32));
}
for (const [name, svg] of [
  ["tray", tile],
  ["tray-running", tileRunning],
]) {
  await emit(`${trayDir}/${name}.png`, await render(svg, 22));
  await emit(`${trayDir}/${name}@2x.png`, await render(svg, 44));
  await emit(
    `${trayDir}/${name}.ico`,
    icoFromPngs(await Promise.all([16, 32].map(async (size) => ({ size, png: await render(svg, size) })))),
  );
}
await emit(`${trayDir}/overlay-running.png`, await render(overlayRunning, 16));

/*
 * The Microsoft Store package's tiles (electron-builder's `appx` target reads
 * build/appx/). Without them electron-builder silently ships its own sample
 * tiles — a grey placeholder square on the Start menu of every Store install.
 * Names and sizes are the ones AppxTarget maps; the wide tile is the mark
 * centred on the brand ground, which is also the manifest's backgroundColor.
 */
for (const [name, size] of [
  ["StoreLogo", 50],
  ["Square44x44Logo", 44],
  ["Square150x150Logo", 150],
]) {
  await emit(`build/appx/${name}.png`, await render(tile, size));
}
await emit(
  "build/appx/Wide310x150Logo.png",
  await sharp({ create: { width: 310, height: 150, channels: 4, background: BRAND_INDIGO } })
    .composite([{ input: await render(tile, 120), gravity: "centre" }])
    .png({ compressionLevel: 9 })
    .toBuffer(),
);
