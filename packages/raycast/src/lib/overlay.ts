/**
 * Raycast's binding for the shared offline overlay.
 *
 * The rules live in `@starter/core` — what a queued stop does to a running
 * entry, how a second edit stacks on the first, which local entries belong in
 * a given window. What is here is the store they are read from and written to:
 * Raycast's `LocalStorage`, because every command is its own process and there
 * is no runtime for two of them to share state through.
 *
 * Read on every render of every surface, so it is one small value and never a
 * network call.
 *
 * One overlay per workspace, like the read cache: the local copies of queued
 * edits and creates are rows of the workspace they were made in, and applying
 * them to another workspace's list would show A's work under B.
 */
import {
  applyOverlay,
  decodeStoredOverlay,
  emptyOverlay,
  encodeStoredOverlay,
  isOverlayEmpty,
  isTempId,
  overlayRunning,
  resolveRunning,
  withOptimisticEntry,
  withOptimisticPatch,
  withOptimisticRemoval,
  withoutResolved,
  type DetailedEntry,
  type OfflineOverlay,
} from "@starter/core";
import { raycastStorage } from "./storage.js";
import { clearEveryWorkspace, workspaceKey } from "./workspace.js";

export {
  applyOverlay,
  overlayRunning,
  resolveRunning,
  type OfflineOverlay,
};

const OVERLAY_KEY = "trackyourtime.offline.overlay";

const loadOverlayAt = async (key: string): Promise<OfflineOverlay> => {
  try {
    return decodeStoredOverlay(await raycastStorage.getItem(key));
  } catch {
    return emptyOverlay();
  }
};

/** Never throws: a surface that cannot read this must still draw the server's answer. */
export const loadOverlay = async (): Promise<OfflineOverlay> => {
  try {
    return await loadOverlayAt(await workspaceKey(OVERLAY_KEY));
  } catch {
    return emptyOverlay();
  }
};

const saveAt = async (key: string, overlay: OfflineOverlay): Promise<void> => {
  try {
    if (isOverlayEmpty(overlay)) await raycastStorage.removeItem(key);
    else await raycastStorage.setItem(key, encodeStoredOverlay(overlay));
  } catch {
    /* storage unavailable — the queue still holds the work itself */
  }
};

const save = async (overlay: OfflineOverlay): Promise<void> =>
  saveAt(await workspaceKey(OVERLAY_KEY), overlay);

/** One key for the read and the write — see `remember` in local-cache.ts. */
const edit = async (
  change: (overlay: OfflineOverlay) => OfflineOverlay,
): Promise<void> => {
  const key = await workspaceKey(OVERLAY_KEY);
  await saveAt(key, change(await loadOverlayAt(key)));
};

export const noteOptimisticEntry = (entry: DetailedEntry): Promise<void> =>
  edit((overlay) => withOptimisticEntry(overlay, entry));

export const noteOptimisticPatch = (
  id: string,
  patch: Partial<DetailedEntry>,
): Promise<void> => edit((overlay) => withOptimisticPatch(overlay, id, patch));

export const noteOptimisticRemoval = (id: string): Promise<void> =>
  edit((overlay) => withOptimisticRemoval(overlay, id));

/**
 * Forget the local copies of work that has now reached the server. A drained
 * queue clears the lot; a partial drain drops only the starts whose replay
 * produced a real id.
 */
export const reconcileOverlay = async ({
  resolved,
  drained,
}: {
  resolved: ReadonlyMap<string, string>;
  drained: boolean;
}): Promise<void> => {
  if (drained) {
    // Every workspace's: a drained queue can have replayed rows made in a
    // workspace other than the one chosen now, and their local copies must not
    // outlive them there either.
    await clearEveryOverlay();
    return;
  }
  await edit((overlay) => withoutResolved(overlay, resolved));
};

/** The current workspace's overlay. */
export const clearOverlay = (): Promise<void> => save(emptyOverlay());

/** Every workspace's overlay — for a sign-out. */
export const clearEveryOverlay = (): Promise<void> =>
  clearEveryWorkspace(OVERLAY_KEY);

/** True when this entry only exists here — the server has never heard of it. */
export const isLocalEntry = (entry: { id: string }): boolean =>
  isTempId(entry.id);
