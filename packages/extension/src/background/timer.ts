/**
 * Start, stop and edit-while-running, with the offline queue underneath.
 *
 * Every path builds exactly one input object and then either sends it or queues
 * it, so a mutation replayed tomorrow is identical to the one that failed
 * today. The cached running entry moves either way: the popup has to show a
 * running timer with the network off, which is the entire point of queueing
 * rather than erroring.
 */
import {
  createTempId,
  deviceTimeZone,
  isTempId,
  type OfflineStartInput,
  type OfflineStopInput,
  type OfflineUpdateInput,
  type TimeEntry,
} from "@starter/core";
import { renderBadge } from "./badge";
import { BackgroundError } from "./errors";
import { noteLocalStart, noteLocalStop } from "./idle-state";
import {
  addressedWrite,
  ensureReady,
  enqueueOffline,
  flushQueue,
  getCachedProjects,
  invalidateRecents,
  isTransportFailure,
  ORIGIN_ID,
  rememberOptimisticRunning,
  resolveRunning,
  setCachedRunning,
} from "./runtime";

const notSignedIn = (): BackgroundError =>
  new BackgroundError("NOT_SIGNED_IN", "Sign in before starting a timer.");

/**
 * The server resolves an omitted `billable` to `project.billableDefault ??
 * false`. The popup has no billable toggle, so we reproduce that rule here
 * instead of leaving the field out: the queued copy needs a concrete value,
 * and a replay tomorrow must not decide differently from the live call today.
 */
const billableDefaultFor = (projectId: string | null): boolean => {
  if (projectId === null) return false;
  const project = getCachedProjects()?.find((it) => it.id === projectId);
  return project?.billableDefault ?? false;
};

/**
 * What the server would have written, as far as the popup can tell. Only the
 * fields the popup renders are meaningful; `hourlyRate` and `currency` are
 * snapshotted server-side on stop, so guessing them here would be inventing
 * numbers. The temp id marks the entry as not-yet-real.
 */
const optimisticEntry = (
  input: OfflineStartInput,
  id: string,
  authorId: string,
): TimeEntry => ({
  id,
  // The workspace is resolved server-side from the session, so an offline
  // start cannot know it. It is overwritten by the real entry on flush, and
  // nothing in the popup reads it in the meantime.
  workspaceId: "",
  authorId,
  description: input.description,
  projectId: input.projectId,
  taskId: input.taskId,
  billable: input.billable,
  start: input.start,
  end: null,
  durationSec: 0,
  hourlyRate: null,
  currency: "EUR",
  source: input.source,
  timeZone: input.timeZone,
  // Server-owned: only the runaway guard ever writes it.
  runaway: null,
  tagIds: input.tagIds ?? [],
  // Nothing is invoiced at the moment a timer starts; the server echo fills
  // this in if it ever changes.
  invoiceId: null,
  importId: null,
  createdAt: input.start,
  updatedAt: input.start,
});

export async function startTimer(
  description: string,
  projectId: string | null,
  taskId: string | null = null,
  /**
   * Explicit for a quick start, omitted for the popup's own form.
   *
   * A favorite recorded its billable flag when it was pinned, and a recent
   * carries the flag its original entry was tracked with. Re-deriving either
   * from the project's current default would silently change what the user
   * asked for — and would make a queued replay disagree with the live call.
   */
  billable?: boolean,
  /** ISO instant to open the entry at. Idle resume passes the return time. */
  startIso?: string,
  /** Tags to open the entry with; a quick start passes the ones it carries. */
  tagIds: string[] = [],
): Promise<TimeEntry | null> {
  const current = await ensureReady();
  if (!current.session) throw notSignedIn();

  const input: OfflineStartInput = {
    description,
    projectId,
    taskId,
    tagIds,
    billable: billable ?? billableDefaultFor(projectId),
    start: startIso ?? new Date().toISOString(),
    // Its own source, not "api": an entry made from the toolbar stays
    // traceable back to the toolbar.
    source: "extension",
    // Recorded here rather than server-side so a mutation queued offline keeps
    // the zone it was started in, not the one it happens to sync from.
    timeZone: deviceTimeZone(),
    originId: ORIGIN_ID,
  };

  // Drain first. A live start sent ahead of older queued mutations would be
  // stopped again the moment they replay.
  const stuck = await flushQueue();
  const write = addressedWrite();
  if (stuck > 0) {
    return queueStart(input, current.session.userId ?? "", write.workspaceId);
  }

  try {
    const entry = await current.api.mutate<TimeEntry>(
      "entries.start",
      write.address(input),
    );
    setCachedRunning(entry);
    // Starting stops whatever was running, so the entry log — and with it the
    // derived recents list — has moved on.
    invalidateRecents();
    // This device opened the entry, so it is the one allowed to act on its own
    // idle signal for it.
    await noteLocalStart(entry.id, Date.parse(input.start));
    await renderBadge(entry);
    return entry;
  } catch (error) {
    // A server rejection (validation, conflict, expired token) means the
    // mutation was seen and refused — replaying it would only be refused
    // again, so it goes back to the popup instead of into the queue.
    if (!isTransportFailure(error)) throw error;
    return queueStart(input, current.session.userId ?? "", write.workspaceId);
  }
}

const queueStart = async (
  input: OfflineStartInput,
  authorId: string,
  workspaceId: string | null,
): Promise<TimeEntry> => {
  const tempId = createTempId();
  await enqueueOffline("entries.start", input, tempId, workspaceId);
  const entry = optimisticEntry(input, tempId, authorId);
  setCachedRunning(entry);
  // On disk as well as in memory: the queued row outlives this worker, so the
  // running timer it implies has to outlive it too.
  await rememberOptimisticRunning(entry);
  // Claimed against the temp id: a timer started offline still belongs to this
  // device before the server has named it.
  await noteLocalStart(tempId, Date.parse(input.start));
  await renderBadge(entry);
  return entry;
};

export async function stopTimer(
  /** ISO instant to end at. Idle detection passes where input stopped. */
  endIso?: string,
): Promise<void> {
  const current = await ensureReady();
  if (!current.session) throw notSignedIn();

  // No `id`, deliberately: on replay the server stops whatever the
  // already-replayed start opened, which is the only entry that can still be
  // running by then. Pinning an id would name an entry that may not exist.
  const input: OfflineStopInput = {
    end: endIso ?? new Date().toISOString(),
    originId: ORIGIN_ID,
  };

  // Only a stop the user asked for releases the watcher. Idle truncation stops
  // through this same function while the watcher is holding a resume, and
  // releasing there would drop it on the floor.
  if (endIso === undefined) await noteLocalStop(Date.now());

  const stuck = await flushQueue();
  const write = addressedWrite();
  if (stuck > 0) {
    await queueStop(input, write.workspaceId);
    return;
  }

  try {
    await current.api.mutate<TimeEntry>("entries.stop", write.address(input));
    setCachedRunning(null);
    invalidateRecents();
    await renderBadge(null);
  } catch (error) {
    if (!isTransportFailure(error)) throw error;
    await queueStop(input, write.workspaceId);
  }
}

const queueStop = async (
  input: OfflineStopInput,
  workspaceId: string | null,
): Promise<void> => {
  await enqueueOffline("entries.stop", input, undefined, workspaceId);
  setCachedRunning(null);
  // "A stop is queued" is itself a state worth surviving eviction — without it
  // a revived worker refetches and resurrects the entry this stop closed.
  await rememberOptimisticRunning(null);
  await renderBadge(null);
};

/**
 * An edit to the running entry. Absent fields are left alone — the same
 * contract `entries.update` has server-side, which is what lets a queued patch
 * replay as the edit that was made rather than as a whole-entry overwrite.
 */
export type RunningPatch = {
  description?: string;
  projectId?: string | null;
  taskId?: string | null;
  billable?: boolean;
  tagIds?: string[];
};

/**
 * What the server would answer with, applied locally so the popup's next
 * snapshot already shows the edit.
 *
 * `undefined` means "not in the patch" for every field, which is why the two
 * nullable ids are compared against `undefined` explicitly: `?? entry.taskId`
 * would turn a deliberate "no task" into "keep the old task".
 */
const patched = (entry: TimeEntry, patch: RunningPatch): TimeEntry => ({
  ...entry,
  description: patch.description ?? entry.description,
  projectId: patch.projectId === undefined ? entry.projectId : patch.projectId,
  taskId: patch.taskId === undefined ? entry.taskId : patch.taskId,
  billable: patch.billable ?? entry.billable,
  tagIds: patch.tagIds ?? entry.tagIds,
  updatedAt: new Date().toISOString(),
});

/**
 * Edit the entry that is currently running.
 *
 * The entry is resolved here rather than named by the popup: the popup's
 * snapshot can be a few seconds old, and an id from before another device
 * stopped the timer would edit a row that is no longer running.
 */
export async function updateRunning(patch: RunningPatch): Promise<void> {
  const current = await ensureReady();
  if (!current.session) throw notSignedIn();

  const running = await resolveRunning();
  if (running === null) {
    throw new BackgroundError(
      "NOT_RUNNING",
      "No timer is running, so there is nothing to edit.",
    );
  }

  // A timer started offline exists only as a queued `entries.start`, so an
  // update naming its temp id would be refused on replay and the edit lost.
  // The queued start still carries the fields it was opened with, so nothing
  // is stuck — the edit just has to wait for the entry to become real.
  if (isTempId(running.id)) {
    throw new BackgroundError(
      "STILL_SYNCING",
      "That timer has not reached the server yet. Try again in a moment.",
    );
  }

  const input: OfflineUpdateInput = {
    ...patch,
    id: running.id,
    originId: ORIGIN_ID,
  };
  const optimistic = patched(running, patch);

  // Drain first, for the same reason start and stop do: a live edit sent ahead
  // of older queued mutations would be overwritten when they replay.
  const stuck = await flushQueue();
  const write = addressedWrite();
  if (stuck > 0) {
    await queueUpdate(input, optimistic, write.workspaceId);
    return;
  }

  try {
    const entry = await current.api.mutate<TimeEntry>(
      "entries.update",
      write.address(input),
    );
    setCachedRunning(entry);
    // Recents are derived from the entry log, and this edit changed what the
    // most recent combination is labelled with.
    invalidateRecents();
  } catch (error) {
    if (!isTransportFailure(error)) throw error;
    await queueUpdate(input, optimistic, write.workspaceId);
  }
}

const queueUpdate = async (
  input: OfflineUpdateInput,
  optimistic: TimeEntry,
  workspaceId: string | null,
): Promise<void> => {
  await enqueueOffline("entries.update", input, undefined, workspaceId);
  setCachedRunning(optimistic);
  // On disk as well as in memory: the queued row outlives this worker, so the
  // edited entry it implies has to outlive it too, or a revived worker would
  // show the pre-edit fields until the queue drains.
  await rememberOptimisticRunning(optimistic);
};
