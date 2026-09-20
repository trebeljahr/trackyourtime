/*
 * The window's remembered size and place, as pure functions (window-state.test.ts).
 * window.ts does the reading, writing and listening.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowState {
  bounds?: Rect;
  maximized?: boolean;
  fullscreen?: boolean;
}

export const DEFAULT_SIZE = { width: 1280, height: 800 } as const;
export const MIN_SIZE = { width: 800, height: 500 } as const;

function isFiniteRect(value: unknown): value is Rect {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (["x", "y", "width", "height"] as const).every(
    (k) => typeof r[k] === "number" && Number.isFinite(r[k]),
  );
}

/** Whatever was on disk, reduced to fields that are the right shape. */
export function parseWindowState(raw: string | null): WindowState {
  if (raw === null) return {};
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof data !== "object" || data === null) return {};
  const d = data as Record<string, unknown>;
  const state: WindowState = {};
  if (isFiniteRect(d.bounds)) state.bounds = d.bounds;
  if (typeof d.maximized === "boolean") state.maximized = d.maximized;
  if (typeof d.fullscreen === "boolean") state.fullscreen = d.fullscreen;
  return state;
}

/**
 * The bounds to open with. Saved bounds are used only when at least a
 * 100×50 corner of the title area lands on a display that exists now — a
 * window last closed on an unplugged monitor otherwise opens off-screen, with
 * no way to drag it back. Too-small sizes are raised to the minimum.
 */
export function initialBounds(
  saved: Rect | undefined,
  workAreas: Rect[],
): Partial<Rect> & { width: number; height: number } {
  if (!saved) return { ...DEFAULT_SIZE };
  const width = Math.max(MIN_SIZE.width, Math.round(saved.width));
  const height = Math.max(MIN_SIZE.height, Math.round(saved.height));
  const titleArea: Rect = { x: saved.x, y: saved.y, width: Math.min(width, 100), height: 50 };
  const visible = workAreas.some((area) => overlap(titleArea, area) >= 100 * 50 * 0.99);
  if (!visible) return { width, height };
  return { x: Math.round(saved.x), y: Math.round(saved.y), width, height };
}

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * The window background, painted before the first frame of the page.
 * `globals.css` `--background`: `0 0% 100%` light, `0 0% 3.9%` dark. The
 * renderer's own theme preference is not readable from here, so this follows
 * the OS, which is also what the theme script falls back to.
 */
export function backgroundColorFor(dark: boolean): string {
  return dark ? "#0a0a0a" : "#ffffff";
}
