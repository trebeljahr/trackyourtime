/**
 * The last snapshot the worker answered with, kept so the popup can paint it
 * the instant it opens.
 *
 * Chrome stops an idle MV3 worker after about thirty seconds, and its memory
 * caches go with it. Every popup opened after that woke a cold worker that
 * re-read the workspace list, the running entry, settings and seven catalog
 * and history endpoints before it answered anything — a second or two of a
 * bare "Loading…" on every click of the toolbar button, for data the popup
 * had shown a minute earlier.
 *
 * So the popup renders this copy first and the fresh `state:get` replaces it
 * when it lands (stale-while-revalidate). Every action still goes through the
 * worker, which acts on the server's truth, so a stale copy can mislead for
 * that second but cannot write anything wrong.
 *
 * `chrome.storage.session`, like the session token: memory-only, gone when
 * the browser quits, and readable by the popup but not by content scripts. It
 * is overwritten by every response — a sign-out writes the signed-out
 * snapshot — so it never outlives the account it describes.
 */
import type { BackgroundState } from "./messaging";
import { sessionStorageArea } from "./chrome-storage";

export const POPUP_SNAPSHOT_KEY = "trackyourtime.popup-snapshot";

/** Bump when `BackgroundState` changes shape in a way an old copy would break. */
const SNAPSHOT_VERSION = 1;

type Stored = { v: number; state: BackgroundState };

/** A null page means this view did not load entries, not an empty result. */
export function mergePopupSnapshot(
  previous: BackgroundState | null,
  next: BackgroundState,
): BackgroundState {
  if (
    next.entries !== null ||
    previous?.entries == null ||
    !previous.signedIn || !next.signedIn ||
    previous.apiUrl !== next.apiUrl ||
    !next.settings?.userId ||
    previous.settings?.userId !== next.settings.userId ||
    !next.activeWorkspaceId ||
    previous.activeWorkspaceId !== next.activeWorkspaceId
  ) return next;

  return { ...next, entries: previous.entries, entriesStale: true };
}

// Serialize read/merge/write so a slow storage write cannot undo a sign-out
// or overwrite a newer page with an earlier response.
let savePending: Promise<void> = Promise.resolve();

export function savePopupSnapshot(state: BackgroundState): Promise<void> {
  savePending = savePending.then(async () => {
    const area = sessionStorageArea();
    if (area === null) return;
    try {
      const previous = await loadPopupSnapshot();
      const stored: Stored = {
        v: SNAPSHOT_VERSION,
        state: mergePopupSnapshot(previous, state),
      };
      await area.set({ [POPUP_SNAPSHOT_KEY]: stored });
    } catch {
      // Quota or a torn-down area: the popup simply loads the slow way.
    }
  });
  return savePending;
}

export async function loadPopupSnapshot(): Promise<BackgroundState | null> {
  const area = sessionStorageArea();
  if (area === null) return null;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    // The cache is optional; a stalled storage read must not block mounting.
    const record: Record<string, unknown> = await Promise.race([
      area.get(POPUP_SNAPSHOT_KEY),
      new Promise<Record<string, unknown>>((resolve) => {
        timeout = setTimeout(() => resolve({}), 250);
      }),
    ]);
    const stored = record[POPUP_SNAPSHOT_KEY];
    if (
      typeof stored !== "object" ||
      stored === null ||
      (stored as { v?: unknown }).v !== SNAPSHOT_VERSION
    ) {
      return null;
    }
    const state = (stored as Stored).state;
    return typeof state === "object" && state !== null ? state : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
