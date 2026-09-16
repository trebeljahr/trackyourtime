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
  decodeVersioned,
  encodeVersioned,
  noteReplayedServerId,
  type IdleWatcher,
  type IdleResumeSeed,
  type IdleWatcherState,
  type KeyValueStorage,
  type OfflineMutation,
  type PendingIdle,
  type VersionedSpec,
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

const idOrNull = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

const isInstant = (value: unknown): value is string =>
  typeof value === "string" && !Number.isNaN(Date.parse(value));

const readSeed = (value: unknown): IdleResumeSeed | null => {
  if (typeof value !== "object" || value === null) return null;
  const seed = value as Record<string, unknown>;
  if (typeof seed.description !== "string") return null;
  if (seed.projectId !== null && typeof seed.projectId !== "string") return null;
  if (seed.taskId !== null && typeof seed.taskId !== "string") return null;
  if (typeof seed.billable !== "boolean") return null;
  return {
    description: seed.description,
    projectId: seed.projectId,
    taskId: seed.taskId,
    billable: seed.billable,
  };
};

const readPending = (value: unknown): PendingIdle | null => {
  if (typeof value !== "object" || value === null) return null;
  const pending = value as Record<string, unknown>;
  const seed = readSeed(pending.seed);
  const entryId = idOrNull(pending.entryId);
  if (
    seed === null ||
    entryId === null ||
    !isInstant(pending.idleStartedAt) ||
    !isInstant(pending.detectedAt) ||
    !isInstant(pending.truncateAt) ||
    typeof pending.idleSec !== "number" ||
    !Number.isFinite(pending.idleSec) ||
    (pending.signal !== "idle" && pending.signal !== "locked")
  ) {
    return null;
  }
  return {
    entryId,
    idleStartedAt: pending.idleStartedAt,
    detectedAt: pending.detectedAt,
    idleSec: pending.idleSec,
    signal: pending.signal,
    truncateAt: pending.truncateAt,
    seed,
  };
};

/**
 * Field by field rather than trusted wholesale: a row written by another build
 * must not leave a field undefined, or hand the watcher a prompt it would
 * render with `NaN` minutes. A field that is wrong falls back to its empty
 * value alone — the watcher's memory is a cache of decisions, and the worst a
 * reset field costs is one prompt asked again or one idle span not noticed.
 */
const readState = (value: unknown): IdleWatcherState | null => {
  if (typeof value !== "object" || value === null) return null;
  const state = value as Record<string, unknown>;
  return {
    ownedEntryId: idOrNull(state.ownedEntryId),
    idleFloorMs:
      typeof state.idleFloorMs === "number" && Number.isFinite(state.idleFloorMs)
        ? state.idleFloorMs
        : EMPTY_STATE.idleFloorMs,
    pending: readPending(state.pending),
    settledEntryId: idOrNull(state.settledEntryId),
    awaitingResume: readSeed(state.awaitingResume),
    pausedEntryId: idOrNull(state.pausedEntryId),
  };
};

/** Version 1 is the watcher state itself, which builds before it wrote bare. */
const STATE_SPEC: VersionedSpec<IdleWatcherState> = {
  version: 1,
  decode: readState,
  legacy: readState,
};

/** Exported for tests: what a stored value restores the watcher to. */
export const decodeIdleState = (raw: string | null): IdleWatcherState =>
  decodeVersioned(raw, STATE_SPEC) ?? EMPTY_STATE;

const loadState = async (): Promise<IdleWatcherState> =>
  decodeIdleState(await getStore().getItem(IDLE_STATE_KEY));

let watcher: IdleWatcher | null = null;

/** The watcher, rebuilt from storage the first time this worker needs it. */
export const getIdleWatcher = async (): Promise<IdleWatcher> => {
  watcher ??= createIdleWatcher(await loadState());
  return watcher;
};

/** Write the watcher's memory back to disk. Call after every state change. */
export const persistIdleWatcher = async (): Promise<void> => {
  if (watcher) {
    await getStore().setItem(
      IDLE_STATE_KEY,
      encodeVersioned(STATE_SPEC.version, watcher.state()),
    );
  }
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
