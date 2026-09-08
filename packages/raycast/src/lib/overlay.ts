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
 */
import {
  applyOverlay,
  emptyOverlay,
  isOverlayEmpty,
  isTempId,
  overlayRunning,
  parseOverlay,
  resolveRunning,
  withOptimisticEntry,
  withOptimisticPatch,
  withOptimisticRemoval,
  withoutResolved,
  type DetailedEntry,
  type OfflineOverlay,
} from "@starter/core";
import { raycastStorage } from "./storage.js";

export {
  applyOverlay,
  overlayRunning,
  resolveRunning,
  type OfflineOverlay,
};

const OVERLAY_KEY = "tracktime.offline.overlay";

/** Never throws: a surface that cannot read this must still draw the server's answer. */
export const loadOverlay = async (): Promise<OfflineOverlay> => {
  try {
    const raw = await raycastStorage.getItem(OVERLAY_KEY);
    if (raw === null) return emptyOverlay();
    return parseOverlay(JSON.parse(raw) as unknown);
  } catch {
    return emptyOverlay();
  }
};

const save = async (overlay: OfflineOverlay): Promise<void> => {
  try {
    if (isOverlayEmpty(overlay)) await raycastStorage.removeItem(OVERLAY_KEY);
    else await raycastStorage.setItem(OVERLAY_KEY, JSON.stringify(overlay));
  } catch {
    /* storage unavailable — the queue still holds the work itself */
  }
};

const edit = async (
  change: (overlay: OfflineOverlay) => OfflineOverlay,
): Promise<void> => save(change(await loadOverlay()));

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
    await save(emptyOverlay());
    return;
  }
  await edit((overlay) => withoutResolved(overlay, resolved));
};

export const clearOverlay = (): Promise<void> => save(emptyOverlay());

/** True when this entry only exists here — the server has never heard of it. */
export const isLocalEntry = (entry: { id: string }): boolean =>
  isTempId(entry.id);
