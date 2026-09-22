/**
 * Building the {@link BackgroundState} snapshot the popup renders.
 *
 * Snapshots are always whole. The popup is destroyed every time it closes, so
 * it has no baseline to merge a partial update onto — a half-applied patch
 * would be indistinguishable from a stale one.
 *
 * Two failure modes are handled differently on purpose. A 401 means the token
 * is dead and the popup must be told to show its sign-in form. Anything else —
 * realistically, the network being off — falls back to whatever the worker
 * last knew, because a popup showing a stale running timer is far more useful
 * than one showing an error.
 */
import {
  describeServerVersion,
  MIN_SERVER_API_LEVEL,
  mergeQuickStarts,
  ownEntries,
  sameServerOrigin,
  type ApiClient,
  type ServerInfo,
  type TimeEntry,
} from "@starter/core";
import { loadServerInfo } from "../lib/config";
import type {
  ActivitySnapshot,
  BackgroundState,
  ServerCompatibility,
} from "../lib/messaging";
import { setActivityScope } from "./activity/capture";
import {
  isLivePendingDeviceAuth,
  loadDeviceSignInError,
  loadPendingDeviceAuth,
} from "../lib/device-auth-store";
import { attemptPendingDeviceSignIn } from "./device-sign-in";
import { fetchClients, fetchProjects, fetchTags, fetchTasks } from "./catalog";
import {
  cachedEntryPage,
  resolveActivitySnapshot,
  resolveEntryPage,
} from "./entries";
import { fetchFavorites, fetchRecents } from "./favorites";
import { pendingIdle } from "./idle-state";
import {
  ensureReady,
  ensureSyncConnected,
  entriesAreStale,
  forgetRejectedSession,
  getActiveView,
  getCachedDescriptions,
  getCachedDevices,
  getCachedSettings,
  isServerReachable,
  getCachedClients,
  getCachedFavorites,
  getCachedProjects,
  getCachedTags,
  getCachedRecents,
  getCachedServerInfo,
  getCachedTasks,
  getCachedTodaySec,
  getServerLevels,
  getActiveWorkspaceId,
  getKnownUserId,
  getKnownWorkspaces,
  getSyncStatus,
  isTransportFailure,
  isUnauthorized,
  noteServerReachable,
  listHeldRows,
  pendingSyncCount,
  peekRunning,
  queuedRowCount,
  resolveEmail,
  resolveOriginTrusted,
  resolveRunning,
  resolveSettings,
  resolveWebUrl,
  resolveWorkspaces,
  setCachedTodaySec,
} from "./runtime";

/** Today's entries could plausibly run to a few dozen; 500 is the cap. */
const TODAY_ENTRY_LIMIT = 500;

/**
 * How many chips the popup's quick-start row shows. Lower than the web app's:
 * the popup is 380px wide, and a row that scrolls sideways is worse than a
 * short one.
 */
const QUICK_START_LIMIT = 5;

/**
 * What every snapshot says about the server itself, signed in or not.
 *
 * Kept apart from the account half because the sign-in screen needs all of
 * it: which server it is about to sign in to, whether that server trusts this
 * extension's origin, and how much queued work a switch would throw away.
 */
type ServerFacts = Pick<
  BackgroundState,
  "apiUrl" | "webUrl" | "originTrusted" | "serverVersion" | "pendingSync" | "compatibility"
>;

/** What the level cache knows about `apiUrl`, for the version banner. */
export const resolveCompatibility = (apiUrl: string): ServerCompatibility => {
  const levels = getServerLevels();
  const known = levels.get(apiUrl);
  return {
    refusal: levels.compatibility(apiUrl),
    release: known?.release ?? null,
    apiLevel: known?.apiLevel ?? null,
    minServerApiLevel: MIN_SERVER_API_LEVEL,
  };
};

/**
 * The version line: the live /api/health answer when there is one, else what
 * the check that chose this server recorded — but only if that record is
 * about THIS server, not one the extension has since moved away from.
 */
const resolveServerVersion = async (apiUrl: string): Promise<string | null> => {
  // A server that reported neither a release nor a commit (a local dev server,
  // or one older than the fields) would read as a bare "Track Your Time" —
  // true, and no use to anybody — so it has no version line at all.
  const describe = (info: ServerInfo): string | null =>
    info.release !== null || info.commit !== null
      ? describeServerVersion(info)
      : null;

  const live = getCachedServerInfo();
  if (live !== null && sameServerOrigin(live.origin, apiUrl)) {
    return describe(live);
  }
  const stored = await loadServerInfo().catch(() => null);
  if (stored !== null && sameServerOrigin(stored.origin, apiUrl)) {
    return describe(stored);
  }
  return null;
};

const resolveServerFacts = async (
  apiUrl: string,
  webUrl: string | null,
): Promise<ServerFacts> => ({
  apiUrl,
  webUrl,
  originTrusted: await resolveOriginTrusted(apiUrl),
  serverVersion: await resolveServerVersion(apiUrl),
  pendingSync: await pendingSyncCount(),
  // After `resolveWebUrl`, whose health read records the level.
  compatibility: resolveCompatibility(apiUrl),
});

/**
 * Signed out, the count answers "what would switching servers throw away",
 * so rows held for a left workspace are in it too — they go with the queue.
 */
const signedOutFacts = async (
  apiUrl: string,
  webUrl: string | null,
): Promise<ServerFacts> => ({
  ...(await resolveServerFacts(apiUrl, webUrl)),
  pendingSync: await queuedRowCount(),
});

/**
 * The popup's own device sign-in, as the sign-in screen shows it: the user
 * code while it waits, and why the last one ended. A device authorization the
 * web app started is not the popup's to show.
 */
type DeviceSignInFacts = Pick<BackgroundState, "pendingDeviceAuth" | "deviceSignInError">;

const resolveDeviceSignIn = async (apiUrl: string): Promise<DeviceSignInFacts> => {
  const pending = await loadPendingDeviceAuth();
  return {
    pendingDeviceAuth:
      pending !== null &&
      pending.purpose === "manual" &&
      isLivePendingDeviceAuth(pending, apiUrl, Date.now())
        ? { userCode: pending.userCode, expiresAt: pending.expiresAt }
        : null,
    deviceSignInError: await loadDeviceSignInError(),
  };
};

const signedOutState = (
  facts: ServerFacts,
  activity: ActivitySnapshot,
  device: DeviceSignInFacts = { pendingDeviceAuth: null, deviceSignInError: null },
): BackgroundState => ({
  ...facts,
  ...device,
  signedIn: false,
  sessionSource: null,
  email: null,
  running: null,
  projects: [],
  clients: [],
  tags: [],
  tasks: [],
  quickStarts: [],
  favorites: [],
  recents: [],
  todaySec: 0,
  syncStatus: getSyncStatus(),
  serverReachable: isServerReachable(),
  pendingIdle: null,
  view: "tracker",
  settings: null,
  entries: null,
  entriesStale: false,
  devices: null,
  descriptions: null,
  descriptionsFor: null,
  activity,
  workspaces: [],
  activeWorkspaceId: null,
  heldSync: [],
});

/**
 * Seconds tracked today in *finished* entries, clamped to the local calendar
 * day.
 *
 * `entries.list` returns everything that *overlaps* the window, so an entry
 * that began before midnight — the overnight session, the timer nobody
 * stopped — would otherwise credit yesterday's hours to today. Clamping both
 * ends to the day boundary is what the reports screen does; the two have to
 * agree or the popup looks broken next to the web app.
 *
 * The running entry is skipped on purpose. The server's list matcher includes
 * it (`{ $or: [{ end: null }, ...] }`), and the popup adds its live elapsed
 * seconds on top of this figure — counting it here too made "Today" tick at
 * double speed for as long as a timer ran.
 *
 * Only `userId`'s own entries count. A member allowed to see colleagues' time
 * gets their entries from the same `entries.list`, and "Today" beside the
 * badge is this person's day, not the team's.
 */
export const fetchTodaySec = async (
  api: ApiClient,
  userId: string | null,
  nowMs: number = Date.now(),
): Promise<number> => {
  const now = new Date(nowMs);
  // Constructed from Y/M/D rather than by adding 24h, so a DST day is still
  // one calendar day.
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

  const page = await api.query<{ entries: TimeEntry[] }>("entries.list", {
    from: dayStart.toISOString(),
    to: dayEnd.toISOString(),
    limit: TODAY_ENTRY_LIMIT,
  });

  const seconds = ownEntries(page.entries, userId).reduce((total, entry) => {
    if (entry.end === null) return total;
    const startMs = Date.parse(entry.start);
    const endMs = Date.parse(entry.end);
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) return total;

    const from = Math.max(startMs, dayStart.getTime());
    const to = Math.min(endMs, dayEnd.getTime());
    return to > from ? total + Math.floor((to - from) / 1000) : total;
  }, 0);

  setCachedTodaySec(seconds);
  return seconds;
};

export async function buildState(): Promise<BackgroundState> {
  let current = await ensureReady();
  // Resolved even when signed out: "Open Track Your Time" is exactly what someone
  // with no session reaches for, so the menu must work before sign-in.
  const webUrl = await resolveWebUrl();
  if (!current.session) {
    // The popup opening is one of the wake-ups a device sign-in finishes on:
    // the approval may have landed while the worker was stopped.
    const pending = await loadPendingDeviceAuth();
    if (pending !== null) {
      await attemptPendingDeviceSignIn().catch(() => null);
      current = await ensureReady();
    }
  }
  if (!current.session) {
    return signedOutState(
      await signedOutFacts(current.apiUrl, webUrl),
      await resolveActivitySnapshot("tracker"),
      await resolveDeviceSignIn(current.apiUrl),
    );
  }
  const session = current.session;

  // Opening the popup is the moment someone is looking at the status, so it is
  // the moment a dead socket should be retried — waiting up to 30 seconds for
  // the badge alarm would leave them watching "Polling" with no way to prod it.
  // A no-op when the socket is already up.
  await ensureSyncConnected().catch(() => undefined);

  // Set by any read that came back 401. Collected rather than thrown so the
  // reads below can settle instead of leaving sibling rejections unhandled.
  let unauthorized = false;

  /** Falls back without judging whether the server is up — see below. */
  const localRead = async <T>(read: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await read();
    } catch (error) {
      if (isUnauthorized(error)) unauthorized = true;
      return fallback;
    }
  };

  // Whether this snapshot's reads reached the server at all. A read that never
  // got a response is what "offline" actually means here — a socket that is
  // down while these all succeed is a different, much less alarming state, and
  // the popup is told them apart so it stops crying wolf.
  //
  // Only reads that genuinely go to the network may set these. `pendingIdle`
  // reads `chrome.storage`, `resolveEmail` swallows its own failure, and
  // `resolveRunning` can answer from cache — count any of them as evidence and
  // the extension would call itself online with the cable pulled out.
  let answered = false;
  let unreachable = false;

  const softRead = async <T>(read: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      const value = await read();
      answered = true;
      return value;
    } catch (error) {
      if (isUnauthorized(error)) unauthorized = true;
      // A refusal is still an answer: the server was reached, it just said no.
      if (isTransportFailure(error)) unreachable = true;
      else answered = true;
      return fallback;
    }
  };

  // Which surface the popup declared it is on. The whole snapshot is still
  // whole; the view only decides which of its expensive halves is worth
  // fetching, and `null` for the rest means "not loaded for this view" rather
  // than "empty".
  const view = getActiveView();

  // Resolved before the parallel reads rather than inside them: a failed
  // refetch has to fall back to the OVERLAID cache, because a failed fetch is
  // the offline case and the queued edits it stands for are the only version of
  // the list the user has seen.
  const entriesFallback = view === "entries" ? await cachedEntryPage() : null;

  // Before any workspace-scoped read, and awaited: every request below is
  // addressed to the resolved workspace, and a stored choice the person is no
  // longer a member of would answer NOT_FOUND to all of them. Swallows its own
  // failure — offline, the last known list still resolves the choice.
  await resolveWorkspaces();

  // One wave, not three. These used to run as running → settings → batch,
  // and against a cold worker (every popup opened more than ~30s after the
  // last) each step was a full round trip the popup waited behind.
  //
  // `resolveRunning` reports its own reachability from inside the runtime,
  // where it can tell a real request apart from a cache hit.
  //
  // Settings are `localRead`, not `softRead`: `resolveSettings` swallows its
  // own failure and answers null, so wrapping it in the reachability probe
  // would report the server as answering on every failure. They also name the
  // user for a session whose record has none, and the day total counts only
  // that user's time — so that one read waits for them, and nothing else does.
  const settingsRead = localRead(resolveSettings, getCachedSettings());
  const [
    running,
    settings,
    email,
    projects,
    clients,
    tags,
    tasks,
    todaySec,
    favorites,
    recents,
    idle,
  ] = await Promise.all([
    localRead(resolveRunning, peekRunning()),
    settingsRead,
    localRead(resolveEmail, session.email),
    softRead(() => fetchProjects(current.api), getCachedProjects() ?? []),
    softRead(() => fetchClients(current.api), getCachedClients() ?? []),
    softRead(() => fetchTags(current.api), getCachedTags() ?? []),
    softRead(() => fetchTasks(current.api), getCachedTasks() ?? []),
    softRead(async () => {
      await settingsRead;
      return fetchTodaySec(current.api, getKnownUserId());
    }, getCachedTodaySec() ?? 0),
    softRead(() => fetchFavorites(current.api), getCachedFavorites() ?? []),
    softRead(() => fetchRecents(current.api), getCachedRecents() ?? []),
    localRead(pendingIdle, null),
  ]);

  // Whose activity capture files under. Settings are the one read that names
  // both the user and the workspace, and a change here wipes the previous
  // scope's rows — see `setActivityScope`.
  if (settings !== null) {
    await setActivityScope(settings.userId, settings.workspaceId).catch(() => undefined);
  }

  // `softRead`, because this one genuinely hits the network once the window's
  // TTL has expired.
  const entries =
    view === "entries"
      ? await softRead(resolveEntryPage, entriesFallback)
      : null;

  // Local reads plus, on the Suggestions screen, one `entries.list` for the
  // tracked time to subtract. `localRead`, not `softRead`: offline that fetch
  // degrades to the cached window inside `trackedIntervalsBetween`, so a
  // success here is no evidence the server answered.
  const activity = await localRead(
    () => resolveActivitySnapshot(view),
    await resolveActivitySnapshot("tracker"),
  );

  // One read answering is enough to call the server reachable; only a snapshot
  // where nothing got through and something failed in transport is "offline".
  // A snapshot served entirely from cache changes nothing either way.
  if (answered || unreachable) noteServerReachable(answered);

  if (unauthorized) {
    // The token was revoked from Settings → Devices, or it simply expired.
    // Clearing it locally is what makes the popup offer sign-in again instead
    // of looping on an error the user cannot act on. No sign-out marker: an
    // expired token is not a request to sign the web app out.
    await forgetRejectedSession();
    return signedOutState(
      await signedOutFacts(current.apiUrl, webUrl),
      await resolveActivitySnapshot("tracker"),
    );
  }

  return {
    ...(await resolveServerFacts(current.apiUrl, webUrl)),
    signedIn: true,
    sessionSource: current.sessionSource,
    pendingDeviceAuth: null,
    deviceSignInError: null,
    email,
    running,
    projects,
    clients,
    tags,
    tasks,
    // Merged here rather than in the popup: the worker owns all state, and
    // the merge rule has to match the web app's or one browser disagrees
    // with itself about what is pinned.
    quickStarts: mergeQuickStarts({
      favorites,
      recents,
      limit: QUICK_START_LIMIT,
    }),
    favorites,
    recents,
    todaySec,
    syncStatus: getSyncStatus(),
    serverReachable: isServerReachable(),
    // Dropped once the entry it refers to is no longer the running one: the
    // question "what were those 40 minutes?" is meaningless against an entry
    // somebody has since stopped, and answering it would edit the wrong row.
    pendingIdle: idle !== null && idle.entryId === running?.id ? idle : null,
    view,
    settings,
    entries,
    entriesStale: entriesAreStale(),
    // Never fetched here — the Devices section asks for it when it is opened.
    devices: getCachedDevices(),
    // Same: `descriptions:search` fills these when a description field is
    // being typed in. Carried on every snapshot afterwards so the poll cannot
    // blank a list the user is looking at.
    descriptions: getCachedDescriptions()?.rows ?? null,
    descriptionsFor: getCachedDescriptions()?.query ?? null,
    activity,
    workspaces: getKnownWorkspaces() ?? [],
    activeWorkspaceId: getActiveWorkspaceId(),
    heldSync: await listHeldRows(),
  };
}
