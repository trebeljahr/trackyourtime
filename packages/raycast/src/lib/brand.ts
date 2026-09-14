import type { Image } from "@raycast/api";

/**
 * The trackyourtime mark, for any Raycast surface that shows the app itself
 * rather than an action.
 *
 * `assets/menu-bar.png` is generated from
 * `packages/client/public/brand/mark-tile.svg` by `pnpm run icons:brand`,
 * alongside the extension's toolbar PNGs and the desktop and mobile icons —
 * so the menu bar item, the pinned browser button and the dock icon are one
 * mark, not three lookalikes.
 *
 * The tile variant, not the bare timer arc: the arc's neutral track ring is
 * drawn for a page background and vanishes against a menu bar, which may be
 * light, dark, or whatever wallpaper is behind it. The tile brings its own
 * indigo ground, so no light/dark pair is needed.
 *
 * Deliberately the same icon whether a timer is running or not. Running state
 * is carried by the menu bar title (the elapsed clock) and the tooltip. The
 * one gap is `titleMode: "icon"`, which hides the title — that setting trades
 * state legibility for width by definition, and did so before this icon too.
 */
export const BRAND_MARK: Image.ImageLike = { source: "menu-bar.png" };
