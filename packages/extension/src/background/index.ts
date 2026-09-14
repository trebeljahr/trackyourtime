/**
 * The MV3 service worker entry point.
 *
 * Every listener below is registered synchronously at module scope, and that
 * is not a style choice. Chrome revives an evicted worker by re-evaluating
 * this module and then delivering the event that woke it; a listener added
 * inside an `await` is added after that delivery, so the popup's very first
 * message — the one on a cold start, which is most of them — would be dropped.
 * Handlers may be async. Registration may not.
 *
 * Nothing here logs the session token, the password or an auth response: the
 * worker's console is readable from `chrome://extensions` by anything the user
 * lets near their browser.
 */
import {
  checkServer,
  normalizeServerInput,
  sameServerOrigin,
  serverHost,
  signInWithPassword,
  signOutSession,
  type ServerCheckProblem,
} from "@starter/core";
import {
  DEFAULT_API_URL,
  EXTENSION_CLIENT_ID,
  saveApiUrl,
  saveServerInfo,
} from "../lib/config";
import type {
  BackgroundResponse,
  PopupToBackground,
} from "../lib/messaging";
import { hasServerAccess } from "../lib/server-access";
import { watchWebSession } from "../lib/web-session";
import {
  activityIdleChanged,
  applyActivitySettings,
  deleteAllActivity,
  recoverActivity,
  registerActivityListeners,
  setActivityScope,
} from "./activity/capture";
import {
  addActivityRuleFor,
  dismissActivity,
  removeActivityRuleFor,
} from "./activity/suggestions";
import { renderBadge } from "./badge";
import {
  createClient,
  createTag,
  createProject,
  createTask,
} from "./catalog";
import { searchDescriptions } from "./descriptions";
import { listDevices, revokeDevice, revokeOtherDevices } from "./devices";
import {
  acceptSuggestion,
  createEntry,
  loadMoreEntries,
  setActivityDay,
  removeEntry,
  updateEntry,
} from "./entries";
import { BackgroundError, toErrorResponse } from "./errors";
import { addFavorite, removeFavorite } from "./favorites";
import {
  answerIdle,
  observeIdle,
  pollIdle,
  syncDetectionInterval,
} from "./idle";
import {
  adoptSession,
  ensureReady,
  ensureSyncConnected,
  flushQueue,
  forgetSession,
  isUnauthorized,
  onWebSessionChanged,
  pendingSyncCount,
  peekRunning,
  reload,
  resolveRunning,
  resolveSettings,
  setActiveView,
} from "./runtime";
import { updateSettings } from "./settings";
import { buildState } from "./state";
import { startTimer, stopTimer, updateRunning } from "./timer";

const BADGE_ALARM = "tracktime.badge";

/**
 * Last API URL the worker resolved, for the cookie listener's domain check.
 *
 * The listener is registered before any await, so it cannot read the stored
 * URL itself; every `ensureReady` refreshes this, and until the first one runs
 * the built-in default is the right guess.
 */
let lastKnownApiUrl: string = DEFAULT_API_URL;

/** The floor Chrome enforces on periodic alarms. */
const BADGE_PERIOD_MINUTES = 0.5;

// ── badge upkeep ─────────────────────────────────────────────────────

/**
 * `setInterval` does not survive worker eviction — the timer dies with the
 * worker and the badge freezes at whatever it last said. An alarm is the only
 * scheduler Chrome will wake a dead worker for, which makes it the only
 * correct mechanism here.
 */
const ensureBadgeAlarm = async (): Promise<void> => {
  const existing = await chrome.alarms.get(BADGE_ALARM);
  // Re-creating it on every wake would push the next fire another 30 seconds
  // out each time, so a busy worker's badge could stall indefinitely.
  if (existing) return;
  await chrome.alarms.create(BADGE_ALARM, {
    periodInMinutes: BADGE_PERIOD_MINUTES,
  });
};

const refreshBadge = async (): Promise<void> => {
  const current = await ensureReady();
  lastKnownApiUrl = current.apiUrl;
  await ensureBadgeAlarm();

  if (!current.session) {
    await renderBadge(null);
    return;
  }

  // The socket is the only thing that pushes another device's work here, and
  // its own reconnect is a `setTimeout` that an evicted worker loses. This
  // alarm is the one scheduler Chrome revives a dead worker for, so it is the
  // only place a permanently-down socket can be picked back up.
  await ensureSyncConnected().catch(() => undefined);

  // Queued mutations used to wait for the socket to come up. When the socket
  // is the broken part — a refused upgrade, a proxy that will not upgrade —
  // HTTP still works, and the queue must not sit there unsent forever.
  await flushQueue().catch(() => undefined);

  // Capture needs to know whose activity it is recording before the popup is
  // ever opened, and settings are the read that names user and workspace.
  const settings = await resolveSettings().catch(() => null);
  if (settings !== null) {
    await setActivityScope(settings.userId, settings.workspaceId).catch(() => undefined);
  }

  // Re-checked on every badge tick: Chrome only reports idle *transitions*, so
  // one missed while the worker was gone would otherwise never be acted on.
  await pollIdle().catch(() => undefined);

  try {
    await renderBadge(await resolveRunning());
  } catch (error) {
    if (isUnauthorized(error)) {
      await forgetSession();
      return;
    }
    // Offline: keep painting what the cache last knew rather than blanking a
    // badge the user is actively watching.
    await renderBadge(peekRunning());
  }
};

// ── message handling ─────────────────────────────────────────────────

const badMessage: BackgroundResponse = {
  ok: false,
  code: "BAD_MESSAGE",
  message: "The extension received a message it does not understand.",
};

/**
 * Anything can call `chrome.runtime.sendMessage`, so the payload is `unknown`
 * until proven otherwise. The shape check is deliberately shallow — the switch
 * below is what actually decides which fields are read.
 */
const isPopupMessage = (value: unknown): value is PopupToBackground =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { type?: unknown }).type === "string";

const signIn = async (email: string, password: string): Promise<void> => {
  const current = await ensureReady();
  const issued = await signInWithPassword(
    { baseUrl: current.apiUrl, clientId: EXTENSION_CLIENT_ID },
    { email, password },
  );
  await adoptSession({
    token: issued.token,
    userId: issued.userId,
    // better-auth echoes the address back; fall back to what was typed so the
    // popup always has something to show under "signed in as".
    email: issued.email ?? email,
  });
  await refreshBadge();
  await flushQueue();
};

const signOut = async (): Promise<void> => {
  const current = await ensureReady();
  const token = current.session?.token ?? null;

  if (token !== null) {
    try {
      await signOutSession(
        { baseUrl: current.apiUrl, clientId: EXTENSION_CLIENT_ID },
        token,
      );
    } catch {
      // Best effort. Dropping the local copy is what actually signs this
      // browser out from the user's point of view, and it must happen whether
      // or not the round trip did.
    }
  }

  // Signing out is synced on purpose: the cookie goes with the session, so the
  // web app does not keep rendering as signed in against something revoked.
  await forgetSession({ clearWebCookie: true });
};

/** The worker's code for each way `checkServer` can refuse a server. */
const SERVER_CHECK_CODES: Readonly<Record<ServerCheckProblem, string>> = {
  unreachable: "SERVER_UNREACHABLE",
  "not-tracktime": "NOT_TRACKTIME",
  unhealthy: "SERVER_UNHEALTHY",
};

/**
 * Point the extension at another Track Your Time server.
 *
 * Everything the popup already checked is checked again, because anything can
 * send this message: the address, the Chrome grant, and — over the network,
 * which only the worker waits for — that what answers is a working Track Your
 * Time server. Nothing is changed until all three pass, so a typo or a server
 * that is down leaves the extension exactly where it was.
 *
 * Moving to a DIFFERENT server ends the session on the old one, because a
 * token is only meaningful to the server that issued it:
 *
 *  - A password session this extension created is signed out on the old
 *    server, so it does not sit in that account's Settings → Devices forever.
 *  - A session borrowed from the web app's cookie is NOT revoked. It is the
 *    web app's session; the person is still using that server in a tab, and
 *    moving the toolbar elsewhere is no request to sign the tab out.
 *
 * Either way `forgetSession` then drops the local copy and, with it, the
 * offline queue — the extension's standing sign-out rule. That is why unsent
 * changes need `discardUnsent`: the popup asks first, and a snapshot one poll
 * behind cannot answer for a queue that has grown since.
 *
 * Choosing the server already in use changes nothing about the session; it
 * re-saves and rebuilds, which re-reads the server's version and web URL.
 */
const setServer = async (
  input: string,
  discardUnsent: boolean,
): Promise<void> => {
  const parsed = normalizeServerInput(input);
  if (!parsed.ok) throw new BackgroundError("INVALID_SERVER", parsed.message);
  const { origin } = parsed;
  const host = serverHost(origin);

  // Before the network check, not after: without the grant, the check below
  // is not a question about the server at all.
  if (!(await hasServerAccess(origin, chrome.permissions))) {
    throw new BackgroundError(
      "SERVER_ACCESS_MISSING",
      `Chrome has not given the extension access to ${host}, so it cannot reach that server.`,
    );
  }

  const check = await checkServer(origin);
  if (!check.ok) {
    throw new BackgroundError(SERVER_CHECK_CODES[check.problem], check.message);
  }

  const current = await ensureReady();

  if (!sameServerOrigin(current.apiUrl, origin)) {
    const pending = await pendingSyncCount();
    if (pending > 0 && !discardUnsent) {
      throw new BackgroundError(
        "UNSENT_CHANGES",
        `${pending} change${pending === 1 ? " has" : "s have"} not reached ${serverHost(current.apiUrl)} yet. Switching servers signs you out and discards ${pending === 1 ? "it" : "them"}.`,
      );
    }

    const token = current.session?.token ?? null;
    if (token !== null && current.sessionSource === "password") {
      try {
        await signOutSession(
          { baseUrl: current.apiUrl, clientId: EXTENSION_CLIENT_ID },
          token,
        );
      } catch {
        // Best effort, as on an ordinary sign-out: the old server being
        // unreachable is a common reason to be switching away from it.
      }
    }

    // No `clearWebCookie`: the cookie belongs to the old server's web app, and
    // leaving that server is not signing out of it.
    await forgetSession();
  }

  await saveApiUrl(origin);
  await saveServerInfo(check.server);
  // The URL is baked into both the api client and the socket at construction,
  // so the only way to retarget them is to build new ones.
  await reload();
  await refreshBadge();
};

/**
 * Chrome's grant for the server in use changed — taken away at
 * `chrome://extensions`, or given back from the popup's notice.
 *
 * Rebuilding is the whole response. It closes a socket to a host the extension
 * may no longer reach, drops caches read while it could, and re-reads the web
 * app's cookie, which `chrome.cookies` only hands over for a host the
 * extension holds. The snapshot reports the access itself, live, so the popup
 * needs nothing else from here.
 */
const onServerAccessChanged = async (): Promise<void> => {
  await reload();
  await refreshBadge();
};

/** A local activity write that needs a signed-in scope and found none. */
const requireActivity = (done: boolean): void => {
  if (done) return;
  throw new BackgroundError(
    "ACTIVITY_UNAVAILABLE",
    "Activity capture has no account to file under yet. Try again in a moment.",
  );
};

const apply = async (message: PopupToBackground): Promise<void> => {
  switch (message.type) {
    case "state:get":
      return;
    case "auth:sign-in":
      return signIn(message.email, message.password);
    case "auth:sign-out":
      return signOut();
    case "timer:start":
      // `startTimer` answers with the entry it opened; `apply` reports state
      // through the fresh snapshot instead, so the value is dropped here.
      await startTimer(
        message.description,
        message.projectId,
        message.taskId,
        message.billable,
        // No explicit start instant — that argument is the idle resume's.
        undefined,
        message.tagIds,
      );
      return;
    case "timer:stop":
      return stopTimer();
    case "timer:update":
      // Listed field by field to drop the discriminant. The omitted ones
      // arrive as explicit `undefined`, which is the same thing to the server
      // and to the queue: both go through `JSON.stringify`, which leaves an
      // `undefined` value out of the object entirely.
      return updateRunning({
        description: message.description,
        projectId: message.projectId,
        taskId: message.taskId,
        billable: message.billable,
        tagIds: message.tagIds,
      });
    case "idle:answer":
      return answerIdle(message.answer);
    case "favorite:add":
      await addFavorite(message.quick);
      return;
    case "favorite:remove":
      return removeFavorite(message.id);
    case "client:create":
      await createClient(message.name);
      return;
    case "tag:create":
      await createTag(message.name);
      return;
    case "project:create":
      await createProject(message.name, message.clientId);
      return;
    case "task:create":
      await createTask(message.name);
      return;
    case "config:set-server":
      return setServer(message.origin, message.discardUnsent === true);
    case "view:set":
      return setActiveView(message.view);
    case "entries:more":
      return loadMoreEntries();
    case "entry:create":
      // Listed field by field to drop the discriminant, the same as
      // `timer:update` — an omitted optional arrives as explicit `undefined`,
      // which `JSON.stringify` leaves out of the object entirely.
      await createEntry({
        description: message.description,
        projectId: message.projectId,
        taskId: message.taskId,
        billable: message.billable,
        tagIds: message.tagIds,
        start: message.start,
        end: message.end,
      });
      return;
    case "entry:update":
      return updateEntry({
        id: message.id,
        description: message.description,
        projectId: message.projectId,
        taskId: message.taskId,
        billable: message.billable,
        tagIds: message.tagIds,
        start: message.start,
        end: message.end,
      });
    case "entry:remove":
      return removeEntry(message.id);
    case "settings:update":
      return updateSettings(message.patch);
    case "descriptions:search":
      // Fills the cache the snapshot below reads. It swallows its own failure
      // on purpose — see `descriptions.ts`.
      await searchDescriptions(message.query);
      return;
    case "devices:list":
      // Answers with the list; `apply` reports it through the fresh snapshot
      // instead, so the value is dropped here.
      await listDevices();
      return;
    case "device:revoke":
      return revokeDevice(message.id);
    case "devices:revoke-others":
      return revokeOtherDevices();
    case "activity:day":
      return setActivityDay(message.day);
    case "activity:accept":
      return acceptSuggestion({
        start: message.start,
        end: message.end,
        edited: message.edited,
        description: message.description,
        projectId: message.projectId,
        taskId: message.taskId,
        billable: message.billable,
        tagIds: message.tagIds,
      });
    case "activity:dismiss":
      return requireActivity(await dismissActivity(message.start, message.end));
    case "activity:rule-add":
      return requireActivity(
        await addActivityRuleFor({
          pattern: message.pattern,
          projectId: message.projectId,
          taskId: message.taskId,
          description: message.description,
          billable: message.billable,
          tagIds: message.tagIds,
        }),
      );
    case "activity:rule-remove":
      return requireActivity(await removeActivityRuleFor(message.id));
    case "activity:settings": {
      const result = await applyActivitySettings(message.patch);
      if (!result.ok) {
        throw new BackgroundError(
          "ACTIVITY_PERMISSION_REQUIRED",
          "Chrome did not grant access to tabs, so activity capture stays off.",
        );
      }
      return;
    }
    case "activity:wipe":
      return deleteAllActivity();
    default: {
      // `apply` returns void, so falling off the end of this switch would be
      // valid TypeScript: a new message type added to the contract would
      // silently no-op and still answer `{ ok: true }`. Assigning to `never`
      // turns that into a compile error instead.
      const unhandled: never = message;
      throw new BackgroundError(
        "BAD_MESSAGE",
        `Unhandled message: ${JSON.stringify(unhandled)}`,
      );
    }
  }
};

/**
 * Resolves, never rejects. The popup's `sendToBackground` treats a missing
 * reply as a dead worker, so every path has to produce a response object.
 */
const handle = async (message: unknown): Promise<BackgroundResponse> => {
  if (!isPopupMessage(message)) return badMessage;

  try {
    lastKnownApiUrl = (await ensureReady()).apiUrl;
    await apply(message);
    // Every success carries the full fresh snapshot, built after the mutation
    // landed, so the popup never has to guess what its own action did.
    return { ok: true, state: await buildState() };
  } catch (error) {
    if (isUnauthorized(error)) {
      // The token was revoked from Settings → Devices, or it expired. Only
      // `buildState` used to handle this, so a 401 raised by a *mutation* left
      // the dead token in storage and the popup rendering as signed in — every
      // further press failing the same way. Dropping it here returns the
      // signed-out snapshot, which puts the sign-in form back.
      await forgetSession();
      return { ok: true, state: await buildState() };
    }
    return toErrorResponse(error);
  }
};

// ── listeners (synchronous registration only) ────────────────────────

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  void handle(message).then((response) => {
    try {
      sendResponse(response);
    } catch {
      // The popup closed before we finished — there is nobody left to tell.
    }
  });
  // Keeps the response port open for the async reply above. Without this
  // Chrome closes the port as soon as the listener returns and every popup
  // call hangs until it times out.
  return true;
});

/**
 * The web app signing in or out, seen through its session cookie.
 *
 * Registered at module scope like the rest: this is the event that makes the
 * toolbar follow the web app, and it commonly arrives at a worker that is
 * asleep, so the listener has to exist before any handler starts awaiting.
 *
 * The API URL is read lazily through `ensureReady` rather than captured here,
 * because at registration time the worker has not loaded it yet.
 */
watchWebSession(
  () => lastKnownApiUrl,
  (token) => {
    void onWebSessionChanged(token).catch(() => undefined);
  },
);

/**
 * The idle signal itself.
 *
 * Registered at module scope like every other listener, and for the same
 * reason: this event is what wakes an evicted worker, so a listener added
 * after an `await` would miss the delivery that revived it. The detection
 * interval is the user's threshold (see ./idle), so `idle` here means the
 * threshold has just elapsed.
 */
chrome.idle.onStateChanged.addListener((state) => {
  void (async () => {
    if (state === "active") {
      // Activity capture goes first and cannot fail the idle handling: it is a
      // local read of the active tab, and it must not wait on a network call.
      await activityIdleChanged("active", null).catch(() => undefined);
      // A return to input is what spends a pending "resume when they come
      // back", so it has to be reported even though nothing is idle.
      await observeIdle("active", 0);
      return;
    }
    const seconds = await syncDetectionInterval();
    await activityIdleChanged(state, seconds).catch(() => undefined);
    await observeIdle(state, seconds ?? 0);
  })().catch(() => undefined);
});

/**
 * Host access being removed or granted.
 *
 * Module scope like the rest: removing a site's access at
 * `chrome://extensions` is an event that commonly reaches a sleeping worker.
 * Filtered to changes that carry origins, so an unrelated API permission
 * changing does not rebuild anything.
 */
const onPermissionsChanged = (permissions: chrome.permissions.Permissions): void => {
  if ((permissions.origins?.length ?? 0) === 0) return;
  void onServerAccessChanged().catch(() => undefined);
};

chrome.permissions.onRemoved.addListener(onPermissionsChanged);
chrome.permissions.onAdded.addListener(onPermissionsChanged);
// Tab, window-focus, heartbeat, prune and permission listeners for activity
// capture. Registered unconditionally and synchronously like the rest; every
// handler checks that capture is on before it records anything.
registerActivityListeners();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== BADGE_ALARM) return;
  // Nothing is waiting on this, so it swallows its own failure: the alarm
  // fires again in 30 seconds regardless.
  void refreshBadge().catch(() => undefined);
});

chrome.runtime.onInstalled.addListener(() => {
  void bootstrap();
});

chrome.runtime.onStartup.addListener(() => {
  void bootstrap();
});

/**
 * The recovery path, run on install, on browser start, and on every plain
 * module evaluation — which is what an eviction-and-revival looks like from in
 * here. All three do the same thing because the worker cannot tell them apart
 * and must not need to.
 */
async function bootstrap(): Promise<void> {
  try {
    await ensureReady();
    await ensureBadgeAlarm();
    await syncDetectionInterval();
    await refreshBadge();
    await flushQueue();
  } catch {
    // A cold start with no network must still leave the worker able to answer
    // the popup; the next alarm retries all of it.
  }
}

void bootstrap();
void recoverActivity().catch(() => undefined);
