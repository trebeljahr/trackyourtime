/*
 * A LIFO registry of the overlays that are open right now — dialogs, the nav
 * drawer, anything that covers the screen and should absorb the next press of
 * Android's hardware back button that reaches the WebView, before the app
 * navigates or exits. "That reaches the WebView" is load-bearing: with the IME
 * showing, Android spends the first press dismissing the keyboard and never
 * delivers it here — see the press contract in mobile/back-button.ts.
 *
 * Why a registry and not the URL: a WebView reload always lands on `/`
 * (ios/App/App/Router.swift serves the root index.html for any extensionless
 * path), so a modal pushed into history would be restored over nothing. The
 * stack lives in memory for exactly as long as the overlays do.
 *
 * Why not `document.querySelectorAll('[role=dialog]')`: an overlay knows how
 * to close itself and the DOM does not. Radix dialogs, the drawer and any
 * future sheet each register their own dismiss.
 *
 * Inert on web by construction — nothing reads the stack except the back
 * button handler in components/app-shell.tsx, and `backButton` is an Android
 * event. Registration itself costs an array push.
 */

import * as React from "react";

type Dismiss = () => void;

type Entry = {
  id: number;
  dismiss: Dismiss;
};

let nextId = 1;
const stack: Entry[] = [];

/** Register an open overlay. Returns the id to hand back to `popOverlay`. */
export function pushOverlay(dismiss: Dismiss): number {
  const id = nextId++;
  stack.push({ id, dismiss });
  return id;
}

/**
 * Deregister an overlay. Removes it wherever it is in the stack, not only
 * from the top: React unmount order is not guaranteed to be the reverse of
 * mount order when two overlays close in the same commit.
 */
export function popOverlay(id: number): void {
  const index = stack.findIndex((entry) => entry.id === id);
  if (index !== -1) stack.splice(index, 1);
}

/**
 * Close the topmost overlay. Returns whether there was one — the back button
 * handler uses that to decide between "consumed" and "navigate".
 *
 * The entry is removed before its `dismiss` runs. Closing an overlay usually
 * unmounts it, which calls `popOverlay` too; popping first keeps that
 * re-entrant path from removing whatever took its place.
 */
export function dismissTopOverlay(): boolean {
  const entry = stack.pop();
  if (!entry) return false;
  entry.dismiss();
  return true;
}

/** How many overlays are open. Exposed for tests and debugging. */
export function overlayCount(): number {
  return stack.length;
}

/** Drop everything. Tests only — an app that needs this has a leak. */
export function resetOverlayStack(): void {
  stack.length = 0;
}

/**
 * Register `dismiss` for as long as `open` is true.
 *
 * The dismiss is read through a ref, so a handler that is a fresh closure on
 * every render does not churn the stack — an overlay must keep the same
 * position for its whole life or back would close them out of order.
 */
export function useOverlay(open: boolean, dismiss: Dismiss): void {
  const latest = React.useRef(dismiss);
  React.useEffect(() => {
    latest.current = dismiss;
  });

  React.useEffect(() => {
    if (!open) return;
    const id = pushOverlay(() => latest.current());
    return () => popOverlay(id);
  }, [open]);
}
