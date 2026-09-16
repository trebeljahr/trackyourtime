/**
 * Watching which site has the person's attention, without a network.
 *
 * Every Chrome event that can change "what is in front of them" — a tab
 * activated, the active tab navigating, a window gaining or losing focus, the
 * person going idle or coming back — is reduced to one question: what is the
 * active tab of the focused window right now? The answer either extends the
 * open segment or closes it and opens another. Asking the same question for
 * every event, instead of trusting each event's own payload, is what keeps
 * interleaved async handlers from recording a tab that was already left.
 *
 * What is recorded is the hostname and nothing else, unless page titles were
 * separately opted into. Never recorded: incognito tabs, hosts on the
 * exclusion list, and anything that is not an `http(s)` page (browser and
 * extension pages included). Nothing is recorded at all while capture is off,
 * the `tabs` permission is not granted, or nobody is signed in.
 *
 * An MV3 worker can be evicted at any moment. The open segment is therefore
 * persisted on every change, a one-minute alarm refreshes its `lastSeen`, and a
 * segment whose `lastSeen` is older than {@link STALE_AFTER_MS} is closed AT
 * `lastSeen` — the machine slept, or the browser was closed, and none of that
 * time was spent on the page.
 */
import { hostMatchesAny } from "@starter/core/activity/index";
import { runPrune } from "./prune";
import {
  activityScopeOf,
  capturePermitted,
  clearActivityScope,
  loadActivityScope,
  loadActivitySettings,
  saveActivityScope,
  saveActivitySettings,
  type ActivitySettings,
} from "./settings";
import {
  ActivityStorageUnavailableError,
  appendSegment,
  deleteOtherScopes,
  deleteSegmentsWhere,
  loadOpenSegment,
  probeActivityStorage,
  saveOpenSegment,
  wipeAllActivity,
  type OpenSegment,
} from "./store";

export const HEARTBEAT_ALARM = "trackyourtime.activity.heartbeat";
export const PRUNE_ALARM = "trackyourtime.activity.prune";

/** Chrome's floor for a periodic alarm in a packed extension. */
const HEARTBEAT_MINUTES = 1;
const PRUNE_MINUTES = 24 * 60;

/**
 * Three missed heartbeats. Alarms are allowed to run late, so one or two late
 * ticks must not split a stretch; a sleeping laptop misses far more than three.
 */
export const STALE_AFTER_MS = 3 * 60_000;

/** Chrome's own default idle detection interval, used when none was set. */
const DEFAULT_IDLE_SECONDS = 60;

const TITLE_MAX_LENGTH = 200;

type CaptureContext = { scope: string; settings: ActivitySettings };

type Target = { key: string; label?: string };

// ── serialising handlers ─────────────────────────────────────────────

let queue: Promise<unknown> = Promise.resolve();

/**
 * Run handlers one at a time. Two events arrive together all the time — a tab
 * activation and the window focus that caused it — and two handlers both
 * reading "no open segment" would each open one.
 */
const serial = <T>(task: () => Promise<T>): Promise<T> => {
  const next = queue.then(task, task);
  queue = next.catch(() => undefined);
  return next;
};

/** Wait for every handler already queued. Tests use it to observe a settled state. */
export const activityIdle = (): Promise<void> => serial(async () => undefined);

// ── what is in front of the person ───────────────────────────────────

/** The recordable identity of a tab, or null when it must not be recorded. */
export function describeTab(
  tab: chrome.tabs.Tab | null | undefined,
  settings: ActivitySettings,
): Target | null {
  if (tab === null || tab === undefined) return null;
  if (tab.incognito) return null;
  const url = tab.url ?? tab.pendingUrl;
  if (url === undefined || url === "") return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const key = parsed.hostname.toLowerCase();
  if (key === "") return null;
  if (hostMatchesAny(settings.excludedHosts, key)) return null;

  const title = tab.title?.trim();
  return settings.storeTitles && title !== undefined && title !== ""
    ? { key, label: title.slice(0, TITLE_MAX_LENGTH) }
    : { key };
}

const activeTabOfFocusedWindow = async (): Promise<chrome.tabs.Tab | null> => {
  try {
    const win = await chrome.windows.getLastFocused({ populate: false });
    if (!win.focused || win.id === undefined) return null;
    const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
    return tab ?? null;
  } catch {
    return null;
  }
};

const captureContext = async (): Promise<CaptureContext | null> => {
  const [settings, scope] = await Promise.all([
    loadActivitySettings(),
    loadActivityScope(),
  ]);
  if (!settings.enabled || scope === null) return null;
  if (!(await capturePermitted())) return null;
  // A database a newer build upgraded cannot be opened here. Capture stops,
  // the setting stays as the person left it, and Settings → Activity says why.
  if ((await probeActivityStorage()) !== null) return null;
  return { scope, settings };
};

// ── the open segment ─────────────────────────────────────────────────

/**
 * Store the open segment as a closed one, under the settings as they are NOW.
 *
 * The segment was opened under earlier settings. Excluding the host on screen,
 * or switching titles off, closes it — and writing it out as it was opened
 * would store the very host the person just asked never to be recorded.
 */
const closeSegment = async (open: OpenSegment, end: number): Promise<void> => {
  const settings = await loadActivitySettings();
  if (hostMatchesAny(settings.excludedHosts, open.key)) return;
  await appendSegment({
    scope: open.scope,
    source: "browser",
    start: open.start,
    end: Math.max(open.start, end),
    key: open.key,
    ...(open.label !== undefined && settings.storeTitles ? { label: open.label } : {}),
    afk: false,
  });
};

/**
 * Run a storage step that has nothing to act on when this build cannot open
 * the database (a newer build upgraded it). Capture is off in that state, so
 * "no open segment" and "nothing to delete" are the true answers, and every
 * other failure still surfaces.
 */
const unlessUnavailable = async <T>(step: () => Promise<T>, fallback: T): Promise<T> => {
  try {
    return await step();
  } catch (error) {
    if (error instanceof ActivityStorageUnavailableError) return fallback;
    throw error;
  }
};

/** The open segment, with a stale one already closed at its `lastSeen`. */
const liveOpenSegment = async (now: number): Promise<OpenSegment | null> => {
  const open = await unlessUnavailable(loadOpenSegment, null);
  if (open === null) return null;
  if (now - open.lastSeen <= STALE_AFTER_MS) return open;
  await closeSegment(open, open.lastSeen);
  await saveOpenSegment(null);
  return null;
};

const closeOpen = async (end: number): Promise<void> => {
  const open = await liveOpenSegment(end);
  if (open === null) return;
  await closeSegment(open, end);
  await saveOpenSegment(null);
};

const observe = async (now: number): Promise<void> => {
  const context = await captureContext();
  if (context === null) {
    await closeOpen(now);
    return;
  }

  const target = describeTab(await activeTabOfFocusedWindow(), context.settings);
  const open = await liveOpenSegment(now);

  if (
    open !== null &&
    target !== null &&
    open.scope === context.scope &&
    open.key === target.key &&
    open.label === target.label
  ) {
    await saveOpenSegment({ ...open, lastSeen: now });
    return;
  }

  if (open !== null) await closeSegment(open, now);
  await saveOpenSegment(
    target === null
      ? null
      : {
          scope: context.scope,
          key: target.key,
          ...(target.label !== undefined ? { label: target.label } : {}),
          start: now,
          lastSeen: now,
        },
  );
};

// ── entry points ─────────────────────────────────────────────────────

/** Re-read what is in front of the person. Every tab and focus event lands here. */
export const observeActiveTab = (): Promise<void> => serial(() => observe(Date.now()));

/** The browser lost focus to another application: attention left the page. */
export const browserBlurred = (): Promise<void> => serial(() => closeOpen(Date.now()));

/**
 * The person went idle, locked the screen, or came back.
 *
 * `idle` arrives once the detection interval has already elapsed with no input,
 * so the segment is closed that far back: those minutes were not spent on the
 * page. `locked` is immediate. `active` asks the question again.
 */
export const activityIdleChanged = (
  state: "active" | "idle" | "locked",
  idleSeconds: number | null,
): Promise<void> =>
  serial(async () => {
    const now = Date.now();
    if (state === "active") {
      await observe(now);
      return;
    }
    const backdate = state === "idle" ? (idleSeconds ?? DEFAULT_IDLE_SECONDS) * 1000 : 0;
    const open = await liveOpenSegment(now);
    if (open === null) return;
    await closeSegment(open, Math.max(open.start, now - backdate));
    await saveOpenSegment(null);
  });

/**
 * The one-minute tick.
 *
 * Refreshes `lastSeen` on a live segment, closes a stale one at its `lastSeen`,
 * and closes a live one outright when capture is no longer allowed. It never
 * opens a segment: only an event says attention is somewhere, and a tick that
 * reopened one after a closed lid would count the minute the lid came up
 * before the person had looked at anything.
 */
export const heartbeat = (): Promise<void> =>
  serial(async () => {
    const now = Date.now();
    const open = await liveOpenSegment(now);
    if (open === null) return;
    const context = await captureContext();
    if (context === null || context.scope !== open.scope) {
      await closeSegment(open, now);
      await saveOpenSegment(null);
      return;
    }
    await saveOpenSegment({ ...open, lastSeen: now });
  });

/**
 * Start-up recovery: close whatever a dead worker left open too long ago.
 * Run on every module evaluation, which is what a revival looks like.
 */
export const recoverActivity = (): Promise<void> =>
  serial(async () => {
    await liveOpenSegment(Date.now());
    await syncAlarms();
  });

/** Keep the two alarms in step with whether capture is on. */
const syncAlarms = async (): Promise<void> => {
  const settings = await loadActivitySettings();
  try {
    if (!settings.enabled) {
      await chrome.alarms.clear(HEARTBEAT_ALARM);
      await chrome.alarms.clear(PRUNE_ALARM);
      return;
    }
    // Re-creating an existing alarm would push its next fire out again.
    if (!(await chrome.alarms.get(HEARTBEAT_ALARM))) {
      await chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: HEARTBEAT_MINUTES });
    }
    if (!(await chrome.alarms.get(PRUNE_ALARM))) {
      await chrome.alarms.create(PRUNE_ALARM, {
        delayInMinutes: 1,
        periodInMinutes: PRUNE_MINUTES,
      });
    }
  } catch {
    /* no alarms API in this context */
  }
};

export type ApplySettingsResult =
  | { ok: true; settings: ActivitySettings }
  | { ok: false; reason: "permission-required" };

/**
 * Change the capture settings.
 *
 * Turning capture on is refused unless the `tabs` permission is already
 * granted — the popup requests it from the click, then sends this.
 */
export const applyActivitySettings = (
  patch: Partial<ActivitySettings>,
): Promise<ApplySettingsResult> =>
  serial(async () => {
    if (patch.enabled === true && !(await capturePermitted())) {
      return { ok: false, reason: "permission-required" } as const;
    }
    const settings = await saveActivitySettings(patch);
    await syncAlarms();
    // "Never record" covers what is already stored, not just what comes next.
    if (patch.excludedHosts !== undefined && settings.excludedHosts.length > 0) {
      await unlessUnavailable(
        () => deleteSegmentsWhere((segment) => hostMatchesAny(settings.excludedHosts, segment.key)),
        0,
      );
    }
    // Re-asked under the new settings: turning capture off, excluding the host
    // on screen or switching titles off all close the open segment here.
    await observe(Date.now());
    if (patch.retentionDays !== undefined) {
      await unlessUnavailable(() => runPrune(Date.now()), 0);
    }
    return { ok: true, settings } as const;
  });

/**
 * Whose activity is captured from now on.
 *
 * A different scope than before means another account or workspace. Every row
 * of another ACCOUNT is deleted, so nothing of one person's browsing stays
 * behind for the next. The same person's rows in their other workspaces are
 * kept — switching workspace in the web app and back must not throw away the
 * rules and dismissals they made there. The open segment is dropped either way.
 */
export const setActivityScope = (userId: string, workspaceId: string): Promise<void> =>
  serial(async () => {
    const scope = activityScopeOf(userId, workspaceId);
    const previous = await loadActivityScope();
    if (previous === scope) return;
    const swept = await unlessUnavailable(async () => {
      await deleteOtherScopes(scope, activityScopeOf(userId, ""));
      return true;
    }, false);
    // Unopenable here means a newer build's database. The scope is left as it
    // was, so that build still sees a change and runs this sweep itself —
    // saving it now would let another account's rows outlive the switch.
    if (!swept) return;
    await saveActivityScope(scope);
  });

/**
 * Delete every stored segment, rule, dismissal and the open segment.
 *
 * With `forgetScope`, capture also stops recording until a scope is set again
 * — which is what sign-out wants. Without it (Settings → "Delete all activity
 * now") capture carries on from this moment.
 */
export const deleteAllActivity = (options: { forgetScope?: boolean } = {}): Promise<void> =>
  serial(async () => {
    await wipeAllActivity();
    if (options.forgetScope === true) {
      await clearActivityScope();
      return;
    }
    await observe(Date.now());
  });

/**
 * Register the listeners. Called synchronously from the worker's entry module,
 * like every other listener there: these events are what revive an evicted
 * worker, and a listener added after an `await` misses the delivery that woke it.
 *
 * The idle listener is not here — the worker's own idle handler forwards to
 * {@link activityIdleChanged}, because it is the one that knows the detection
 * interval.
 */
export function registerActivityListeners(): void {
  const swallow = (promise: Promise<unknown>): void => {
    void promise.catch(() => undefined);
  };

  chrome.tabs.onActivated.addListener(() => swallow(observeActiveTab()));

  chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (!tab.active) return;
    if (changeInfo.url === undefined && changeInfo.title === undefined && changeInfo.status !== "complete") {
      return;
    }
    swallow(observeActiveTab());
  });

  chrome.windows.onFocusChanged.addListener((windowId) => {
    swallow(windowId === chrome.windows.WINDOW_ID_NONE ? browserBlurred() : observeActiveTab());
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === HEARTBEAT_ALARM) swallow(heartbeat());
    else if (alarm.name === PRUNE_ALARM) swallow(runPrune(Date.now()));
  });

  // Revoked from chrome://extensions: stop, and stop saying capture is on.
  chrome.permissions.onRemoved.addListener((removed) => {
    if (removed.permissions?.includes("tabs") !== true) return;
    swallow(applyActivitySettings({ enabled: false }));
  });
}
