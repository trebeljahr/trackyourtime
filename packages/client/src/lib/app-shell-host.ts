import { isNative } from "@/mobile/bridge";

/** True inside Capacitor or Electron — anywhere that is not the web app's own origin. */
export function isAppShell(): boolean {
  if (typeof window === "undefined") return false;
  if (isNative()) return true;
  if ("electronAPI" in window) return true;
  return !/^https?:$/.test(window.location.protocol);
}
