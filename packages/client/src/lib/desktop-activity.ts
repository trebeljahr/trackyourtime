import type { DesktopActivity } from "@starter/shared";

import { isElectron } from "@/lib/shell";

/**
 * The desktop app's activity bridge, or null anywhere else — and in a desktop
 * build whose preload predates it (`DesktopBridge.activity` is optional).
 * Every caller in the web app goes through this, so a browser, the PWA and
 * the phones never reach for it.
 */
export function desktopActivity(): DesktopActivity | null {
  if (!isElectron()) return null;
  return window.electronAPI?.activity ?? null;
}

/**
 * Delete this device's recorded activity for the departing account: every
 * segment, rule and dismissal, and the scope, so nothing records until the
 * next account is known. Called from the sign-out and account-deletion
 * cleanup directly rather than through `onSignOut`, whose registering
 * component may already be unmounted by then. Never throws.
 */
export async function forgetDesktopActivity(): Promise<void> {
  const activity = desktopActivity();
  if (activity === null) return;
  await activity.forget().catch(() => undefined);
}
