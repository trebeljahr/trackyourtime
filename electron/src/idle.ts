/*
 * Idle detection.
 *
 * The renderer cannot see this. A browser tab only knows about input that
 * reaches it, so a person typing all afternoon in their editor looks idle to
 * the web app; `powerMonitor.getSystemIdleTime()` is the OS's own answer and
 * counts every application. This process therefore does the *detecting* and
 * the renderer does the *deciding* — the policy lives in @starter/core/idle,
 * shared with the browser extension.
 *
 * Nothing here pauses anything: it reports "the machine has seen no input for
 * N seconds" and lets the renderer apply the user's settings to that.
 */

import { BrowserWindow, powerMonitor } from "electron";

import { DESKTOP_IPC, type DesktopIdlePayload } from "../../packages/shared/src/desktop-bridge.ts";
import { handle } from "./ipc.ts";

type IdleState = "active" | "idle" | "locked";

export interface IdleSample {
  state: IdleState;
  idleSeconds: number;
}

/** In-process listeners (activity capture), fed the same samples the renderer gets. */
const listeners = new Set<(sample: IdleSample) => void>();

/**
 * Every sample — each poll and each lock, suspend, unlock or resume — as it
 * is broadcast to the renderer. Returns the unsubscribe.
 */
export function onIdleChange(listener: (sample: IdleSample) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** How often the idle counter is sampled. Cheap; the call is a syscall. */
const IDLE_POLL_MS = 15_000;

let idleTimer: ReturnType<typeof setInterval> | null = null;
/** Sticky until the screen unlocks — the OS idle counter does not report it. */
let screenLocked = false;

/*
 * "Active" means input landed inside the last polling window, not that the
 * counter reads exactly zero. `getSystemIdleTime()` returns 0 only in the
 * second after a keystroke, so a poller testing for zero would report "idle"
 * at someone typing continuously — and the renderer would never see the sign
 * of life that reopens a paused entry.
 */
function readIdle(): DesktopIdlePayload & { state: IdleState } {
  const idleSeconds = powerMonitor.getSystemIdleTime();
  if (screenLocked) return { state: "locked", idleSeconds };
  return {
    state: idleSeconds * 1000 >= IDLE_POLL_MS ? "idle" : "active",
    idleSeconds,
  };
}

function broadcastIdle(): void {
  const payload = readIdle();
  for (const listener of listeners) {
    try {
      listener(payload);
    } catch (error) {
      console.warn("[idle] listener failed", error);
    }
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(DESKTOP_IPC.idleState, payload);
  }
}

/** powerMonitor is only usable after the app is ready. */
export function startIdleMonitor(): void {
  if (idleTimer !== null) return;

  // `lock-screen` and `suspend` are the deliberate walk-aways. They are
  // forwarded immediately rather than waiting for the next poll, because the
  // renderer may treat a lock as away without the threshold.
  const lock = (): void => {
    screenLocked = true;
    broadcastIdle();
  };
  const unlock = (): void => {
    screenLocked = false;
    broadcastIdle();
  };

  powerMonitor.on("lock-screen", lock);
  powerMonitor.on("suspend", lock);
  powerMonitor.on("unlock-screen", unlock);
  powerMonitor.on("resume", unlock);

  idleTimer = setInterval(broadcastIdle, IDLE_POLL_MS);

  handle(DESKTOP_IPC.getIdle, () => readIdle());
}
