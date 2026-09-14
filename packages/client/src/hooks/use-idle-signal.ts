"use client";

import * as React from "react";
import type { IdleSignal } from "@starter/core";

/** One reading from whichever detector this build has available. */
export type IdleReading = {
  signal: IdleSignal;
  atMs: number;
  /** When input actually stopped, as far as the detector can tell. */
  idleSinceMs: number;
};

/** How often the detector reports. Well under any sane idle threshold. */
const POLL_MS = 15_000;

/** Input events that count as a sign of life in a browser tab. */
const INPUT_EVENTS = [
  "pointerdown",
  "pointermove",
  "keydown",
  "wheel",
  "touchstart",
  "scroll",
] as const;

/**
 * A browser tab is a poor idle detector, on purpose.
 *
 * The tab only sees input aimed at it, so somebody writing code in their editor
 * for an hour produces exactly the same silence as somebody who went to lunch.
 * Treating that silence as idleness would pause timers for people who are
 * working, which is the single worst thing this feature could do. So the web
 * detector only accumulates idleness while its window is both visible *and*
 * focused — "trackyourtime is the window you are looking at, and you are not
 * touching it" — and reports `active` the rest of the time.
 *
 * The Electron shell replaces this with `powerMonitor.getSystemIdleTime()`,
 * which sees every application, and the browser extension uses `chrome.idle`.
 * Those are the detectors that can honestly answer the question; this one is a
 * conservative fallback.
 */
const browserDetector = (
  emit: (reading: IdleReading) => void,
): (() => void) => {
  let lastInputMs = Date.now();

  const markActive = (): void => {
    lastInputMs = Date.now();
  };

  const canJudge = (): boolean =>
    document.visibilityState === "visible" && document.hasFocus();

  const poll = (): void => {
    const atMs = Date.now();
    if (!canJudge()) {
      // Unknowable, so it must not read as idle. Holding `lastInputMs` at now
      // also means the span does not start counting the moment the user
      // switches to another app.
      lastInputMs = atMs;
      emit({ signal: "active", atMs, idleSinceMs: atMs });
      return;
    }
    // "Active" means input landed inside the last polling window. Reporting
    // `idle` for a three-second gap would be technically true and useless: the
    // watcher reads a sub-threshold span as a sign of life anyway, and saying
    // `active` here keeps the two detectors telling the same story.
    emit({
      signal: atMs - lastInputMs < POLL_MS ? "active" : "idle",
      atMs,
      idleSinceMs: lastInputMs,
    });
  };

  for (const event of INPUT_EVENTS) {
    window.addEventListener(event, markActive, { passive: true });
  }
  document.addEventListener("visibilitychange", markActive);
  window.addEventListener("focus", markActive);

  const handle = setInterval(poll, POLL_MS);

  return () => {
    clearInterval(handle);
    for (const event of INPUT_EVENTS) {
      window.removeEventListener(event, markActive);
    }
    document.removeEventListener("visibilitychange", markActive);
    window.removeEventListener("focus", markActive);
  };
};

const normalizeState = (state: string): IdleSignal =>
  state === "locked" || state === "idle" ? state : "active";

/**
 * The desktop shell's detector: the OS idle counter, forwarded over IPC.
 *
 * Returns null when this build is not running inside a shell that provides it,
 * so the caller can fall back to the browser detector.
 */
const desktopDetector = (
  emit: (reading: IdleReading) => void,
): (() => void) | null => {
  const api = window.electronAPI;
  if (api?.onIdleState === undefined || api.getIdleState === undefined) {
    return null;
  }

  const receive = (payload: {
    state: string;
    idleSeconds: number;
  }): void => {
    const atMs = Date.now();
    emit({
      signal: normalizeState(payload.state),
      atMs,
      idleSinceMs: atMs - Math.max(0, payload.idleSeconds) * 1000,
    });
  };

  // Ask once immediately: the shell polls on its own schedule, and a window
  // opened mid-idle should not wait a full interval to find that out.
  void api.getIdleState().then(receive).catch(() => undefined);
  return api.onIdleState(receive);
};

/**
 * A hook for injecting readings from a test, exposed on `window`.
 *
 * Idle detection cannot be exercised end to end without either waiting out a
 * real threshold or faking the clock, and the second is far cheaper. The bridge
 * can only feed the same signal the OS already feeds — it grants no ability the
 * page does not have — so it ships unconditionally rather than behind a build
 * flag that would then go untested.
 */
export type IdleTestBridge = {
  simulate: (signal: IdleSignal, idleSeconds?: number) => void;
};

declare global {
  interface Window {
    __trackYourTimeIdle?: IdleTestBridge;
  }
}

/**
 * Report idleness to `onReading`. Picks the best detector the platform offers
 * and keeps the test bridge pointed at the same callback.
 */
export const useIdleSignal = (
  onReading: (reading: IdleReading) => void,
  enabled: boolean,
): void => {
  const callbackRef = React.useRef(onReading);
  React.useEffect(() => {
    callbackRef.current = onReading;
  }, [onReading]);

  React.useEffect(() => {
    if (!enabled) return;

    const emit = (reading: IdleReading): void => callbackRef.current(reading);

    window.__trackYourTimeIdle = {
      simulate: (signal, idleSeconds = 0) => {
        const atMs = Date.now();
        emit({
          signal,
          atMs,
          idleSinceMs: atMs - Math.max(0, idleSeconds) * 1000,
        });
      },
    };

    const stop = desktopDetector(emit) ?? browserDetector(emit);

    return () => {
      stop();
      delete window.__trackYourTimeIdle;
    };
  }, [enabled]);
};
