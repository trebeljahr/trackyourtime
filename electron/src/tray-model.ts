/*
 * What the tray draws, as data: the menu, the macOS title, the tooltip and
 * which icon. `tray.ts` turns this into Electron objects; headless runs expose
 * it to specs instead of creating a tray. Pure, so unit-tested.
 *
 * The renderer publishes `DesktopTimerState` and owns every decision about
 * the timer; this file only lays it out and computes the ticking clock from
 * `startedAt`, so the title moves every second without a message per second.
 */

import type {
  DesktopNotice,
  DesktopRecent,
  DesktopTimerState,
  DesktopTrayLabels,
} from "../../packages/shared/src/desktop-bridge.ts";

/**
 * English, for the moments no renderer has published labels yet: before the
 * first page load, or signed out on the first launch. The last labels a
 * renderer sent are remembered on disk (desktop.ts), so a German person sees
 * English here only on a first launch.
 */
export const FALLBACK_TRAY_LABELS: DesktopTrayLabels = {
  stop: "Stop timer",
  startTimer: "Start timer…",
  recentHeading: "Continue",
  open: "Open Track Your Time",
  settings: "Settings…",
  quit: "Quit Track Your Time",
  noDescription: "(no description)",
  idleTooltip: "Track Your Time",
  unsent: "",
  quitUnsentTitle: "Some changes have not been sent yet",
  quitUnsentBody: "They are kept on this computer and sent the next time Track Your Time starts.",
  quitUnsentButton: "Quit",
  runningBadge: "Timer running",
  restartToUpdate: "Restart to update",
};

export const MAX_TRAY_RECENTS = 5;
const MAX_TEXT = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.slice(0, MAX_TEXT) : fallback;
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" ? value.slice(0, MAX_TEXT) : null;
}

export function parseTrayLabels(value: unknown): DesktopTrayLabels {
  const labels = { ...FALLBACK_TRAY_LABELS };
  if (!isRecord(value)) return labels;
  for (const key of Object.keys(labels) as (keyof DesktopTrayLabels)[]) {
    const candidate = value[key];
    // Longer than a tray label: the quit notice's body is a sentence.
    if (typeof candidate === "string") labels[key] = candidate.slice(0, 600);
  }
  return labels;
}

/** The renderer's payload, checked field by field: it crossed IPC. */
export function parseTimerState(value: unknown): DesktopTimerState | null {
  if (!isRecord(value) || typeof value.signedIn !== "boolean") return null;
  let running: DesktopTimerState["running"] = null;
  if (isRecord(value.running)) {
    const startedAt = text(value.running.startedAt);
    if (Number.isFinite(Date.parse(startedAt))) {
      const color = nullableText(value.running.projectColor);
      running = {
        description: text(value.running.description),
        startedAt,
        projectName: nullableText(value.running.projectName),
        projectColor: color !== null && /^#[0-9a-f]{6}$/i.test(color) ? color : null,
      };
    }
  }
  const recents: DesktopRecent[] = [];
  if (Array.isArray(value.recents)) {
    for (const item of value.recents) {
      if (recents.length >= MAX_TRAY_RECENTS) break;
      if (!isRecord(item) || typeof item.key !== "string" || item.key === "") continue;
      recents.push({ key: item.key.slice(0, 500), label: text(item.label), hint: nullableText(item.hint) });
    }
  }
  const unsent = typeof value.unsent === "number" && Number.isFinite(value.unsent) ? Math.max(0, Math.floor(value.unsent)) : 0;
  return {
    signedIn: value.signedIn,
    running: value.signedIn ? running : null,
    recents: value.signedIn ? recents : [],
    unsent,
    labels: parseTrayLabels(value.labels),
  };
}

/** `m:ss` under an hour, `h:mm` from there — the menu bar has little room. */
export function trayClock(elapsedSec: number): string {
  const total = Math.max(0, Math.floor(elapsedSec));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours === 0) return `${minutes}:${String(seconds).padStart(2, "0")}`;
  return `${hours}:${String(minutes).padStart(2, "0")}`;
}

export function elapsedSecAt(startedAt: string, nowMs: number): number {
  const start = Date.parse(startedAt);
  return Number.isFinite(start) ? Math.max(0, (nowMs - start) / 1000) : 0;
}

/** What the running entry is called: description, else project, else the placeholder. */
export function runningLabel(state: DesktopTimerState): string {
  const running = state.running;
  if (running === null) return "";
  const description = running.description.trim();
  if (description !== "") return description;
  return running.projectName ?? state.labels.noDescription;
}

export type TrayMenuItem =
  | { type: "item"; id: string; label: string; enabled: boolean }
  | { type: "heading"; label: string }
  | { type: "separator" };

/**
 * Running entry with Stop, up to five recents to continue, "Start timer…",
 * the unsent count when non-zero, Open, Settings, Quit. Signed out (or before
 * any state arrived): Open and Quit.
 *
 * With a downloaded update, "Restart to update" sits above Quit in either
 * menu: the person picks the moment, the app never restarts by itself.
 *
 * Item ids are what `tray.ts` hands back on a click: `stop`, `start`,
 * `continue:<key>`, `open`, `settings`, `restart-to-update`, `quit`.
 */
export function trayMenuModel(state: DesktopTimerState | null, options: { updateReady?: boolean } = {}): TrayMenuItem[] {
  const labels = state?.labels ?? FALLBACK_TRAY_LABELS;
  const restart: TrayMenuItem[] = options.updateReady
    ? [{ type: "item", id: "restart-to-update", label: labels.restartToUpdate, enabled: true }]
    : [];
  if (state === null || !state.signedIn) {
    return [
      { type: "item", id: "open", label: labels.open, enabled: true },
      { type: "separator" },
      ...restart,
      { type: "item", id: "quit", label: labels.quit, enabled: true },
    ];
  }
  const items: TrayMenuItem[] = [];
  if (state.running !== null) {
    items.push({ type: "heading", label: runningLabel(state) });
    items.push({ type: "item", id: "stop", label: labels.stop, enabled: true });
    items.push({ type: "separator" });
  }
  if (state.recents.length > 0) {
    items.push({ type: "heading", label: labels.recentHeading });
    for (const recent of state.recents) {
      const label = recent.label.trim() === "" ? labels.noDescription : recent.label;
      items.push({
        type: "item",
        id: `continue:${recent.key}`,
        label: recent.hint ? `${label} — ${recent.hint}` : label,
        enabled: true,
      });
    }
    items.push({ type: "separator" });
  }
  items.push({ type: "item", id: "start", label: labels.startTimer, enabled: true });
  if (state.unsent > 0 && labels.unsent !== "") {
    items.push({ type: "separator" });
    items.push({ type: "heading", label: labels.unsent });
  }
  items.push({ type: "separator" });
  items.push({ type: "item", id: "open", label: labels.open, enabled: true });
  items.push({ type: "item", id: "settings", label: labels.settings, enabled: true });
  items.push({ type: "separator" });
  items.push(...restart);
  items.push({ type: "item", id: "quit", label: labels.quit, enabled: true });
  return items;
}

/**
 * The text beside the macOS menu bar icon: the clock while running, nothing
 * when idle (Raycast's defaults). `Tray.setTitle` exists only on macOS.
 */
export function trayTitle(state: DesktopTimerState | null, nowMs: number, platform: string): string {
  if (platform !== "darwin" || state?.running == null) return "";
  return trayClock(elapsedSecAt(state.running.startedAt, nowMs));
}

/** Windows and Linux carry the clock in the tooltip instead. */
export function trayTooltip(state: DesktopTimerState | null, nowMs: number): string {
  const labels = state?.labels ?? FALLBACK_TRAY_LABELS;
  if (state?.running == null) return labels.idleTooltip;
  return `${trayClock(elapsedSecAt(state.running.startedAt, nowMs))} · ${runningLabel(state)}`;
}

export type TrayIconVariant = "idle" | "running";

export function trayIconVariant(state: DesktopTimerState | null): TrayIconVariant {
  return state?.running ? "running" : "idle";
}

/** The icon file for a platform, under electron/dist/tray (scripts/icons-brand.mjs). */
export function trayIconFile(platform: string, variant: TrayIconVariant): string {
  const running = variant === "running";
  if (platform === "darwin") return running ? "trayRunningTemplate.png" : "trayTemplate.png";
  if (platform === "win32") return running ? "tray-running.ico" : "tray.ico";
  return running ? "tray-running.png" : "tray.png";
}

/** A notice from the renderer, checked; null when malformed. */
export function parseNotice(value: unknown): DesktopNotice | null {
  if (!isRecord(value)) return null;
  if (value.kind !== "idle" && value.kind !== "runaway") return null;
  const title = text(value.title).trim();
  if (title === "") return null;
  return { kind: value.kind, title, body: text(value.body), tag: text(value.tag, value.kind).slice(0, 100) };
}
