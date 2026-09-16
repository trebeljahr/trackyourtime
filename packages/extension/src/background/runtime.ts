/**
 * Everything stateful in the extension lives here, and all of it is
 * disposable.
 *
 * MV3 evicts an idle service worker after about 30 seconds and re-creates it
 * from scratch on the next event, so nothing in this worker may be *kept* — it
 * may only be *cached*. {@link ensureReady} is the recovery path: it rebuilds
 * the session, the API client, the offline queue and the sync socket from
 * `chrome.storage` alone, and every entry point in the worker awaits it before
 * touching anything. The module-level variables below are therefore caches
 * whose cold-start value is "empty", never the source of truth.
 */
import {
  ApiError,
  createApiClient,
  createId,
  createOfflineQueue,
  createSyncClient,
  decodeOfflineMutation,
  decodeVersioned,
  encodeVersioned,
  readStoredList,
  readStoredTimeEntry,
  describeQueuedMutation,
  emptyWorkspaceChoice,
  isHeldByWorkspace,
  isPermanentRejection,
  isQueuedOn,
  isReplayableIn,
  OFFLINE_QUEUE_STORAGE_KEY,
  resolveActiveWorkspaceId,
  syncEventReach,
  withWorkspaceList,
  workspaceChoiceFor,
  workspaceNameIn,
  isOwnActivity,
  withWorkspaceId,
  type OfflineMutation,
  type QueuedMutation,
  type QueuedMutationSummary,
  type WorkspaceSummary,
  type ApiClient,
  type Client,
  type DescriptionSuggestion,
  type DetailedEntry,
  type DetailedFavorite,
  type DeviceSession,
  type KeyValueStorage,
  type OfflineOp,
  type OfflinePayloadMap,
  type OfflineQueue,
  type Project,
  type RecentEntry,
  type ServerInfo,
  type StoredOfflinePayload,
  type SyncClient,
  type SyncEvent,
  type SyncStatus,
  type Tag,
  type Task,
  type TimeEntry,
  type ResolvedSettings,
  type VersionedSpec,
} from "@starter/core";
import { chromeStorage, localStorageArea } from "../lib/chrome-storage";
import type { PopupView, SessionSource } from "../lib/messaging";
import {
  DEFAULT_API_URL,
  EXTENSION_CLIENT_ID,
  loadApiUrl,
  syncUrlFrom,
} from "../lib/config";
import {
  clearSession,
  loadSession,
  saveSession,
  type StoredSession,
} from "../lib/session";
import { clearWebSessionCookie, readWebSessionToken } from "../lib/web-session";
import {
  clearWorkspaceChoice,
  loadWorkspaceChoice,
  saveWorkspaceChoice,
  type WorkspaceChoice,
} from "../lib/workspace-choice";
import { deleteAllActivity } from "./activity/capture";
import { renderBadge } from "./badge";
import { noteLocalePreference } from "./locale";
import {
  noteRemoteActivity,
  noteReplayedStart,
  resetIdleWatcher,
} from "./idle-state";

/** The rebuildable half of the worker: config plus whatever it configures. */
export type Runtime = {
  apiUrl: string;
  session: StoredSession | null;
  /**
   * Whether `session` was adopted from the web app's cookie or created by this
   * extension's own password sign-in. It decides what sign-out has to tear
   * down, and it is never persisted — it is re-derived on every rebuild.
   */
  sessionSource: SessionSource | null;
  api: ApiClient;
};

/**
 * Tags mutations this worker made so the sync socket's echo of our own write
 * can be dropped instead of re-applied.
 *
 * Deliberately regenerated per worker instance rather than persisted: a fresh
 * id after an eviction can only make us *apply* our own echo, which is
 * idempotent, whereas a persisted one risks silently ignoring a genuine event
 * from a different instance that happened to reuse it.
 */
export const ORIGIN_ID: string = createId();

let runtime: Runtime | null = null;
let building: Promise<Runtime> | null = null;

/**
 * Bumped by every {@link reload}. A build that started before the bump was
 * reading a session or an API URL that has since been replaced, so its result
 * is thrown away rather than installed over the newer one.
 */
let generation = 0;

let sync: SyncClient | null = null;
let syncStatus: SyncStatus = "closed";

/** Floor between {@link ensureSyncConnected} nudges. */
const SYNC_NUDGE_INTERVAL_MS = 15_000;
let lastSyncNudgeAt = 0;

/**
 * Whether the last request to reach a verdict got an answer from the server.
 *
 * Distinct from {@link syncStatus} on purpose: the socket being down does not
 * mean the machine is offline, and conflating the two is what made a working
 * toolbar report "Offline" while every read and write was going through over
 * plain HTTP.
 */
let serverReachable = true;

/**
 * `null` means "we have never looked"; `{ entry: null }` means "we looked and
 * nothing is running". The distinction is what keeps the badge alarm from
 * fetching every 30 seconds — see {@link resolveRunning}.
 */
let cachedRunning: { entry: TimeEntry | null } | null = null;
/** When {@link cachedRunning} was last filled, for the staleness rule below. */
let cachedRunningAt = 0;
let runningLookup: Promise<TimeEntry | null> | null = null;

/**
 * How long the cached running entry may be trusted while the sync socket is
 * down. Short enough that the 30-second badge alarm always re-reads, which is
 * what keeps a socket-less worker in step with the web app and Raycast.
 */
const RUNNING_CACHE_TTL_MS = 10_000;

/**
 * How long a fetched entry window may be reused.
 *
 * The popup re-reads the snapshot every three seconds; without this the
 * entries screen would issue twenty `entries.list` calls a minute for a list
 * nobody is changing.
 */
const ENTRIES_CACHE_TTL_MS = 15_000;

const rememberRunning = (entry: TimeEntry | null): void => {
  cachedRunning = { entry };
  cachedRunningAt = Date.now();
};

const forgetRunning = (): void => {
  cachedRunning = null;
  cachedRunningAt = 0;
  runningLookup = null;
};

let cachedProjects: Project[] | null = null;
let cachedClients: Client[] | null = null;
let cachedTags: Tag[] | null = null;
let cachedTodaySec: number | null = null;
let cachedFavorites: DetailedFavorite[] | null = null;
let cachedRecents: RecentEntry[] | null = null;

/** Workspace settings, for the idle policy. Dropped on `settings.changed`. */
let cachedSettings: ResolvedSettings | null = null;
let settingsLookup: Promise<ResolvedSettings | null> | null = null;

/** Tasks are workspace-wide, so one list covers every project. */
let cachedTasks: Task[] | null = null;

/** Which popup surface is open. Reset on sign-out: a new session starts at the timer. */
let activeView: PopupView = "tracker";

/**
 * The fetched window, before the offline overlay is applied over it.
 *
 * `pages` is how deep "Load older" has taken it. A refetch that ignored it
 * would replace an extended window with page one, so a list somebody had just
 * paged would collapse back to a single page on the next poll — the depth is
 * remembered here so the refetch can restore it.
 */
let cachedEntries: {
  entries: DetailedEntry[];
  cursor: string | null;
  hasMore: boolean;
  fetchedAt: number;
  pages: number;
} | null = null;

/** Set by a foreign entry event; forces the next read to refetch. */
let entriesStale = false;

let cachedDevices: DeviceSession[] | null = null;

/**
 * The description suggestions for one query, and the query they answer.
 *
 * One entry rather than a map keyed by query: the popup asks about whatever is
 * in the field right now, so every earlier prefix is a question nobody will
 * ask again. Keeping them would grow without bound for a list that is thrown
 * away when the popup closes.
 */
export type CachedDescriptions = {
  query: string;
  rows: DescriptionSuggestion[];
  fetchedAt: number;
};

let cachedDescriptions: CachedDescriptions | null = null;

/** Discovered once per API URL from /api/health; null until then. */
let cachedWebUrl: string | null = null;

/**
 * What that same /api/health said about the server's release, for the version
 * line in Settings → Account. Filled by the read that fills
 * {@link cachedWebUrl}, so it costs no request of its own.
 */
let cachedServerInfo: ServerInfo | null = null;

/**
 * The signed-in address. A password sign-in returns it, but a session adopted
 * from the web app's cookie carries only the token — so for that path it has
 * to be asked for, once, rather than left blank in the popup's footer.
 */
let cachedEmail: string | null = null;

let queue: OfflineQueue | null = null;

/**
 * Who this worker is signed in as, once anything has said.
 *
 * A password sign-in knows at once; a session borrowed from the web app's
 * cookie carries only a token, so this is filled from `settings.get`. Kept
 * apart from `cachedSettings`, which a workspace switch or a reconnect drops:
 * the person does not change when the workspace does, and a socket event
 * arriving in that gap still has to be told apart from a colleague's.
 */
let knownUserId: string | null = null;

export const getKnownUserId = (): string | null =>
  runtime?.session?.userId ?? knownUserId;

// ── the active workspace ─────────────────────────────────────────────

/**
 * The extension's own workspace choice and the last membership list — see
 * `lib/workspace-choice.ts` for why it never follows the web app's session.
 * Loaded from storage on every rebuild, like everything else in this worker.
 */
let workspaceChoice: WorkspaceChoice = emptyWorkspaceChoice();

/**
 * Whether `workspaces.list` has answered since this worker was built, and
 * since the last `membership.changed`. A stale list is still used — it is the
 * best answer offline — but the next read that can afford a request asks again.
 */
let workspacesFresh = false;
let workspacesLookup: Promise<WorkspaceSummary[] | null> | null = null;

/** The workspace every request is addressed to, or null before any is known. */
export const getActiveWorkspaceId = (): string | null =>
  resolveActiveWorkspaceId(
    workspaceChoice.workspaceId,
    workspaceChoice.workspaces,
  );

export const getKnownWorkspaces = (): WorkspaceSummary[] | null =>
  workspaceChoice.workspaces;

/** A workspace's name, including one this person has since left. */
export const workspaceNameFor = (workspaceId: string): string | null =>
  workspaceNameIn(workspaceChoice, workspaceId);

/**
 * Every cache that describes ONE workspace. The running entry is not among
 * them: the timer is the person's, and a start in one workspace stops the
 * timer in any other, so the badge is right across a switch.
 */
const forgetWorkspaceCaches = (): void => {
  cachedProjects = null;
  cachedClients = null;
  cachedTags = null;
  cachedTasks = null;
  cachedTodaySec = null;
  cachedFavorites = null;
  cachedRecents = null;
  cachedSettings = null;
  settingsLookup = null;
  cachedEntries = null;
  entriesStale = false;
  cachedDescriptions = null;
};

/**
 * Install a fresh membership list.
 *
 * The resolved id is written back as the choice, so a cold offline start
 * addresses the workspace the last answer settled on rather than re-deriving
 * it from a list that may be gone. When the resolution moved — the stored
 * workspace is no longer a membership — every workspace cache is dropped, or
 * the popup would show the lost workspace's projects under the new one.
 *
 * Unstamped queue rows (from a build before the stamp) are claimed by the
 * workspace resolved here, once, eagerly: that is where they would have
 * replayed anyway, and a later switch must not carry them along.
 */
const installWorkspaceList = async (
  list: WorkspaceSummary[],
  apiUrl: string,
  /**
   * False from inside a flush: the queue serialises every operation, so an
   * adoption awaited while a flush holds it would wait for itself forever.
   * The next list read adopts instead.
   */
  adopt = true,
): Promise<void> => {
  const installed = withWorkspaceList(workspaceChoice, list, {
    server: apiUrl,
    userId: getKnownUserId(),
  });
  workspaceChoice = installed.choice;
  const after = installed.activeId;
  await saveWorkspaceChoice(workspaceChoice);
  if (installed.moved) forgetWorkspaceCaches();
  if (adopt && after !== null) {
    await getOfflineQueue().adoptUnstampedWorkspace(after, (row) =>
      isQueuedOn(row, apiUrl, DEFAULT_API_URL),
    );
  }
};

/**
 * The membership list, fetched when this worker has not asked since it was
 * built or since a membership event.
 *
 * Null when the server could not be asked. Never throws: every caller has a
 * safer thing to do without a list than with an exception — the snapshot keeps
 * the last list, and the flush sends nothing it cannot check.
 */
export async function resolveWorkspaces(): Promise<WorkspaceSummary[] | null> {
  const current = await ensureReady();
  if (!current.session) return null;
  if (workspacesFresh && workspaceChoice.workspaces !== null) {
    return workspaceChoice.workspaces;
  }
  if (workspacesLookup) return workspacesLookup;

  const mine = generation;
  const lookup = current.api
    .query<WorkspaceSummary[]>("workspaces.list")
    .then(async (list) => {
      // A reload landed mid-request: the list belongs to a session that has
      // been replaced, and installing it would validate the next account's
      // choice against the previous account's memberships.
      if (mine !== generation) return null;
      await installWorkspaceList(list, current.apiUrl);
      workspacesFresh = true;
      return list;
    })
    .catch(() => null);

  workspacesLookup = lookup;
  try {
    return await lookup;
  } finally {
    if (workspacesLookup === lookup) workspacesLookup = null;
  }
}

/**
 * Point the extension at another workspace.
 *
 * Checked against a fresh list, so a workspace the person has just been
 * removed from cannot be chosen from a popup that was a poll behind. Never
 * calls `workspaces.setActive`: that moves the SESSION's active workspace,
 * which the web app may be sharing, and a switch here must leave the web app
 * exactly where it was.
 */
export async function switchWorkspace(workspaceId: string): Promise<boolean> {
  const current = await ensureReady();
  if (!current.session) return false;
  workspacesFresh = false;
  const list = (await resolveWorkspaces()) ?? workspaceChoice.workspaces;
  if (list === null || !list.some((it) => it.id === workspaceId)) return false;
  if (getActiveWorkspaceId() === workspaceId) return true;
  workspaceChoice = { ...workspaceChoice, workspaceId };
  await saveWorkspaceChoice(workspaceChoice);
  forgetWorkspaceCaches();
  return true;
}

// ── the offline queue ────────────────────────────────────────────────

/**
 * Backed by `chrome.storage.local` under core's own default key, so a
 * mutation queued here is a row the web client could also replay — the op
 * contract in `@starter/core/offline-ops` is shared on purpose.
 */
export const getOfflineQueue = (): OfflineQueue => {
  queue ??= createOfflineQueue({
    storage: chromeStorage(localStorageArea()),
    key: OFFLINE_QUEUE_STORAGE_KEY,
  });
  return queue;
};

export async function enqueueOffline<K extends OfflineOp>(
  op: K,
  input: OfflinePayloadMap[K],
  tempId?: string,
  /**
   * The workspace the write was addressed to (`addressedWrite`). Defaults to
   * the active one now, which differs when a switch landed while the live
   * attempt hung — and then the row must go where the attempt went.
   */
  workspaceId?: string | null,
): Promise<void> {
  const payload: StoredOfflinePayload = tempId ? { input, tempId } : { input };
  // Stamped with the server it was made against. Switching servers clears the
  // queue today, so this is defence in depth rather than the mechanism: a row
  // that somehow outlived a switch is held back by `flushQueue` instead of
  // being replayed into an account on a server that never saw its start.
  //
  // And with the workspace it was made in, so a switch before the network
  // returns cannot file it somewhere else — `flushQueue` replays it there.
  const { apiUrl } = await ensureReady();
  await getOfflineQueue().enqueue(
    op,
    payload,
    undefined,
    apiUrl,
    (workspaceId === undefined ? getActiveWorkspaceId() : workspaceId) ??
      undefined,
  );
}

/**
 * Pin one write to the workspace active as it begins.
 *
 * The api client reads the choice per request and a switch is just another
 * popup message, handled while an earlier write's request is still in flight.
 * Reading the choice twice — once for the request, again when a transport
 * failure queues it — would send the attempt to A and stamp the row with B,
 * so the replay files the work in a workspace it was never made in. One read:
 * the request carries it explicitly and the queued row is stamped with it.
 */
export const addressedWrite = (): {
  workspaceId: string | null;
  address: <T>(input: T) => unknown;
} => {
  const workspaceId = getActiveWorkspaceId();
  return { workspaceId, address: (input) => withWorkspaceId(input, workspaceId) };
};

// ── the optimistic running entry ─────────────────────────────────────

/**
 * What a queued start or stop implies about the timer, kept on disk beside the
 * queue itself.
 *
 * {@link cachedRunning} cannot carry this. The worker is evicted after about
 * 30 seconds while the queued mutation outlives it on disk, so a memory-only
 * optimistic entry leaves the revived worker believing nothing is running when
 * an `entries.start` is still waiting to be sent: the badge blanks, the popup
 * offers Start again, and pressing it queues a second start that replays as a
 * duplicate the moment the network returns.
 */
const OPTIMISTIC_RUNNING_KEY = "trackyourtime.optimistic-running";

let optimisticStore: KeyValueStorage | null = null;

const getOptimisticStore = (): KeyValueStorage => {
  optimisticStore ??= chromeStorage(localStorageArea());
  return optimisticStore;
};

type OptimisticRunning = { entry: TimeEntry | null };

const readOptimisticRunning = (value: unknown): OptimisticRunning | null => {
  if (typeof value !== "object" || value === null) return null;
  const { entry } = value as { entry?: unknown };
  if (entry === null) return { entry: null };
  const read = readStoredTimeEntry(entry);
  // Only a running entry is an optimistic running one; anything else is a row
  // this build cannot paint the timer from.
  return read !== null && read.end === null ? { entry: read } : null;
};

/**
 * Version 1 is `{ entry }` inside the envelope; builds before it wrote the bare
 * `{ entry }`. A value from a newer build, or one whose entry a field this
 * build reads is wrong on, is a miss: the queue still holds the start or stop,
 * so the next snapshot after the replay puts the timer right.
 */
const OPTIMISTIC_RUNNING_SPEC: VersionedSpec<OptimisticRunning> = {
  version: 1,
  decode: readOptimisticRunning,
  legacy: readOptimisticRunning,
};

export const decodeOptimisticRunning = (
  raw: string | null,
): OptimisticRunning | null => decodeVersioned(raw, OPTIMISTIC_RUNNING_SPEC);

/**
 * `{ entry: null }` is a real state — "a stop is queued" — and is why this is
 * stored as an envelope rather than as a bare nullable entry.
 */
export async function rememberOptimisticRunning(
  entry: TimeEntry | null,
): Promise<void> {
  await getOptimisticStore().setItem(
    OPTIMISTIC_RUNNING_KEY,
    encodeVersioned(OPTIMISTIC_RUNNING_SPEC.version, { entry }),
  );
}

const forgetOptimisticRunning = async (): Promise<void> => {
  await getOptimisticStore().removeItem(OPTIMISTIC_RUNNING_KEY);
};

const loadOptimisticRunning = async (): Promise<OptimisticRunning | null> =>
  decodeOptimisticRunning(
    await getOptimisticStore().getItem(OPTIMISTIC_RUNNING_KEY),
  );

/**
 * Restore the optimistic view on a cold start, but only while the queue that
 * justifies it is still non-empty — a leftover key must never resurrect a
 * timer whose mutation has already been replayed.
 */
const rehydrateOptimisticRunning = async (): Promise<void> => {
  if ((await pendingSyncCount()) === 0) {
    await forgetOptimisticRunning();
    return;
  }
  const stored = await loadOptimisticRunning();
  if (stored !== null) rememberRunning(stored.entry);
};

// ── the optimistic past entries ──────────────────────────────────────

/**
 * What queued edits, creates and deletes imply about past entries.
 *
 * {@link rememberOptimisticRunning} models exactly one entry — the running one
 * — because until now that was the only entry the extension could change. A
 * queued edit of a past row outlives this worker on disk, so the row it implies
 * has to as well, or a revived worker repaints the pre-edit values while the
 * mutation is still waiting to be sent.
 *
 * Cleared wholesale, never row by row: the overlay exists only to represent
 * queued work, so "the queue is empty" is a sound and total clear condition and
 * removes any need to reconcile a replayed row against a temp id.
 */
const OPTIMISTIC_ENTRIES_KEY = "trackyourtime.optimistic-entries";

export type OptimisticEntries = { upserts: TimeEntry[]; deletes: string[] };

const EMPTY_OPTIMISTIC: OptimisticEntries = { upserts: [], deletes: [] };

/**
 * Whether a stored row is still shaped like an entry this build can render.
 *
 * The same defence the `deletes` list gets, and for the same reason: these rows
 * were written by whatever build was installed at the time, and one that is
 * missing a field goes straight through `applyOverlay` into the rendered list,
 * where `entry.description.trim()` throws and blanks the whole screen — or
 * into the money helpers, where a string rate is `NaN`. Only the fields the
 * overlay, the row and the money read are checked (`readStoredTimeEntry`), and
 * fields this build does not know pass through: a stricter guard would throw
 * away rows that render perfectly well. One bad row drops alone.
 */
const readOptimisticEntries = (value: unknown): OptimisticEntries | null => {
  if (typeof value !== "object" || value === null) return null;
  const { upserts, deletes } = value as { upserts?: unknown; deletes?: unknown };
  return {
    upserts: readStoredList(upserts, readStoredTimeEntry),
    deletes: Array.isArray(deletes)
      ? deletes.filter((id): id is string => typeof id === "string")
      : [],
  };
};

/** Version 1 is `{ upserts, deletes }`, which builds before it wrote bare. */
const OPTIMISTIC_ENTRIES_SPEC: VersionedSpec<OptimisticEntries> = {
  version: 1,
  decode: readOptimisticEntries,
  legacy: readOptimisticEntries,
};

export async function loadOptimisticEntries(): Promise<OptimisticEntries> {
  const raw = await getOptimisticStore().getItem(OPTIMISTIC_ENTRIES_KEY);
  // A row from an older or newer build is not worth wedging a cold start over.
  return decodeVersioned(raw, OPTIMISTIC_ENTRIES_SPEC) ?? EMPTY_OPTIMISTIC;
}

const writeOptimisticEntries = async (
  value: OptimisticEntries,
): Promise<void> => {
  if (value.upserts.length === 0 && value.deletes.length === 0) {
    await getOptimisticStore().removeItem(OPTIMISTIC_ENTRIES_KEY);
    return;
  }
  await getOptimisticStore().setItem(
    OPTIMISTIC_ENTRIES_KEY,
    encodeVersioned(OPTIMISTIC_ENTRIES_SPEC.version, value),
  );
};

export async function upsertOptimisticEntry(entry: TimeEntry): Promise<void> {
  const current = await loadOptimisticEntries();
  await writeOptimisticEntries({
    upserts: [
      ...current.upserts.filter((it) => it.id !== entry.id),
      entry,
    ],
    // An entry being written again is no longer deleted — the two lists must
    // not both claim the same id, or the render order decides the outcome.
    deletes: current.deletes.filter((id) => id !== entry.id),
  });
}

export async function deleteOptimisticEntry(id: string): Promise<void> {
  const current = await loadOptimisticEntries();
  await writeOptimisticEntries({
    upserts: current.upserts.filter((it) => it.id !== id),
    deletes: current.deletes.includes(id)
      ? current.deletes
      : [...current.deletes, id],
  });
}

export async function clearOptimisticEntries(): Promise<void> {
  await getOptimisticStore().removeItem(OPTIMISTIC_ENTRIES_KEY);
}

/**
 * Drop everything queued for an entry that only ever existed locally.
 *
 * Deleting an offline-created row has to remove its own `entries.create` too,
 * or the replay resurrects the entry the user just deleted. Ported from the web
 * client's `cancelQueuedForTemp`, matching on the queue row's `tempId` — the
 * only link between a temp id and the mutation that invented it.
 */
export async function cancelQueuedForTemp(tempId: string): Promise<boolean> {
  const offline = getOfflineQueue();
  const rows = await offline.list();
  let removed = false;

  for (const row of rows) {
    const decoded = decodeOfflineMutation(row);
    if (decoded?.tempId !== tempId) continue;
    await offline.remove(row.id);
    removed = true;
  }

  return removed;
}

// ── rebuilding ───────────────────────────────────────────────────────

const buildRuntime = async (): Promise<Runtime> => {
  const mine = generation;
  const [apiUrl, stored, choice] = await Promise.all([
    loadApiUrl(),
    loadSession(),
    loadWorkspaceChoice(),
  ]);

  // The web app's cookie wins when the extension has nothing of its own: that
  // is what makes signing in on the web sign the toolbar in too, with no form
  // and no second credential. A password session, once created, is kept —
  // re-adopting the cookie under it would silently switch which session the
  // user is on.
  let session = stored;
  let sessionSource: SessionSource | null = stored ? "password" : null;

  if (!session) {
    const webToken = await readWebSessionToken(apiUrl);
    if (webToken !== null) {
      session = { token: webToken, userId: null, email: null };
      sessionSource = "web";
    }
  }

  const next: Runtime = {
    apiUrl,
    session,
    sessionSource,
    api: createApiClient({
      baseUrl: apiUrl,
      token: session?.token,
      clientId: EXTENSION_CLIENT_ID,
      // Read per request: a switch changes it under a live client. An input
      // that already names a workspace — a replayed queue row — keeps it.
      workspaceId: getActiveWorkspaceId,
    }),
  };

  // A reload landed while this build was reading storage, so `next` was built
  // from a session or an API URL that has already been replaced. Installing it
  // would point the api client and the socket at the old one — and because
  // `reload` cleared `building` before starting its own, the newer build is
  // what `ensureReady` now hands back.
  if (mine !== generation) return ensureReady();

  runtime = next;
  // Only this server's and this account's choice applies; another one's id
  // would answer NOT_FOUND to every request until a list replaced it.
  workspaceChoice = workspaceChoiceFor(choice, {
    server: apiUrl,
    userId: session?.userId ?? null,
  });
  workspacesFresh = false;
  // A queued mutation outlives the worker that made it, so the optimistic view
  // of the timer has to come back with it — otherwise a revived worker
  // contradicts a start that is still waiting to be sent.
  if (session !== null) await rehydrateOptimisticRunning();
  connectSync(next);
  return next;
};

/**
 * Rehydrate the worker if it has just been revived, otherwise hand back what
 * is already there. Safe — and cheap — to await from every event handler,
 * which is exactly how it is meant to be used: a handler that skips it will
 * work in testing and fail in the field, because in testing the worker
 * happened to still be warm.
 */
export function ensureReady(): Promise<Runtime> {
  if (runtime) return Promise.resolve(runtime);
  if (building) return building;

  // Two events can wake the worker at once; both must await one build.
  const pending = buildRuntime();
  building = pending;
  return pending.finally(() => {
    if (building === pending) building = null;
  });
}

/**
 * Throw the runtime away and build a fresh one. Used whenever the inputs
 * change under it — a new token, a new API URL — since both are baked into the
 * api client and the socket at construction time.
 */
export async function reload(): Promise<Runtime> {
  // Ordered, and both halves matter: the bump makes any in-flight build
  // discard its result, and dropping `building` stops `ensureReady` below from
  // handing that same stale build back as if it were the new one.
  generation += 1;
  building = null;

  closeSync();
  // A reload is a deliberate retarget, so the next connect must not be held
  // back by a nudge made against the runtime being thrown away.
  lastSyncNudgeAt = 0;
  runtime = null;
  forgetRunning();
  knownUserId = null;
  workspacesFresh = false;
  workspacesLookup = null;
  cachedProjects = null;
  cachedClients = null;
  cachedTags = null;
  cachedTasks = null;
  cachedTodaySec = null;
  cachedFavorites = null;
  cachedRecents = null;
  cachedSettings = null;
  settingsLookup = null;
  cachedWebUrl = null;
  cachedServerInfo = null;
  cachedEmail = null;
  cachedEntries = null;
  entriesStale = false;
  cachedDevices = null;
  cachedDescriptions = null;
  // A retarget or a new token is a new account as far as the popup is
  // concerned, and the timer is the only screen that makes sense to land on
  // before anything has been read.
  activeView = "tracker";
  return ensureReady();
}

// ── sync socket ──────────────────────────────────────────────────────

const setSyncStatus = (next: SyncStatus): void => {
  if (syncStatus === next) return;
  syncStatus = next;
  if (next !== "open") return;

  // Every event that arrived while the socket was down was delivered to
  // nobody, so the caches this socket is responsible for keeping honest are
  // now suspect. Without this, a timer stopped on another device during a
  // few-second wifi blip keeps counting up here until the worker happens to be
  // evicted — and pressing Stop then fails against a server with nothing
  // running. One `entries.current` per reconnect buys a self-healing gap.
  forgetRunning();
  forgetWorkspaceCaches();
  cachedDevices = null;
  // A membership change missed while the socket was down is a missed event
  // like any other.
  workspacesFresh = false;

  // A socket that just came up is the first reliable sign the network is back.
  // Nothing awaits this, so it must swallow its own failure — the next
  // reconnect or the next mutation will try the queue again.
  void flushQueue().catch(() => undefined);
};

const closeSync = (): void => {
  sync?.close();
  sync = null;
  setSyncStatus("closed");
};

/**
 * Whose entry an event carries, as far as this worker can tell.
 *
 * In a shared workspace the socket also carries colleagues' entry events. The
 * badge is this person's timer, so a colleague's start must not become it and
 * a colleague's stop must not clear it. When this worker does not yet know who
 * it is signed in as, it believes neither: the cache is dropped and the next
 * read asks `entries.current`, which only ever answers with the caller's own.
 */
const authorship = (entry: TimeEntry): "own" | "other" | "unknown" => {
  const userId = getKnownUserId();
  if (userId === null) return "unknown";
  return entry.authorId === userId ? "own" : "other";
};

/** The running-entry half of an entry-bearing event — per person, any workspace. */
const applyRunning = (event: SyncEvent): void => {
  switch (event.kind) {
    case "timer.started": {
      const who = authorship(event.entry);
      if (who === "own") rememberRunning(event.entry);
      else if (who === "unknown") forgetRunning();
      return;
    }
    case "timer.stopped": {
      // The id match is safe whoever sent it: the cached entry is ours.
      if (cachedRunning?.entry?.id === event.entry.id) {
        rememberRunning(null);
        return;
      }
      const who = authorship(event.entry);
      if (who === "own") rememberRunning(null);
      else if (who === "unknown") forgetRunning();
      return;
    }
    case "entry.upserted": {
      if (event.entry.end !== null) {
        // An edit that closed the entry we thought was running stops the timer.
        if (cachedRunning?.entry?.id === event.entry.id) rememberRunning(null);
        return;
      }
      const who = authorship(event.entry);
      if (who === "own") rememberRunning(event.entry);
      else if (who === "unknown") forgetRunning();
      return;
    }
    case "entry.deleted":
      if (cachedRunning?.entry?.id === event.id) rememberRunning(null);
      return;
    default:
      return;
  }
};

/**
 * Apply another device's event to the cache.
 *
 * The events carry the entry itself, so nothing here needs a round trip — the
 * badge can be repainted from the message alone, which matters because these
 * arrive while the worker would otherwise be asleep.
 *
 * The socket carries every workspace the person belongs to. An event from a
 * workspace other than the one this extension is pointed at may move the
 * running timer (it is per person) or the membership list, and nothing else —
 * its rows must not mark this workspace's caches, and its catalog must not
 * replace this workspace's.
 */
export const applyEvent = (event: SyncEvent, eventWorkspaceId?: string): void => {
  const reach = syncEventReach(event, eventWorkspaceId, getActiveWorkspaceId());
  if (reach === "ignore") return;
  if (reach === "membership") {
    workspacesFresh = false;
    return;
  }
  applyRunning(event);
  if (reach === "timer") return;

  switch (event.kind) {
    case "timer.started":
      // What "recent" means changes with every entry another device closes.
      cachedRecents = null;
      // A start closes whatever was running, which adds a finished row to the
      // window the entries screen is showing.
      entriesStale = true;
      cachedTodaySec = null;
      return;
    case "timer.stopped":
      cachedRecents = null;
      entriesStale = true;
      cachedTodaySec = null;
      // A finished entry is the only thing `entries.descriptions` reads, so
      // this is the moment a name typed on another device becomes suggestible.
      cachedDescriptions = null;
      return;
    case "entry.upserted":
      // Any upsert can land inside the browsed window, whether or not it
      // happens to be the entry this device thinks is running.
      entriesStale = true;
      if (event.entry.end !== null) cachedDescriptions = null;
      return;
    case "entry.deleted":
      entriesStale = true;
      cachedDescriptions = null;
      return;
    case "membership.changed":
      // A role or visibility change in THIS workspace changes what the
      // server will show; a removal changes where requests may go at all.
      workspacesFresh = false;
      forgetWorkspaceCaches();
      return;
    case "catalog.changed":
      if (event.scope === "project") cachedProjects = null;
      if (event.scope === "client") cachedClients = null;
      if (event.scope === "tag") cachedTags = null;
      if (event.scope === "task") cachedTasks = null;
      // A renamed or deleted project changes what a pin is labelled with.
      cachedFavorites = null;
      cachedRecents = null;
      return;
    case "favorites.changed":
      cachedFavorites = null;
      return;
    case "settings.changed":
      cachedSettings = null;
      settingsLookup = null;
      // `devices.revoke` and `devices.revokeOthers` publish exactly this event
      // and nothing else, so a device list signed out from the web app would
      // otherwise keep listing sessions that no longer exist.
      cachedDevices = null;
      return;
  }
};

const connectSync = (current: Runtime): void => {
  closeSync();
  if (!current.session) return;

  const url = syncUrlFrom(current.apiUrl);
  if (url === "") return;

  sync = createSyncClient({
    url,
    token: current.session.token,
    onStatus: setSyncStatus,
    onEvent: (event, originId, eventWorkspaceId) => {
      // Our own write, already applied locally — re-applying a stale copy of
      // it would flicker the badge back to what it was a moment ago.
      if (originId === ORIGIN_ID) return;
      // Somebody just did something on another device, so the person was at a
      // keyboard at this instant. Idle spans are measured from here, which is
      // what stops a browser left open from pausing work done elsewhere. Only
      // THIS person's doing counts — a colleague's timer is not evidence that
      // the laptop in front of this browser is in use.
      if (isOwnActivity(event, eventWorkspaceId, getKnownUserId())) {
        void noteRemoteActivity(Date.now()).catch(() => undefined);
      }
      applyEvent(event, eventWorkspaceId);
      void renderBadge(cachedRunning?.entry ?? null);
    },
  });
  sync.connect();
};

export const getSyncStatus = (): SyncStatus => syncStatus;

/**
 * Make sure a socket exists and is at least trying.
 *
 * The sync client reconnects itself on a backoff `setTimeout`, and a timer is
 * precisely what this worker cannot rely on: MV3 evicts it mid-backoff and the
 * pending reconnect dies with it, while a worker kept awake by the badge alarm
 * never rebuilds — so `connectSync` is never reached again either. Between the
 * two, a socket could stay down indefinitely with the popup reporting
 * "Offline" against a server that was answering every HTTP request.
 *
 * Called from the 30-second badge alarm, which is the one scheduler Chrome
 * revives a dead worker for. `connect()` is a no-op on a socket that is
 * already open or opening, so nudging it costs nothing when all is well.
 */
export async function ensureSyncConnected(): Promise<void> {
  const current = await ensureReady();
  if (!current.session) return;
  if (sync === null) {
    lastSyncNudgeAt = Date.now();
    connectSync(current);
    return;
  }
  // Already up, or already mid-handshake: leave it alone.
  if (syncStatus !== "closed") return;
  // The popup asks for a snapshot every three seconds while it is open, and a
  // nudge bypasses the client's own backoff — so without a floor here, a
  // server that refuses the upgrade would be re-dialled twenty times a minute
  // for as long as somebody had the popup open.
  if (Date.now() - lastSyncNudgeAt < SYNC_NUDGE_INTERVAL_MS) return;
  lastSyncNudgeAt = Date.now();
  sync.connect();
}

/**
 * Record whether the server answered. Called from every read that reaches a
 * verdict, so the popup can tell "the live socket is down" apart from "this
 * machine has no network" — two states that used to render identically.
 */
export const noteServerReachable = (reachable: boolean): void => {
  serverReachable = reachable;
};

export const isServerReachable = (): boolean => serverReachable;

/**
 * True when a row belongs to a workspace this person is no longer in, by the
 * last list this worker saw. Such a row is HELD: never replayed — not into
 * its own workspace, which would refuse it, and not into any other — and
 * never dropped on its own. The popup lists it by name until the person
 * discards it.
 */
const isHeldRow = (row: QueuedMutation): boolean =>
  isHeldByWorkspace(row, workspaceChoice.workspaces);

/**
 * How many mutations are waiting to be replayed — held rows excluded.
 *
 * Excluded because every caller reads this as "is something still ahead of a
 * new mutation": the live-or-queue decision, the optimistic running entry, the
 * overlay. A held row is never sent, so counting it would queue every future
 * start behind a row that can never drain, and pin the optimistic timer on
 * screen forever.
 */
export const pendingSyncCount = async (): Promise<number> => {
  const rows = await getOfflineQueue().list();
  return rows.filter((row) => !isHeldRow(row)).length;
};

/** Every queued row, held or not — what a server switch would discard. */
export const queuedRowCount = (): Promise<number> => getOfflineQueue().size();

/** Rows held for a workspace this person has left, described by name. */
export type HeldQueuedRow = QueuedMutationSummary;

export async function listHeldRows(): Promise<HeldQueuedRow[]> {
  const rows = await getOfflineQueue().list();
  return rows
    .filter(isHeldRow)
    .map((row) => describeQueuedMutation(row, workspaceNameFor));
}

/**
 * Discard one held row, deliberately.
 *
 * Refuses anything that is not held right now, so a popup a poll behind
 * cannot delete a row that has become sendable again (the person was added
 * back) and is about to replay.
 */
export async function discardHeldRow(id: string): Promise<boolean> {
  const rows = await getOfflineQueue().list();
  const row = rows.find((it) => it.id === id);
  if (row === undefined || !isHeldRow(row)) return false;
  await getOfflineQueue().remove(id);
  return true;
}

// ── caches ───────────────────────────────────────────────────────────

export const peekRunning = (): TimeEntry | null => cachedRunning?.entry ?? null;

export const setCachedRunning = (entry: TimeEntry | null): void => {
  rememberRunning(entry);
  runningLookup = null;
};

export const getCachedProjects = (): Project[] | null => cachedProjects;

export const setCachedProjects = (projects: Project[]): void => {
  cachedProjects = projects;
};

export const getCachedSettings = (): ResolvedSettings | null => cachedSettings;

/**
 * Install settings the server just returned.
 *
 * Only a successful `settings.update` calls this, and that is what makes a
 * refusal cost nothing: the cache still holds the server's truth, so the next
 * snapshot re-renders the value that was actually rejected with no popup-side
 * rollback anywhere. Nulling instead would be worse than useless here — the
 * `settings.changed` echo of our own write is dropped by origin id, so nothing
 * else would refill the cache and the very next snapshot would pay for a
 * `settings.get`.
 */
export const setCachedSettings = (settings: ResolvedSettings): void => {
  cachedSettings = settings;
  noteLocalePreference(settings.locale);
};

export const getActiveView = (): PopupView => activeView;

/**
 * Record which surface the popup is on, so `buildState` fetches only what is
 * being looked at.
 *
 * Arriving at the entries list is exactly the moment its window should be true
 * rather than up to {@link ENTRIES_CACHE_TTL_MS} old, so the move marks it
 * stale — a refetch on arrival, not on every poll while it sits there.
 */
export const setActiveView = (view: PopupView): void => {
  if (activeView === view) return;
  activeView = view;
  if (view === "entries") entriesStale = true;
};

export const getCachedEntries = (): {
  entries: DetailedEntry[];
  cursor: string | null;
  hasMore: boolean;
  fetchedAt: number;
  pages: number;
} | null => cachedEntries;

export const setCachedEntries = (
  entries: DetailedEntry[],
  cursor: string | null,
  hasMore: boolean,
  pages: number = 1,
): void => {
  cachedEntries = { entries, cursor, hasMore, fetchedAt: Date.now(), pages };
};

/**
 * Append a page onto the window. `fetchedAt` is deliberately left where page
 * one put it: paging deeper is not evidence that the rows above are any
 * fresher, and moving it would keep an endlessly-paged list from ever
 * refetching. What the append does record is the new depth, so the refetch it
 * is still due restores this many pages rather than dropping back to one.
 */
export const appendCachedEntries = (
  entries: DetailedEntry[],
  cursor: string | null,
  hasMore: boolean,
): void => {
  if (cachedEntries === null) {
    setCachedEntries(entries, cursor, hasMore);
    return;
  }
  cachedEntries = {
    entries: [...cachedEntries.entries, ...entries],
    cursor,
    hasMore,
    fetchedAt: cachedEntries.fetchedAt,
    pages: cachedEntries.pages + 1,
  };
};

export const entriesAreStale = (): boolean => entriesStale;

export const markEntriesStale = (): void => {
  entriesStale = true;
};

export const clearEntriesStale = (): void => {
  entriesStale = false;
};

/**
 * Whether the window may be served without a round trip. Unlike the running
 * entry there is no queue exception: the offline overlay is applied *over* a
 * fetched page rather than instead of it, so a refetch cannot undo queued work.
 */
export const entriesCacheIsFresh = (): boolean => {
  if (cachedEntries === null) return false;
  if (entriesStale) return false;
  return Date.now() - cachedEntries.fetchedAt < ENTRIES_CACHE_TTL_MS;
};

export const getCachedDescriptions = (): CachedDescriptions | null =>
  cachedDescriptions;

export const setCachedDescriptions = (next: CachedDescriptions): void => {
  cachedDescriptions = next;
};

export const getCachedDevices = (): DeviceSession[] | null => cachedDevices;

export const setCachedDevices = (devices: DeviceSession[]): void => {
  cachedDevices = devices;
};

/**
 * Workspace settings, fetched once per worker and kept until a
 * `settings.changed` event says otherwise.
 *
 * Returns null rather than throwing: idle detection is the only caller, and a
 * settings read that fails must leave the timer alone rather than take a
 * decision on a guess.
 */
export async function resolveSettings(): Promise<ResolvedSettings | null> {
  const current = await ensureReady();
  if (!current.session) return null;
  if (cachedSettings) return cachedSettings;
  if (settingsLookup) return settingsLookup;

  const lookup = current.api
    .query<ResolvedSettings>("settings.get")
    .then((settings) => {
      cachedSettings = settings;
      knownUserId = settings.userId;
      noteLocalePreference(settings.locale);
      return settings;
    })
    .catch(() => null);

  settingsLookup = lookup;
  try {
    return await lookup;
  } finally {
    if (settingsLookup === lookup) settingsLookup = null;
  }
}

export const getCachedTodaySec = (): number | null => cachedTodaySec;

export const setCachedTodaySec = (seconds: number): void => {
  cachedTodaySec = seconds;
};

export const getCachedTags = (): Tag[] | null => cachedTags;

export const setCachedTags = (tags: Tag[]): void => {
  cachedTags = tags;
};

export const getCachedClients = (): Client[] | null => cachedClients;

export const setCachedClients = (clients: Client[]): void => {
  cachedClients = clients;
};

export const getCachedTasks = (): Task[] | null => cachedTasks;

export const setCachedTasks = (tasks: Task[]): void => {
  cachedTasks = tasks;
};

export const getCachedFavorites = (): DetailedFavorite[] | null =>
  cachedFavorites;

export const setCachedFavorites = (favorites: DetailedFavorite[]): void => {
  cachedFavorites = favorites;
};

export const getCachedRecents = (): RecentEntry[] | null => cachedRecents;

export const setCachedRecents = (recents: RecentEntry[]): void => {
  cachedRecents = recents;
};

/**
 * Called after this worker writes an entry. Recents are derived from the entry
 * log, so a start or a stop makes the cached list a claim about the past that
 * is no longer true.
 */
export const invalidateRecents = (): void => {
  cachedRecents = null;
};

/**
 * Where the web app lives, asked of the API rather than configured twice.
 *
 * `/api/health` is public, so this works before sign-in — which matters,
 * because "Open Track Your Time" is exactly what someone with no session wants. A
 * failure is cached as `null` and simply hides the menu item.
 */
/**
 * The signed-in address, from better-auth's own session endpoint.
 *
 * Only ever needed for a cookie-adopted session; a password sign-in already
 * knows it. Returns null rather than throwing — a footer with no address is a
 * cosmetic loss, not a reason to fail the snapshot.
 */
export async function resolveEmail(): Promise<string | null> {
  const current = await ensureReady();
  if (!current.session) return null;
  if (current.session.email !== null) return current.session.email;
  if (cachedEmail !== null) return cachedEmail;

  try {
    const response = await fetch(
      `${current.apiUrl.replace(/\/$/, "")}/api/auth/get-session`,
      { headers: { authorization: `Bearer ${current.session.token}` } },
    );
    if (!response.ok) return null;
    const body: unknown = await response.json();
    const user =
      typeof body === "object" && body !== null
        ? (body as { user?: { email?: unknown } }).user
        : undefined;
    const email = user?.email;
    if (typeof email !== "string" || email === "") return null;
    cachedEmail = email;
    return email;
  } catch {
    return null;
  }
}

/** The server's self-description from the last /api/health read, or null. */
export const getCachedServerInfo = (): ServerInfo | null => cachedServerInfo;

export async function resolveWebUrl(): Promise<string | null> {
  if (cachedWebUrl !== null) return cachedWebUrl;
  const current = await ensureReady();
  try {
    const response = await fetch(
      `${current.apiUrl.replace(/\/$/, "")}/api/health`,
    );
    if (!response.ok) return null;
    const body: unknown = await response.json();
    const webUrl =
      typeof body === "object" && body !== null
        ? (body as { webUrl?: unknown }).webUrl
        : undefined;
    if (typeof webUrl !== "string" || webUrl.trim() === "") return null;
    cachedWebUrl = webUrl.trim();
    const record = body as Record<string, unknown>;
    const text = (value: unknown): string | null =>
      typeof value === "string" && value.trim() !== "" ? value.trim() : null;
    // The same fields core's `checkServer` reads — `version` is the commit —
    // taken from a response this worker was fetching anyway.
    cachedServerInfo = {
      origin: current.apiUrl,
      release: text(record.release),
      commit: text(record.version),
      webUrl: cachedWebUrl,
      originTrusted:
        typeof record.originTrusted === "boolean" ? record.originTrusted : null,
    };
    return cachedWebUrl;
  } catch {
    return null;
  }
}

/**
 * Whether the cached running entry may still be believed.
 *
 * An open socket is what normally keeps it honest — every start and stop from
 * another device arrives as an event — so while the socket is up the cache
 * never expires and the 30-second badge alarm costs nothing on the wire.
 *
 * With the socket down the cache is only a guess, and a guess that never
 * expires is exactly the "signed in, but showing the wrong timer" state: the
 * toolbar kept counting an entry Raycast had stopped, or offered Start for one
 * the web app had already opened, until the worker happened to be evicted.
 *
 * A non-empty queue is the one exception. Its optimistic entry is the truth
 * the server has not been told about yet, so re-reading would replace it with
 * a stale answer and un-do a start the user can see running.
 */
const runningCacheIsUsable = async (): Promise<boolean> => {
  if (cachedRunning === null) return false;
  if (syncStatus === "open") return true;
  if (Date.now() - cachedRunningAt < RUNNING_CACHE_TTL_MS) return true;
  return (await pendingSyncCount()) > 0;
};

/**
 * The running entry, fetched when the cache is empty or — with the sync socket
 * down — no longer fresh enough to trust.
 *
 * The in-flight promise is shared because a wake-up commonly triggers the
 * badge refresh and a popup `state:get` at the same instant.
 */
export async function resolveRunning(): Promise<TimeEntry | null> {
  const current = await ensureReady();
  if (!current.session) return null;
  if (await runningCacheIsUsable()) return cachedRunning?.entry ?? null;
  if (runningLookup) return runningLookup;

  const lookup = current.api
    .query<TimeEntry | null>("entries.current")
    .then((entry) => {
      noteServerReachable(true);
      rememberRunning(entry);
      return entry;
    })
    .catch((error: unknown) => {
      if (isTransportFailure(error)) noteServerReachable(false);
      throw error;
    });

  runningLookup = lookup;
  try {
    return await lookup;
  } finally {
    if (runningLookup === lookup) runningLookup = null;
  }
}

// ── session lifecycle ────────────────────────────────────────────────

export async function adoptSession(session: StoredSession): Promise<void> {
  await saveSession(session);
  await reload();
}

/**
 * React to the web app's session cookie appearing or disappearing.
 *
 * Appearing signs the toolbar in, but only if it has no password session of
 * its own to displace. Disappearing signs it out — but only when the session
 * it is holding IS the web one, or signing out of the web app would also kick
 * an unrelated password session that is still perfectly valid.
 */
export async function onWebSessionChanged(token: string | null): Promise<void> {
  const current = await ensureReady();

  if (token === null) {
    if (current.sessionSource !== "web") return;
    await clearSession();
    await reload();
    await renderBadge(null);
    return;
  }

  if (current.sessionSource === "password") return;
  if (current.session?.token === token) return;

  await clearSession();
  await reload();
  await refreshBadgeFromCache();
}

/** Repaint the badge from whatever the rebuilt runtime now knows. */
const refreshBadgeFromCache = async (): Promise<void> => {
  try {
    await renderBadge(await resolveRunning());
  } catch {
    await renderBadge(peekRunning());
  }
};

/**
 * Drop the local token and everything derived from it.
 *
 * Called both on an explicit sign-out and when the server rejects the token.
 * In both cases the token is worthless, and keeping it would only produce more
 * 401s on every subsequent poll.
 */
export async function forgetSession(
  options: { clearWebCookie?: boolean } = {},
): Promise<void> {
  // The queue is only meaningful under the token that authorized it. Replaying
  // one account's queued start under the next account's token would write that
  // work into the wrong account, and `flushQueue` runs on sign-in, on bootstrap
  // and on every socket reconnect — so the rows must not outlive the token.
  await getOfflineQueue().clear();
  await forgetOptimisticRunning();
  // For the same reason as the queue itself: the overlay only ever describes
  // rows in the account being left, and a leftover row would paint over the
  // next account's entry window.
  await clearOptimisticEntries();
  // The watcher's ownership claim names an entry in the account being left.
  await resetIdleWatcher();
  // Captured activity, filing rules and dismissals are one person's, in one
  // workspace — cleared for the same reason the queue is, and the scope with
  // them so nothing more is recorded until somebody signs in again. A storage
  // failure must not keep the token alive, so it is swallowed.
  await deleteAllActivity({ forgetScope: true }).catch(() => undefined);
  // The workspace choice and the names beside it are this account's. The next
  // account resolves its own default rather than inheriting an id it may not
  // even belong to.
  await clearWorkspaceChoice();
  workspaceChoice = emptyWorkspaceChoice();

  // Deliberate on an explicit sign-out: signing out is synced, so the web app's
  // cookie goes too. NOT done when the server merely rejected the token — that
  // is an expired session, and deleting the cookie would sign the web app out
  // of a session it may still be able to refresh.
  if (options.clearWebCookie === true) {
    const current = runtime;
    if (current) await clearWebSessionCookie(current.apiUrl);
  }

  await clearSession();
  await reload();
  await renderBadge(null);
}

// ── error classification ─────────────────────────────────────────────

/** The stored token is no longer good for anything — sign out locally. */
export const isUnauthorized = (error: unknown): boolean =>
  error instanceof ApiError &&
  (error.httpStatus === 401 || error.code === "UNAUTHORIZED");

/**
 * True when the request never reached the server, so the mutation is safe to
 * queue and replay later. `ApiError` is only ever thrown once an HTTP response
 * has come back, which makes "not an `ApiError`" a precise test for a
 * transport failure — no message sniffing, unlike the web client, which has to
 * classify tRPC's own error objects.
 */
export const isTransportFailure = (error: unknown): boolean =>
  !(error instanceof ApiError);

// ── replay ───────────────────────────────────────────────────────────

/**
 * Replay whatever was queued while offline, in the order the user performed
 * it, and report how much is still stuck. Stops at the first failure and
 * leaves the rest queued — the queue's own contract — so a start is never
 * replayed after the stop that followed it.
 *
 * Callers use the return value to decide whether a *new* mutation may go out
 * live: sending one ahead of older queued ones would land it out of order, and
 * `entries.stop` in particular resolves against whatever is running at the
 * moment it arrives.
 */
/**
 * The input a queued row is replayed with: addressed to the workspace it was
 * queued in, over the client's current choice. The api client's getter only
 * fills a gap, and a stamped row never leaves one.
 */
export const replayInput = (decoded: OfflineMutation): unknown =>
  decoded.workspaceId === undefined
    ? decoded.input
    : { ...decoded.input, workspaceId: decoded.workspaceId };

export async function flushQueue(): Promise<number> {
  const current = await ensureReady();
  // Every mutation drains first, so this is also where a worker that has
  // never resolved a workspace does so before its first write. A write with no
  // workspace resolves the SESSION's active one server-side — which the web
  // app moves when it switches, and which must not decide where this start goes.
  if (current.session && getActiveWorkspaceId() === null) {
    await resolveWorkspaces();
  }
  const offline = getOfflineQueue();
  if ((await offline.size()) === 0) return 0;
  if (!current.session) return pendingSyncCount();

  // Which workspaces a stamped row may still go to. Without an answer nothing
  // is sent: a row cannot be checked against nothing, and the server's refusal
  // of a left workspace's row (NOT_FOUND) is a permanent rejection the flush
  // would drop — a day of tracked time gone with no trace.
  const members = await resolveWorkspaces();
  if (members === null) return pendingSyncCount();
  const memberIds = new Set(members.map((it) => it.id));

  const result = await offline.flush(
    async (row) => {
      const decoded = decodeOfflineMutation(row);
      // A row written by an older build cannot be replayed against today's
      // schema; resolving drops it rather than wedging everything behind it.
      if (decoded === null) return;
      let replayed: unknown;
      try {
        // The op string *is* the tRPC path, by design — so there is no dispatch
        // table here to drift out of step with the queue contract.
        replayed = await current.api.mutate(decoded.op, replayInput(decoded));
      } catch (error) {
        // Anything the server can still accept later — a lapsed session, a 500,
        // a dead network — keeps its place and wedges the rest deliberately, so
        // ordering survives. A permanent refusal cannot: the server has already
        // moved on (the runaway guard capping an entry this stop was going to
        // close is exactly that), and stopping here would wedge the queue
        // forever. Drop it and let the reconcile below pull the truth back.
        if (!isPermanentRejection(error)) throw error;
        // Except a NOT_FOUND that may mean "you left this workspace" rather
        // than "that entry is gone": the list above can be a minute old. Ask
        // again, and keep the row unless its workspace is demonstrably still
        // a membership — the next flush then holds it by the filter.
        if (
          decoded.workspaceId !== undefined &&
          error instanceof ApiError &&
          (error.httpStatus === 404 || error.code === "NOT_FOUND")
        ) {
          // Asked directly rather than through `resolveWorkspaces`, whose
          // adoption step needs the queue this flush is holding.
          const fresh = await current.api
            .query<WorkspaceSummary[]>("workspaces.list")
            .catch(() => null);
          if (fresh !== null) await installWorkspaceList(fresh, current.apiUrl, false);
          if (fresh === null || !fresh.some((it) => it.id === decoded.workspaceId)) {
            throw error;
          }
        }
        return;
      }

      // Outside the catch above on purpose: this writes to `chrome.storage`, and
      // a failure there is not a failed replay. Letting it reach that handler
      // would re-queue a mutation the server has already applied and replay it
      // twice.
      await noteReplayedStart(decoded, replayed);
    },
    {
      // Only rows made against the server in use. Rows written before the
      // stamp existed were all made against this build's default, which is
      // what `isQueuedOn`'s third argument says; a row for any other server
      // keeps its place untouched rather than being sent somewhere it was
      // never meant for.
      filter: (row) =>
        isQueuedOn(row, current.apiUrl, DEFAULT_API_URL) &&
        // A row for a workspace this person has left is held in place: not
        // replayed there, not replayed anywhere else, not dropped.
        isReplayableIn(row, memberIds),
    },
  );

  // Rows the filter held back never drain here, so they are not "ahead of" a
  // new mutation and must not keep it queued — see `pendingSyncCount`.
  const blocking = result.remaining - result.skipped;

  // Drained: the server now holds everything the optimistic entry stood in for.
  if (blocking === 0) {
    await forgetOptimisticRunning();
    // Wholesale, and only on a fully drained queue: the past-entry overlay
    // exists purely to stand in for queued work, so an empty queue is the one
    // clear condition that needs no per-row reconciliation against a temp id.
    // Marking the window stale is the other half — server truth is now
    // strictly better than what the overlay was claiming.
    await clearOptimisticEntries();
    markEntriesStale();
  }

  if (result.flushed > 0) {
    // Replay moved the server on in ways we never modelled locally; re-read
    // the running entry rather than trust a cache built from optimistic
    // guesses about what each queued mutation would do.
    forgetRunning();
  }
  return blocking;
}
