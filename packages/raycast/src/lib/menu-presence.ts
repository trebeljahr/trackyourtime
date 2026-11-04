import { useEffect, useState } from "react";
import { desktopHasYielded, publishMenuPresence } from "./menu-ownership.js";

/** How long a load waits for the desktop app before Raycast may unload it. */
const YIELD_WAIT_MS = 5_000;

/**
 * Claim the menu bar from the desktop app, and report whether it has let go.
 *
 * The answer never hides the item. Returning null removes the native status
 * item, and a command with no item can be unloaded before it can draw one. The
 * caller holds the load while this is false instead. Two items can overlap for
 * one desktop poll on the first claim, and never after that.
 */
export function useMenuPresence(): boolean {
  const [yielded, setYielded] = useState(() => desktopHasYielded());
  useEffect(() => {
    try {
      publishMenuPresence(true);
    } catch {
      setYielded(true);
      return;
    }
    if (desktopHasYielded()) {
      setYielded(true);
      return;
    }
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (!desktopHasYielded() && Date.now() - startedAt < YIELD_WAIT_MS) return;
      clearInterval(timer);
      setYielded(true);
    }, 100);
    return () => clearInterval(timer);
  }, []);
  return yielded;
}
