"use client";

import { useSyncExternalStore } from "react";

// Match the shared phone content breakpoint. The server and hydration render
// agree; subscribers then follow resizing without resetting their UI state.
const query = "(width < 40rem)";
const subscribe = (notify: () => void): (() => void) => {
  if (typeof window.matchMedia !== "function") return () => {};
  const media = window.matchMedia(query);
  media.addEventListener("change", notify);
  return () => media.removeEventListener("change", notify);
};
const snapshot = (): boolean =>
  typeof window.matchMedia === "function" && window.matchMedia(query).matches;
const serverSnapshot = (): boolean => false;

export function usePhoneLayout(): boolean {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}
