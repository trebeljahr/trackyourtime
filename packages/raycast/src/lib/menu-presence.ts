import { useEffect, useState } from "react";
import { desktopHasYielded, publishMenuPresence } from "./menu-ownership.js";

/** Claim first, render only after desktop has removed its item. */
export function useMenuPresence(visible: boolean): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
      if (!publishMenuPresence(visible)) {
        setReady(false);
        return;
      }
      const check = (): boolean => {
        const yielded = visible && desktopHasYielded();
        setReady(yielded);
        if (yielded && timer) clearInterval(timer);
        return yielded;
      };
      if (!check() && visible) timer = setInterval(check, 100);
    } catch {
      setReady(false);
    }
    // The native item survives command unload. Only an explicit hidden render
    // releases ownership; the host PID lets desktop recover when Raycast quits.
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [visible]);
  return ready;
}
