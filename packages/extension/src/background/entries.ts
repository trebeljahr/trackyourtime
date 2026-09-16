/**
 * The past-entry surface: a bounded window of finished entries, and the three
 * mutations that can change one.
 *
 * Shaped exactly like {@link ./timer}: one input object per mutation, the queue
 * drained before anything goes out live, and a fall to `enqueueOffline` only
 * when the request never reached the server. What is new here is the overlay.
 * `rememberOptimisticRunning` models a single entry — the running one — because
 * that was the only entry this extension could change; a queued edit or delete
 * of a *past* row needs a store that can hold several, and one that survives
 * eviction, or a revived worker repaints the pre-edit values while the mutation
 * is still waiting to be sent.
 *
 * The window is fixed at {@link ENTRY_WINDOW_DAYS} days and capped at
 * {@link ENTRY_MAX_ROWS} rows, matching Raycast rather than the web app's
 * sentinel range: a 380px list with no filter and no search should not be able
 * to grow without limit, and the cap is stated on screen so it reads as a
 * decision rather than a bug.
 */
import {
  createTempId,
  dayKeyInZone,
  deviceTimeZone,
  addDaysToKey,
  isTempId,
  zonedDayStartMs,
  type DetailedEntry,
  type OfflineCreateInput,
  type OfflineIdInput,
  type OfflineUpdateInput,
  type TimeEntry,
} from "@starter/core";
import type { ActivityInterval } from "@starter/core/activity/index";
import type {
  AcceptedFields,
  ActivitySnapshot,
  EntryPage,
  PopupView,
} from "../lib/messaging";
import { capturePermitted, loadActivityScope, loadActivitySettings } from "./activity/settings";
import { countSegments, probeActivityStorage } from "./activity/store";
import {
  activityRules,
  suggestionsFor,
  type SuggestionRange,
} from "./activity/suggestions";
import { BackgroundError } from "./errors";
import {
  appendCachedEntries,
  cancelQueuedForTemp,
  clearEntriesStale,
  clearOptimisticEntries,
  deleteOptimisticEntry,
  addressedWrite,
  ensureReady,
  enqueueOffline,
  entriesCacheIsFresh,
  flushQueue,
  getActiveWorkspaceId,
  getKnownUserId,
  getCachedClients,
  getCachedEntries,
  getCachedProjects,
  getCachedSettings,
  getCachedTasks,
  invalidateRecents,
  isTransportFailure,
  loadOptimisticEntries,
  markEntriesStale,
  ORIGIN_ID,
  peekRunning,
  pendingSyncCount,
  setCachedEntries,
  upsertOptimisticEntry,
} from "./runtime";

/** A window a person can hold in their head, the same one Raycast browses. */
const ENTRY_WINDOW_DAYS = 14;

/** Rows per `entries.list` call; "Load older" fetches another page. */
const ENTRY_PAGE_LIMIT = 25;

/** Where paging stops. Beyond this the list points at the web app. */
const ENTRY_MAX_ROWS = 100;

const notSignedIn = (): BackgroundError =>
  new BackgroundError("NOT_SIGNED_IN", "Sign in before editing entries.");

const stillSyncing = (): BackgroundError =>
  new BackgroundError(
    "STILL_SYNCING",
    "That entry has not reached the server yet. Try again in a moment.",
  );

const badTimeRange = (): BackgroundError =>
  new BackgroundError("BAD_TIME_RANGE", "The end has to be after the start.");

/** The window's bounds, recomputed per read so "today" moves with the clock. */
const windowBounds = (nowMs: number = Date.now()): { from: string; to: string } => {
  const zone = deviceTimeZone();
  const firstKey = addDaysToKey(dayKeyInZone(nowMs, zone), -(ENTRY_WINDOW_DAYS - 1));
  return {
    from: new Date(zonedDayStartMs(firstKey, zone)).toISOString(),
    to: new Date(nowMs).toISOString(),
  };
};

type ListPage = { entries: DetailedEntry[]; nextCursor?: string };

/**
 * A row built from a plain entry plus whatever the catalog cache knows.
 *
 * Only ever used for overlay rows. Every row that came from the server already
 * arrives denormalized, and re-deriving those from the cache would replace the
 * server's labels with older ones. `amount` is zero rather than guessed: the
 * rate is snapshotted server-side, so computing earnings here would be
 * inventing a number.
 */
export const decorateEntry = (entry: TimeEntry): DetailedEntry => {
  const project =
    entry.projectId === null
      ? null
      : (getCachedProjects()?.find((it) => it.id === entry.projectId) ?? null);
  const clientId = project?.clientId ?? null;
  const client =
    clientId === null
      ? null
      : (getCachedClients()?.find((it) => it.id === clientId) ?? null);
  const task =
    entry.taskId === null
      ? null
      : (getCachedTasks()?.find((it) => it.id === entry.taskId) ?? null);

  return {
    ...entry,
    projectName: project?.name ?? null,
    projectColor: project?.color ?? null,
    clientName: client?.name ?? null,
    taskName: task?.name ?? null,
    amount: 0,
  };
};

const byStartDescending = (a: DetailedEntry, b: DetailedEntry): number =>
  Date.parse(b.start) - Date.parse(a.start);

/**
 * Lay queued work over a fetched page.
 *
 * Deletes win over upserts because a row cannot be both, and the two lists are
 * kept disjoint on write for exactly that reason. An upsert the page has never
 * heard of — an offline manual create — is prepended when its start falls
 * inside the window, so a row the user just logged is visible immediately
 * rather than after the queue drains.
 */
const applyOverlay = async (
  rows: DetailedEntry[],
  from: string,
  to: string,
): Promise<{ entries: DetailedEntry[]; pendingIds: string[] }> => {
  // A leftover key with nothing left to justify it must never paint over
  // server truth — the same rule `rehydrateOptimisticRunning` applies to the
  // running entry, and the reason both are safe to clear wholesale.
  if ((await pendingSyncCount()) === 0) {
    await clearOptimisticEntries();
    return { entries: rows, pendingIds: [] };
  }

  const overlay = await loadOptimisticEntries();
  if (overlay.upserts.length === 0 && overlay.deletes.length === 0) {
    return { entries: rows, pendingIds: [] };
  }

  const upserts = new Map(overlay.upserts.map((entry) => [entry.id, entry]));
  const kept = rows
    .filter((row) => !overlay.deletes.includes(row.id))
    .map((row) => {
      const patched = upserts.get(row.id);
      if (patched === undefined) return row;
      upserts.delete(row.id);
      // The server's labels are still the better ones; only the fields the
      // queued mutation actually changed come from the overlay.
      return { ...decorateEntry(patched), amount: row.amount };
    });

  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  const activeWorkspaceId = getActiveWorkspaceId();
  const added = [...upserts.values()]
    // An offline create made in another workspace is that workspace's row.
    // An optimistic entry built before any workspace was known says "", and
    // is shown: it can only have been made where the person was then.
    .filter(
      (entry) =>
        entry.workspaceId === "" ||
        activeWorkspaceId === null ||
        entry.workspaceId === activeWorkspaceId,
    )
    .filter((entry) => {
      const startMs = Date.parse(entry.start);
      return startMs >= fromMs && startMs <= toMs;
    })
    // Only finished entries belong in this list; a queued start is the running
    // entry, and the tracker is where that one is edited.
    .filter((entry) => entry.end !== null)
    .map(decorateEntry);

  return {
    entries: [...kept, ...added].sort(byStartDescending),
    pendingIds: overlay.upserts.map((entry) => entry.id),
  };
};

const fetchPage = async (
  from: string,
  to: string,
  cursor: string | null,
): Promise<ListPage> => {
  const current = await ensureReady();
  return current.api.query<ListPage>("entries.list", {
    from,
    to,
    limit: ENTRY_PAGE_LIMIT,
    ...(cursor === null ? {} : { cursor }),
  });
};

/**
 * Refetch the window to the depth it has already been paged to.
 *
 * A refresh that only ever fetched page one would silently undo "Load older":
 * the poll finds the cache expired, replaces an extended window with 25 rows,
 * and the button appears to do nothing. So the cursors are walked again, as
 * many times as the cache says it has been paged, before anything replaces it.
 * Bounded by {@link ENTRY_MAX_ROWS}, which is four requests at most.
 */
const fetchWindow = async (
  from: string,
  to: string,
  depth: number,
): Promise<{
  entries: DetailedEntry[];
  cursor: string | null;
  hasMore: boolean;
  pages: number;
}> => {
  const entries: DetailedEntry[] = [];
  let cursor: string | null = null;
  let pages = 0;

  while (pages < depth) {
    const page = await fetchPage(from, to, cursor);
    entries.push(...ownOnly(finishedOnly(page.entries)));
    pages += 1;
    cursor = page.nextCursor ?? null;
    if (cursor === null || entries.length >= ENTRY_MAX_ROWS) break;
  }

  return {
    entries,
    cursor,
    hasMore: cursor !== null && entries.length < ENTRY_MAX_ROWS,
    pages,
  };
};

/**
 * The running entry never belongs in this list. `entries.list` matches on
 * overlap, so it would otherwise be listed here *and* shown on the tracker —
 * one row with two editors, and two different id semantics while a start is
 * still queued.
 */
const finishedOnly = (entries: DetailedEntry[]): DetailedEntry[] =>
  entries.filter((entry) => entry.end !== null);

/**
 * The popup browses the signed-in person's own entries. A member allowed to
 * see colleagues' time gets their rows from the same `entries.list`, and a
 * 380px list of everybody's work — each row offering an editor the server
 * would refuse — is not what "Entries" beside a personal timer means. Until
 * the worker knows who it is signed in as, nothing is hidden.
 */
const ownOnly = (entries: DetailedEntry[]): DetailedEntry[] => {
  const userId = getKnownUserId();
  return userId === null
    ? entries
    : entries.filter((entry) => entry.authorId === userId);
};

/**
 * The window as the cache alone can describe it, with no round trip.
 *
 * This is what `buildState` falls back to when the refetch fails, and it has to
 * be the overlaid page rather than the raw rows: a failed fetch is exactly the
 * offline case, and that is precisely when the queued edits the overlay stands
 * for are the only version of the truth the user has seen.
 */
export async function cachedEntryPage(): Promise<EntryPage | null> {
  const cached = getCachedEntries();
  if (cached === null) return null;

  const { from, to } = windowBounds();
  const overlaid = await applyOverlay(cached.entries, from, to);
  return {
    entries: overlaid.entries,
    from,
    to,
    hasMore: cached.hasMore,
    pendingIds: overlaid.pendingIds,
  };
}

/**
 * The window the popup renders, served from cache unless it has gone stale or
 * timed out.
 *
 * Stale-but-present rows are still served on the way to the refetch, because
 * blanking a list under somebody mid-scroll is worse than showing it a second
 * late.
 */
export async function resolveEntryPage(): Promise<EntryPage> {
  const current = await ensureReady();
  if (!current.session) throw notSignedIn();

  const { from, to } = windowBounds();

  if (entriesCacheIsFresh()) {
    const page = await cachedEntryPage();
    // `entriesCacheIsFresh` already proved there is a cache, so this is only
    // defensive — but a `null` here would mean fetching, not throwing.
    if (page !== null) return page;
  }

  // However deep the window already goes, that is what has to come back — a
  // refetch is a refresh of what is on screen, not a reset of it.
  const depth = getCachedEntries()?.pages ?? 1;
  const fetched = await fetchWindow(from, to, Math.max(1, depth));
  setCachedEntries(
    fetched.entries,
    fetched.cursor,
    fetched.hasMore,
    fetched.pages,
  );
  clearEntriesStale();

  const overlaid = await applyOverlay(fetched.entries, from, to);
  return {
    entries: overlaid.entries,
    from,
    to,
    hasMore: fetched.hasMore,
    pendingIds: overlaid.pendingIds,
  };
}

/**
 * Fetch one more page and append it in the worker.
 *
 * The append cannot happen in the popup: the contract is whole snapshots, and
 * a popup that concatenated pages would be holding domain state it loses every
 * time it closes.
 */
export async function loadMoreEntries(): Promise<void> {
  const current = await ensureReady();
  if (!current.session) throw notSignedIn();

  const cached = getCachedEntries();
  // Nothing to extend yet — the next snapshot fetches page one anyway.
  if (cached === null || cached.cursor === null) return;
  if (cached.entries.length >= ENTRY_MAX_ROWS) return;

  const { from, to } = windowBounds();
  const page = await fetchPage(from, to, cached.cursor);
  const entries = ownOnly(finishedOnly(page.entries));
  const total = cached.entries.length + entries.length;
  appendCachedEntries(
    entries,
    page.nextCursor ?? null,
    page.nextCursor !== undefined && total < ENTRY_MAX_ROWS,
  );
}

// ── mutations ────────────────────────────────────────────────────────

export type CreateEntryInput = {
  description: string;
  projectId: string | null;
  taskId: string | null;
  billable?: boolean;
  tagIds?: string[];
  start: string;
  end: string;
};

/**
 * The server resolves an omitted `billable` to `project.billableDefault ??
 * false`. Reproduced here rather than left out, for the reason `timer.ts` gives:
 * the queued copy needs a concrete value, and a replay tomorrow must not decide
 * differently from the live call today.
 */
const billableDefaultFor = (projectId: string | null): boolean => {
  if (projectId === null) return false;
  const project = getCachedProjects()?.find((it) => it.id === projectId);
  return project?.billableDefault ?? false;
};

/** What the server would have written, as far as the popup can tell. */
const optimisticEntry = (
  input: OfflineCreateInput,
  id: string,
  authorId: string,
): TimeEntry => ({
  id,
  // Resolved server-side from the session, so an offline create cannot know it.
  workspaceId: "",
  authorId,
  description: input.description,
  projectId: input.projectId,
  taskId: input.taskId,
  billable: input.billable,
  start: input.start,
  end: input.end,
  durationSec: Math.max(
    0,
    Math.floor((Date.parse(input.end) - Date.parse(input.start)) / 1000),
  ),
  // Snapshotted server-side from the project and workspace rate; guessing it
  // here would be inventing money.
  hourlyRate: null,
  currency: "EUR",
  source: input.source,
  timeZone: input.timeZone,
  runaway: null,
  tagIds: input.tagIds ?? [],
  invoiceId: null,
  importId: null,
  createdAt: input.start,
  updatedAt: input.start,
});

export async function createEntry(input: CreateEntryInput): Promise<void> {
  const current = await ensureReady();
  if (!current.session) throw notSignedIn();

  // Checked here as well as server-side so the user hears it from the surface
  // they typed it on, without a round trip — and so a queued row cannot sit
  // there for hours only to be refused on replay.
  if (Date.parse(input.end) <= Date.parse(input.start)) throw badTimeRange();

  const payload: OfflineCreateInput = {
    description: input.description,
    projectId: input.projectId,
    taskId: input.taskId,
    tagIds: input.tagIds,
    billable: input.billable ?? billableDefaultFor(input.projectId),
    start: input.start,
    end: input.end,
    // Its own source, not "api": an entry logged from the toolbar stays
    // traceable back to the toolbar.
    source: "extension",
    // Recorded here so a create queued offline keeps the zone it was written
    // in, not the one it happens to sync from.
    timeZone: deviceTimeZone(),
    originId: ORIGIN_ID,
  };

  // Drain first, as start and stop do: a live create sent ahead of older queued
  // mutations would land out of the order the user performed it in.
  const stuck = await flushQueue();
  const write = addressedWrite();
  if (stuck > 0) {
    await queueCreate(payload, current.session.userId ?? "", write.workspaceId);
    return;
  }

  try {
    await current.api.mutate<TimeEntry>("entries.create", write.address(payload));
    markEntriesStale();
    // Recents are derived from the entry log, and a logged entry is now the
    // most recent thing that combination was used for.
    invalidateRecents();
  } catch (error) {
    // A server refusal was seen and rejected; replaying it would only be
    // rejected again, so it goes back to the popup instead of into the queue.
    if (!isTransportFailure(error)) throw error;
    await queueCreate(payload, current.session.userId ?? "", write.workspaceId);
  }
}

const queueCreate = async (
  input: OfflineCreateInput,
  authorId: string,
  workspaceId: string | null,
): Promise<void> => {
  const tempId = createTempId();
  await enqueueOffline("entries.create", input, tempId, workspaceId);
  await upsertOptimisticEntry(optimisticEntry(input, tempId, authorId));
  markEntriesStale();
};

export type EntryPatch = {
  id: string;
  description?: string;
  projectId?: string | null;
  taskId?: string | null;
  billable?: boolean;
  tagIds?: string[];
  start?: string;
  end?: string;
};

/**
 * What the server would answer with, applied locally so the next snapshot
 * already shows the edit.
 *
 * Unlike `timer.ts`'s equivalent this one models `start` and `end`: the running
 * entry's form cannot move them, this one's can. `undefined` means "not in the
 * patch" for every field, which is why the two nullable ids are compared
 * against `undefined` explicitly — `?? entry.taskId` would turn a deliberate
 * "no task" into "keep the old task".
 */
const patched = (entry: TimeEntry, patch: EntryPatch): TimeEntry => {
  const start = patch.start ?? entry.start;
  const end = patch.end ?? entry.end;
  return {
    ...entry,
    description: patch.description ?? entry.description,
    projectId: patch.projectId === undefined ? entry.projectId : patch.projectId,
    taskId: patch.taskId === undefined ? entry.taskId : patch.taskId,
    billable: patch.billable ?? entry.billable,
    tagIds: patch.tagIds ?? entry.tagIds,
    start,
    end,
    durationSec:
      end === null
        ? 0
        : Math.max(0, Math.floor((Date.parse(end) - Date.parse(start)) / 1000)),
    updatedAt: new Date().toISOString(),
  };
};

/** The cached row an edit or a delete is being made against, if we have it. */
const findCached = (id: string): DetailedEntry | null =>
  getCachedEntries()?.entries.find((entry) => entry.id === id) ?? null;

/**
 * The row a queued edit should be patched onto.
 *
 * The overlay wins over the cache when it has this id: a second edit made
 * before the first has been sent is a patch on top of the first, and seeding it
 * from the untouched server row instead would erase the earlier edit from the
 * list — the queue would still replay both, so the user would be looking at a
 * value that is wrong only on screen, on a row they can no longer touch.
 */
const rowToPatch = async (id: string): Promise<TimeEntry | null> => {
  const overlay = await loadOptimisticEntries();
  return overlay.upserts.find((entry) => entry.id === id) ?? findCached(id);
};

export async function updateEntry(patch: EntryPatch): Promise<void> {
  const current = await ensureReady();
  if (!current.session) throw notSignedIn();

  // An entry created offline exists only as a queued `entries.create`, so an
  // update naming its temp id would be refused on replay and the edit lost.
  // The queued create still carries the fields it was written with, so nothing
  // is stuck — the edit just has to wait for the entry to become real.
  if (isTempId(patch.id)) throw stillSyncing();

  if (
    patch.start !== undefined &&
    patch.end !== undefined &&
    Date.parse(patch.end) <= Date.parse(patch.start)
  ) {
    throw badTimeRange();
  }

  const input: OfflineUpdateInput = {
    id: patch.id,
    description: patch.description,
    projectId: patch.projectId,
    taskId: patch.taskId,
    billable: patch.billable,
    tagIds: patch.tagIds,
    start: patch.start,
    end: patch.end,
    originId: ORIGIN_ID,
  };

  const existing = await rowToPatch(patch.id);

  const stuck = await flushQueue();
  const write = addressedWrite();
  if (stuck > 0) {
    await queueUpdate(input, existing, patch, write.workspaceId);
    return;
  }

  try {
    await current.api.mutate<TimeEntry>("entries.update", write.address(input));
    markEntriesStale();
    invalidateRecents();
  } catch (error) {
    if (!isTransportFailure(error)) throw error;
    await queueUpdate(input, existing, patch, write.workspaceId);
  }
}

const queueUpdate = async (
  input: OfflineUpdateInput,
  existing: TimeEntry | null,
  patch: EntryPatch,
  workspaceId: string | null,
): Promise<void> => {
  await enqueueOffline("entries.update", input, undefined, workspaceId);
  // Without the pre-edit row there is nothing to patch, so the queued mutation
  // stands alone and the list simply shows the server's version until it
  // replays. Queuing it is what matters; the overlay is a courtesy.
  if (existing !== null) await upsertOptimisticEntry(patched(existing, patch));
  markEntriesStale();
};

export async function removeEntry(id: string): Promise<void> {
  const current = await ensureReady();
  if (!current.session) throw notSignedIn();

  // A row that only exists as a queued `entries.create` is deleted by dropping
  // that mutation. Sending `entries.remove` for it would name an id the server
  // has never seen, and leaving the create queued would resurrect the row the
  // user just deleted the moment the network returned.
  if (isTempId(id)) {
    await cancelQueuedForTemp(id);
    await deleteOptimisticEntry(id);
    markEntriesStale();
    return;
  }

  const input: OfflineIdInput = { id, originId: ORIGIN_ID };

  const stuck = await flushQueue();
  const write = addressedWrite();
  if (stuck > 0) {
    await queueRemove(input, write.workspaceId);
    return;
  }

  try {
    await current.api.mutate("entries.remove", write.address(input));
    markEntriesStale();
    invalidateRecents();
  } catch (error) {
    if (!isTransportFailure(error)) throw error;
    await queueRemove(input, write.workspaceId);
  }
}

const queueRemove = async (
  input: OfflineIdInput,
  workspaceId: string | null,
): Promise<void> => {
  await enqueueOffline("entries.remove", input, undefined, workspaceId);
  await deleteOptimisticEntry(input.id);
  markEntriesStale();
};

// ── activity suggestions ─────────────────────────────────────────────
//
// The network half of the Suggestions screen. Capture, storage and the
// suggestion arithmetic live under ./activity and never touch the API; what
// they need from the server — which time is already tracked — is fetched here
// and handed in, and an accepted suggestion leaves through `createEntry` like
// any other manual entry, offline queue included.

const HOUR_MS = 3_600_000;

/** How long a fetched set of tracked intervals answers the three-second poll. */
const TRACKED_TTL_MS = 15_000;

/** `entries.list` rows per page, and how many pages one day may take. */
const TRACKED_PAGE_LIMIT = 200;
const TRACKED_MAX_PAGES = 5;

let trackedCache: { key: string; at: number; intervals: ActivityInterval[] } | null = null;

/** The day the Suggestions screen shows; null means today. Lost on eviction, re-sent by the popup. */
let activityDay: string | null = null;

export const setActivityDay = (day: string): void => {
  activityDay = /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
};

const dayRange = (day: string, zone: string): SuggestionRange => ({
  from: zonedDayStartMs(day, zone),
  to: zonedDayStartMs(addDaysToKey(day, 1), zone),
});

const toInterval = (entry: { start: string; end: string | null }, now: number): ActivityInterval => ({
  start: Date.parse(entry.start),
  end: entry.end === null ? now : Date.parse(entry.end),
});

/**
 * Everything this person has tracked that overlaps `range`, as intervals.
 *
 * Online, a fresh `entries.list`; offline, whatever the entry window cache
 * holds. Either way the offline overlay is laid on top — a create still
 * waiting in the queue is tracked time, and suggesting it again would invite a
 * duplicate — and the running entry counts up to now. Only the signed-in
 * person's own rows count: a colleague's entry in a shared workspace says
 * nothing about what this browser was used for.
 */
export async function trackedIntervalsBetween(
  range: SuggestionRange,
  options: { fresh?: boolean } = {},
): Promise<ActivityInterval[]> {
  const now = Date.now();
  const key = `${range.from}:${range.to}`;
  if (
    options.fresh !== true &&
    trackedCache !== null &&
    trackedCache.key === key &&
    now - trackedCache.at < TRACKED_TTL_MS
  ) {
    return trackedCache.intervals;
  }

  const current = await ensureReady();
  if (!current.session) throw notSignedIn();

  const from = new Date(range.from).toISOString();
  const to = new Date(range.to).toISOString();

  let rows: DetailedEntry[] = [];
  let fetched = false;
  try {
    let cursor: string | null = null;
    for (let page = 0; page < TRACKED_MAX_PAGES; page += 1) {
      const result: ListPage = await current.api.query<ListPage>("entries.list", {
        from,
        to,
        limit: TRACKED_PAGE_LIMIT,
        ...(cursor === null ? {} : { cursor }),
      });
      rows.push(...result.entries);
      cursor = result.nextCursor ?? null;
      if (cursor === null) break;
    }
    fetched = true;
  } catch (error) {
    if (!isTransportFailure(error)) throw error;
    rows = getCachedEntries()?.entries ?? [];
  }

  // The overlay filters added rows by start, so look back far enough to catch
  // a queued entry that began before the range and runs into it.
  const overlaid = await applyOverlay(
    rows,
    new Date(range.from - 24 * HOUR_MS).toISOString(),
    to,
  );

  const userId = getCachedSettings()?.userId ?? current.session.userId;
  const mine = (entry: TimeEntry): boolean =>
    userId === null || entry.authorId === "" || entry.authorId === userId;

  const intervals = overlaid.entries.filter(mine).map((entry) => toInterval(entry, now));
  const running = peekRunning();
  if (running !== null && mine(running)) intervals.push(toInterval(running, now));

  const clipped = intervals.filter(
    (interval) => interval.end > range.from && interval.start < range.to,
  );
  if (fetched) trackedCache = { key, at: now, intervals: clipped };
  return clipped;
}

const forgetTracked = (): void => {
  trackedCache = null;
};

/**
 * The activity half of the snapshot.
 *
 * Suggestions are computed only while the Suggestions screen is open, and the
 * stored-row count only for Settings; a snapshot for any other view carries the
 * two cheap local reads and nulls.
 */
export async function resolveActivitySnapshot(view: PopupView): Promise<ActivitySnapshot> {
  const now = Date.now();
  const zone = deviceTimeZone();
  const today = dayKeyInZone(now, zone);
  const day = activityDay !== null && activityDay <= today ? activityDay : today;

  const [settings, permitted, scope] = await Promise.all([
    loadActivitySettings(),
    capturePermitted(),
    loadActivityScope(),
  ]);

  // Only opened when something would open it anyway, so a person who never
  // turned capture on does not get an empty database from looking at a popup.
  const storageProblem =
    settings.enabled || view === "settings" || view === "suggestions"
      ? await probeActivityStorage()
      : null;

  const snapshot: ActivitySnapshot = {
    settings,
    permitted,
    day,
    suggestions: null,
    rules: null,
    storedSegments: null,
    storageProblem,
  };

  if (view === "suggestions") {
    if (scope === null || storageProblem !== null) {
      return { ...snapshot, suggestions: [], rules: [] };
    }
    const range = dayRange(day, zone);
    const tracked = await trackedIntervalsBetween(range);
    return {
      ...snapshot,
      suggestions: await suggestionsFor(scope, range, tracked, now),
      rules: await activityRules(scope),
    };
  }

  if (view === "settings") {
    return {
      ...snapshot,
      rules:
        scope === null || storageProblem !== null ? [] : await activityRules(scope),
      storedSegments:
        storageProblem !== null ? null : await countSegments().catch(() => 0),
    };
  }

  return snapshot;
}

export type AcceptSuggestionInput = AcceptedFields & {
  start: number;
  end: number;
  edited: boolean;
};

/**
 * Turn a suggestion into a real entry, after checking it is still untracked.
 *
 * The snapshot the popup rendered can be seconds old, and in that time the same
 * span may have been tracked from the web app or another device. So the
 * suggestions are rebuilt against the entries as they are now, and:
 *
 * - nothing untracked overlaps the request any more → refused, nothing created;
 * - a plain accept → clipped to the untracked block it overlaps most;
 * - an edited accept → the person's own times, which they chose on purpose.
 *
 * Then it is an ordinary `createEntry`: `source: "extension"`, the device
 * zone, and the offline queue when the server cannot be reached.
 */
export async function acceptSuggestion(input: AcceptSuggestionInput): Promise<void> {
  const current = await ensureReady();
  if (!current.session) throw notSignedIn();
  if (!(input.end > input.start)) throw badTimeRange();

  const scope = await loadActivityScope();
  if (scope === null) {
    throw new BackgroundError("ACTIVITY_UNAVAILABLE", "Activity capture has no account to file under yet.");
  }

  const now = Date.now();
  const range: SuggestionRange = {
    from: Math.min(input.start, input.end) - 12 * HOUR_MS,
    to: Math.min(now, Math.max(input.start, input.end) + 12 * HOUR_MS),
  };
  const tracked = await trackedIntervalsBetween(range, { fresh: true });
  const blocks = await suggestionsFor(scope, range, tracked, now);

  const overlap = (block: { start: number; end: number }): number =>
    Math.min(block.end, input.end) - Math.max(block.start, input.start);
  const best = blocks
    .filter((block) => overlap(block) > 0)
    .sort((a, b) => overlap(b) - overlap(a))[0];

  if (best === undefined) {
    throw new BackgroundError(
      "SUGGESTION_ALREADY_TRACKED",
      "That time is already tracked or dismissed.",
    );
  }

  const start = input.edited ? input.start : Math.max(input.start, best.start);
  const end = input.edited ? input.end : Math.min(input.end, best.end);

  // A rule names catalog ids, and the project or task it names may have been
  // deleted since. Filing under it would be refused on every accept — or, from
  // the offline queue, dropped on replay with the time it carried — so an id
  // the catalog no longer has is left off rather than sent.
  const projects = getCachedProjects();
  const tasks = getCachedTasks();
  const projectId =
    input.projectId !== null && projects !== null && !projects.some((it) => it.id === input.projectId)
      ? null
      : input.projectId;
  const taskId =
    input.taskId !== null && tasks !== null && !tasks.some((it) => it.id === input.taskId)
      ? null
      : input.taskId;

  forgetTracked();
  await createEntry({
    description: input.description,
    projectId,
    taskId,
    billable: input.billable,
    tagIds: input.tagIds,
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
  });
  // Again after: a poll that ran while the create was in flight may have
  // cached the intervals from before it.
  forgetTracked();
}
