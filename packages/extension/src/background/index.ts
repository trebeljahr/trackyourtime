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
  MIN_SERVER_API_LEVEL,
  normalizeServerInput,
  sameServerOrigin,
  SERVER_TOO_OLD,
  serverCompatibility,
  serverHost,
  signInWithPassword,
  signOutSession,
  type ServerCheckProblem,
} from "@starter/core";
import {
  EXTENSION_CLIENT_ID,
  saveApiUrl,
  saveServerInfo,
} from "../lib/config";
import { DEVICE_AUTH_ALARM } from "../lib/device-auth-store";
import {
  clearLinkBlock,
  clearSignOutMarker,
  saveLinkBlock,
  saveSignOutMarker,
} from "../lib/sign-out-marker";
import type {
  BackgroundResponse,
  BackgroundState,
  PopupToBackground,
} from "../lib/messaging";
import { APP_VERSION } from "../lib/app-version";
import { savePopupSnapshot } from "../lib/popup-snapshot";
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
import { registerBridgeListener } from "./bridge";
import {
  createClient,
  createTag,
  createProject,
  createTask,
  updateClient,
  updateProject,
  updateTag,
  updateTask,
} from "./catalog";
import { searchDescriptions } from "./descriptions";
import {
  attemptPendingDeviceSignIn,
  cancelDeviceSignIn,
  startDeviceSignIn,
} from "./device-sign-in";
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
  discardHeldRow,
  ensureReady,
  ensureSyncConnected,
  flushQueue,
  forgetRejectedSession,
  forgetSession,
  getServerLevels,
  getKnownUserId,
  isUnauthorized,
  peekRunning,
  queuedRowCount,
  switchWorkspace,
  reload,
  resolveRunning,
  resolveSettings,
  setActiveView,
} from "./runtime";
import { updateSettings } from "./settings";
import { buildState } from "./state";
import { startTimer, stopTimer, updateRunning } from "./timer";

const BADGE_ALARM = "trackyourtime.badge";

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
  await ensureBadgeAlarm();

  if (!current.session) {
    // A device sign-in waiting on an approval that landed while the worker
    // was stopped finishes here at the latest.
    await attemptPendingDeviceSignIn().catch(() => null);
    if (!(await ensureReady()).session) {
      await renderBadge(null);
      return;
    }
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
      await forgetRejectedSession();
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
    { baseUrl: current.apiUrl, clientId: EXTENSION_CLIENT_ID, clientVersion: APP_VERSION },
    { email, password },
  );
  // A password sign-in replaces a device sign-in the popup was waiting on.
  await cancelDeviceSignIn();
  await adoptSession({
    token: issued.token,
    userId: issued.userId,
    // better-auth echoes the address back; fall back to what was typed so the
    // popup always has something to show under "signed in as".
    email: issued.email ?? email,
    source: "password",
  });
  await clearSignOutMarker();
  await clearLinkBlock();
  await refreshBadge();
  await flushQueue();
};

/**
 * Sign the extension out on purpose.
 *
 * Revokes the extension's own session on the server, whichever way it was
 * signed in, then leaves a marker so the web app — of this person, on this
 * server — signs out too the next time a tab of it talks to the extension
 * (`lib/sign-out-marker.ts`). That is the cookie's old "sign out in one place,
 * sign out in both", narrowed to the same person.
 */
const signOut = async (): Promise<void> => {
  const current = await ensureReady();
  const token = current.session?.token ?? null;
  const userId = current.session?.userId ?? getKnownUserId();

  if (token !== null) {
    try {
      await signOutSession(
        { baseUrl: current.apiUrl, clientId: EXTENSION_CLIENT_ID, clientVersion: APP_VERSION },
        token,
      );
    } catch {
      // Best effort. Dropping the local copy is what actually signs this
      // browser out from the user's point of view, and it must happen whether
      // or not the round trip did.
    }
  }

  const at = Date.now();
  if (userId !== null) {
    await saveSignOutMarker({ userId, apiOrigin: current.apiUrl, at });
  }
  // Whoever it was, and even when nobody could say: no web session from
  // before this moment signs the extension straight back in.
  await saveLinkBlock({ apiOrigin: current.apiUrl, at });
  await forgetSession();
};

/** The worker's code for each way `checkServer` can refuse a server. */
const SERVER_CHECK_CODES: Readonly<Record<ServerCheckProblem, string>> = {
  unreachable: "SERVER_UNREACHABLE",
  "not-trackyourtime": "NOT_TRACKYOURTIME",
  unhealthy: "SERVER_UNHEALTHY",
};

/**
 * Point the extension at another Track Your Time server.
 *
 * Everything the popup already checked is checked again, because anything can
 * send this message: the address, and — over the network, which only the
 * worker waits for — that what answers is a working Track Your Time server
 * that trusts this extension's origin. Nothing is changed until all of that
 * passes, so a typo or a server that is down leaves the extension exactly
 * where it was.
 *
 * Moving to a DIFFERENT server ends the session on the old one, because a
 * token is only meaningful to the server that issued it. Every session is the
 * extension's own row now, whichever way it was signed in, so it is revoked on
 * the old server rather than left in that account's Settings → Devices.
 *
 * `forgetSession` then drops the local copy and, with it, the
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

  const check = await checkServer(origin);
  if (!check.ok) {
    throw new BackgroundError(SERVER_CHECK_CODES[check.problem], check.message);
  }
  // Every request the extension makes is a CORS request, so a server that
  // does not trust this origin would look offline forever. `null` is a server
  // too old to say, which is let through.
  if (check.server.originTrusted === false) {
    // `runtime.getURL`, never `runtime.id`: on Firefox the id is the add-on id
    // and the ORIGIN is a random moz-extension:// UUID, which is the value an
    // admin would be told to copy. The popup translates this code and picks
    // the right sentence for the engine (popup/errors.ts); this string is what
    // reaches a log.
    const origin = chrome.runtime.getURL("/").replace(/\/$/, "");
    throw new BackgroundError(
      "ORIGIN_NOT_TRUSTED",
      `${host} does not trust this extension (${origin}). Its admin sets TRUST_STORE_APPS=true or TRUST_EXTENSION_ORIGINS=true, or adds a pinned origin to TRUSTED_ORIGINS.`,
    );
  }

  // What the check learned about the server's level is worth keeping even
  // when the switch is refused below: the answer is true either way.
  getServerLevels().record({
    origin,
    apiLevel: check.server.apiLevel,
    minClientApiLevel: check.server.minClientApiLevel,
    release: check.server.release,
  });

  // A server below this build's floor would refuse or half-understand what
  // the extension sends, so it is refused before anything is changed. The
  // popup translates the code and names the level from `details`.
  if (serverCompatibility(check.server) === SERVER_TOO_OLD) {
    throw new BackgroundError(
      "SERVER_TOO_OLD",
      `${host} runs API level ${check.server.apiLevel}. This extension needs level ${MIN_SERVER_API_LEVEL} or higher. Ask the server admin to update it.`,
      {
        apiLevel: check.server.apiLevel,
        release: check.server.release,
        minApiLevel: MIN_SERVER_API_LEVEL,
      },
    );
  }

  const current = await ensureReady();

  if (!sameServerOrigin(current.apiUrl, origin)) {
    // Every row, held ones included: the switch discards the whole queue.
    const pending = await queuedRowCount();
    if (pending > 0 && !discardUnsent) {
      throw new BackgroundError(
        "UNSENT_CHANGES",
        `${pending} change${pending === 1 ? " has" : "s have"} not reached ${serverHost(current.apiUrl)} yet. Switching servers signs you out and discards ${pending === 1 ? "it" : "them"}.`,
      );
    }

    const token = current.session?.token ?? null;
    if (token !== null) {
      try {
        await signOutSession(
          { baseUrl: current.apiUrl, clientId: EXTENSION_CLIENT_ID, clientVersion: APP_VERSION },
          token,
        );
      } catch {
        // Best effort, as on an ordinary sign-out: the old server being
        // unreachable is a common reason to be switching away from it.
      }
    }

    // No sign-out marker: leaving a server is not signing out of its web app.
    // And any marker for the old server has nothing to say about the new one.
    await forgetSession();
    await clearSignOutMarker();
  }

  await saveApiUrl(origin);
  await saveServerInfo(check.server);
  // The URL is baked into both the api client and the socket at construction,
  // so the only way to retarget them is to build new ones.
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
    case "auth:device-start":
      return startDeviceSignIn();
    case "auth:device-cancel":
      return cancelDeviceSignIn();
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
      await createProject(message.name, message.clientId, message.details);
      return;
    case "task:create":
      await createTask(message.name);
      return;
    case "client:update":
      return updateClient(message.id, message.patch);
    case "project:update":
      return updateProject(message.id, message.patch);
    case "task:update":
      return updateTask(message.id, message.patch);
    case "tag:update":
      return updateTag(message.id, message.patch);
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
    case "workspace:switch":
      if (!(await switchWorkspace(message.workspaceId))) {
        // The same answer for "never a member" and "no longer one": the
        // popup's list was a poll behind, and the fresh snapshot fixes it.
        throw new BackgroundError(
          "WORKSPACE_NOT_FOUND",
          "That workspace is not available to this account any more.",
        );
      }
      return;
    case "queue:discard-held":
      if (!(await discardHeldRow(message.id))) {
        throw new BackgroundError(
          "QUEUE_ROW_NOT_HELD",
          "That change is no longer held here, so it was not discarded.",
        );
      }
      return;
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
/** Keep the snapshot for the next popup open; see `lib/popup-snapshot.ts`. */
const remember = (state: BackgroundState): BackgroundState => {
  void savePopupSnapshot(state);
  return state;
};

const handle = async (message: unknown): Promise<BackgroundResponse> => {
  if (!isPopupMessage(message)) return badMessage;

  try {
    await ensureReady();
    await apply(message);
    // Every success carries the full fresh snapshot, built after the mutation
    // landed, so the popup never has to guess what its own action did.
    return { ok: true, state: remember(await buildState()) };
  } catch (error) {
    if (isUnauthorized(error)) {
      // The token was revoked from Settings → Devices, or it expired. Only
      // `buildState` used to handle this, so a 401 raised by a *mutation* left
      // the dead token in storage and the popup rendering as signed in — every
      // further press failing the same way. Dropping it here returns the
      // signed-out snapshot, which puts the sign-in form back.
      await forgetRejectedSession();
      return { ok: true, state: remember(await buildState()) };
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
 * The web app telling the extension who is signed in there.
 *
 * Module scope like the rest: a page's message is an event that wakes a
 * stopped worker, and the listener has to exist before that delivery.
 */
registerBridgeListener();

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

// Tab, window-focus, heartbeat, prune and permission listeners for activity
// capture. Registered unconditionally and synchronously like the rest; every
// handler checks that capture is on before it records anything.
registerActivityListeners();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === DEVICE_AUTH_ALARM) {
    // A popup-started device sign-in, kept going while the worker sleeps.
    void attemptPendingDeviceSignIn().catch(() => null);
    return;
  }
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
