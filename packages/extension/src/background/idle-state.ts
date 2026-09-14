/**
 * The idle watcher's memory, and nothing else.
 *
 * Split from `./idle` on purpose. The detector has to call `startTimer` /
 * `stopTimer` to act on a decision, while `timer.ts` has to report back which
 * entry this worker opened — pointing both at one module would be an import
 * cycle. Everything here depends on `chrome.storage` alone.
 *
 * Persistence is not an optimisation. MV3 evicts the worker after about 30
 * seconds and revives it by re-evaluating the module, so a watcher that kept
 * ownership in a closure would wake believing it had never started anything,
 * fail the ownership rule forever, and silently never act.
 */
import {
  createIdleWatcher,
  noteReplayedServerId,
  type IdleWatcher,
  type IdleWatcherState,
  type KeyValueStorage,
  type OfflineMutation,
  type PendingIdle,
} from "@starter/core";
import { chromeStorage, localStorageArea } from "../lib/chrome-storage";

const IDLE_STATE_KEY = "trackyourtime.idle-watcher";

const EMPTY_STATE: IdleWatcherState = {
  ownedEntryId: null,
  idleFloorMs: 0,
  pending: null,
  settledEntryId: null,
  awaitingResume: null,
  pausedEntryId: null,
};

let store: KeyValueStorage | null = null;

const getStore = (): KeyValueStorage => {
  store ??= chromeStorage(localStorageArea());
  return store;
};

const loadState = async (): Promise<IdleWatcherState> => {
  const raw = await getStore().getItem(IDLE_STATE_KEY);
  if (raw === null) return EMPTY_STATE;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return EMPTY_STATE;
    // Merged onto the empty state rather than trusted wholesale: a row written
    // by an older build must not leave a field undefined.
    return { ...EMPTY_STATE, ...(parsed as Partial<IdleWatcherState>) };
  } catch {
    return EMPTY_STATE;
  }
};

let watcher: IdleWatcher | null = null;

/** The watcher, rebuilt from storage the first time this worker needs it. */
export const getIdleWatcher = async (): Promise<IdleWatcher> => {
  watcher ??= createIdleWatcher(await loadState());
  return watcher;
};

/** Write the watcher's memory back to disk. Call after every state change. */
export const persistIdleWatcher = async (): Promise<void> => {
  if (watcher) await getStore().setItem(IDLE_STATE_KEY, JSON.stringify(watcher.state()));
};

/** Forget everything — used when the session goes away. */
export async function resetIdleWatcher(): Promise<void> {
  watcher?.reset();
  await getStore().removeItem(IDLE_STATE_KEY);
}

/** This worker opened `entryId`, so it may act on its own idle signal for it. */
export async function noteLocalStart(
  entryId: string,
  atMs: number,
): Promise<void> {
  (await getIdleWatcher()).noteLocalStart(entryId, atMs);
  await persistIdleWatcher();
}

/**
 * A queued mutation just replayed. Renames the claim when it was the start
 * that opened the running entry, so a timer begun offline keeps its idle
 * detection once the server names it.
 *
 * The decision itself lives in core, next to the queue contract it reads, and
 * only the persistence is here — the worker is evicted every 30 seconds, so a
 * rename that is not written back is a rename that never happened.
 */
export async function noteReplayedStart(
  mutation: OfflineMutation,
  result: unknown,
): Promise<void> {
  const watcher = await getIdleWatcher();
  if (noteReplayedServerId(watcher, mutation, result)) {
    await persistIdleWatcher();
  }
}

/** The user stopped the timer themselves. */
export async function noteLocalStop(atMs: number): Promise<void> {
  (await getIdleWatcher()).noteLocalStop(atMs);
  await persistIdleWatcher();
}

/** Another device did something, so the person was at a keyboard at `atMs`. */
export async function noteRemoteActivity(atMs: number): Promise<void> {
  (await getIdleWatcher()).noteRemoteActivity(atMs);
  await persistIdleWatcher();
}

/** The idle span the popup should be asking about, if any. */
export async function pendingIdle(): Promise<PendingIdle | null> {
  return (await getIdleWatcher()).pending();
}
