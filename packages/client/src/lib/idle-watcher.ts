"use client";

import { createIdleWatcher, type IdleWatcher } from "@starter/core";

/**
 * One idle watcher per tab.
 *
 * A module singleton rather than a hook's ref, because two different layers
 * have to reach it: `use-entry-mutations` claims the running entry when *this*
 * tab starts it, and `use-sync` reports proof of life whenever another device
 * does anything. Both of those are facts about the tab, not about whichever
 * component happens to be mounted, and the ownership rule is worthless if a
 * remount forgets who started the timer.
 *
 * For the web app "device" means "tab": two tabs on one laptop are two
 * detectors, and the ownership rule keeps the one that did not press Start out
 * of it — which is exactly the behaviour we want anyway.
 */
export const idleWatcher: IdleWatcher = createIdleWatcher();

let workspaceContext: string | null | undefined;
/** Public scope only. A held resume must never become a new workspace's draft. */
export function bindIdleWatcherWorkspace(workspaceId: string | null): boolean {
  if (workspaceContext === workspaceId) return false;
  workspaceContext = workspaceId;
  idleWatcher.reset();
  return true;
}
