"use client";

import { useEntryMutations } from "@/components/tracker/use-entry-mutations";
import { useIdleGuard } from "@/components/tracker/use-idle-guard";
import { useRunawayGuard } from "@/components/tracker/use-runaway-guard";

/**
 * The idle and runaway guards, for the desktop app while the tracker bar is
 * not mounted.
 *
 * On the web both guards live in `TrackerBar`, so they run only on
 * /app/track. The desktop app hides its window in the tray on whatever screen
 * it was left on, and Stage 5's notifications are posted by these guards: on
 * /app/reports nothing watched for idleness and nothing raised a runaway
 * prompt, so the hidden window stayed silent. `DesktopBridgePublisher` mounts
 * this in Electron only, and only off /app/track, so exactly one copy of each
 * guard runs at a time.
 */
export function DesktopAttentionGuards(): null {
  const mutations = useEntryMutations();
  useRunawayGuard(mutations);
  useIdleGuard();
  return null;
}
