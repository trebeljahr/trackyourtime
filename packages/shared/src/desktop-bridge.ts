/**
 * The contract between the Electron shell and the web app it hosts.
 *
 * `electron/src/preload.ts` builds a `DesktopBridge` and exposes it as
 * `window.electronAPI`; `packages/client/src/types/electron.d.ts` declares the
 * same type on `Window`. Both import it from here, so the object the preload
 * hands over and the object the renderer calls cannot drift apart without a
 * type error on one side.
 *
 * Types and string constants only: the preload is bundled into a sandboxed
 * script, and the renderer loads this through `@starter/shared`, so nothing in
 * this file may touch Node, Electron or the DOM.
 */

import type { DesktopShortcutAction, DesktopShortcutBindings } from "./desktop-shortcuts.js";

/** The OS platforms the shell reports, as Node's `process.platform` spells them. */
export type DesktopPlatform = "darwin" | "win32" | "linux";

/** What the main process reports about the machine's idleness. */
export interface DesktopIdlePayload {
  /** "active" | "idle" | "locked" — widened because it crosses IPC. */
  state: string;
  /** Seconds since the OS last saw any input. */
  idleSeconds: number;
}

/**
 * Where the session token is kept, as the main process reports it.
 *
 * `persistent: false` means the token lives in the main process's memory only
 * and the next launch starts signed out: Electron's `safeStorage` had no real
 * encryption to offer (Linux with no keyring, where the backend is
 * `basic_text` — obfuscation with a hardcoded key). Writing a credential there
 * would look secure and not be, so the app refuses and says so instead.
 */
export interface DesktopSecureStoreStatus {
  persistent: boolean;
  /**
   * `safeStorage.getSelectedStorageBackend()` on Linux ("gnome_libsecret",
   * "kwallet5", "basic_text", …); "keychain" on macOS, "dpapi" on Windows,
   * "unavailable" when encryption is not available at all.
   */
  backend: string;
}

/**
 * The session token store, backed by `safeStorage` in the main process. The
 * renderer never sees the file or the key; it hands a token over and asks
 * for it back.
 */
export interface DesktopSecureStore {
  getToken: () => Promise<string | null>;
  setToken: (token: string) => Promise<DesktopSecureStoreStatus>;
  deleteToken: () => Promise<void>;
  status: () => Promise<DesktopSecureStoreStatus>;
}

/**
 * What the tray, the dock badge and the quit notice draw, published by the
 * renderer (`components/desktop/desktop-bridge-publisher.tsx`) whenever it
 * changes. The renderer owns the timer, the queue and the locale; the main
 * process only draws this and ticks the clock from `startedAt`.
 */
export interface DesktopTimerState {
  /** False on the way out of the signed-in app: the tray keeps Open and Quit only. */
  signedIn: boolean;
  running: DesktopRunningTimer | null;
  /** Up to five recent combinations to continue, newest first. */
  recents: DesktopRecent[];
  /** Mutations this account queued that no server has seen yet. */
  unsent: number;
  /**
   * Autopilot, while it is switched on: the tray offers to pause or resume
   * it. Absent or null while it is off, which leaves the item out.
   */
  autopilot?: DesktopTrayAutopilot | null;
  /** Every string the main process shows, already translated. */
  labels: DesktopTrayLabels;
}

export interface DesktopTrayAutopilot {
  /** Epoch ms the pause ends at, or null when Autopilot is not paused. */
  pausedUntil: number | null;
}

export interface DesktopRunningTimer {
  description: string;
  /** ISO start of the running entry; the tray ticks from it. */
  startedAt: string;
  projectName: string | null;
  /** `#rrggbb`, or null for no project. */
  projectColor: string | null;
  /** Autopilot opened this timer and it is still exactly that entry; the tray marks it. */
  autopilot?: boolean;
}

export interface DesktopRecent {
  /** `quickStartKey` — what a `continue` command names. */
  key: string;
  label: string;
  hint: string | null;
}

/**
 * The main process has no catalog of its own, so every word it draws arrives
 * here. Strings with a count are formatted by the renderer (ICU plurals).
 */
export interface DesktopTrayLabels {
  stop: string;
  edit: string;
  runningFor: string;
  noTimer: string;
  startTimer: string;
  recentHeading: string;
  open: string;
  settings: string;
  quit: string;
  noDescription: string;
  /** Tooltip with no timer running. */
  idleTooltip: string;
  /** "3 unsent changes", or "" when there are none. */
  unsent: string;
  /** The notice shown when quitting with unsent changes. */
  quitUnsentTitle: string;
  quitUnsentBody: string;
  quitUnsentButton: string;
  /** Accessible description of the Windows taskbar overlay. */
  runningBadge: string;
  /** The tray item shown once an update is downloaded (Stage 7). */
  restartToUpdate: string;
  /** "Pause Autopilot for an hour", offered while Autopilot is on and running. */
  autopilotPause: string;
  /** "Resume Autopilot", offered while it is paused. */
  autopilotResume: string;
  /** "Autopilot paused until 14:30", or "" when it is not paused. */
  autopilotPaused: string;
}

/** What the tray, a global shortcut or a notification asks the renderer to do. */
export type DesktopCommand =
  | { kind: "stop" }
  /** Stop, else continue the newest recent entry, else `compose`. */
  | { kind: "toggle" }
  | { kind: "continue"; key: string }
  /** Go to the tracker with the description focused. The window is already shown. */
  | { kind: "compose" }
  | { kind: "open-palette" }
  | { kind: "open-settings" }
  /** A notification was clicked: go where that prompt is. */
  | { kind: "open-prompt"; prompt: DesktopNoticeKind };

export type DesktopNoticeKind = "idle" | "runaway" | "autopilot";

/** A system notification for a prompt the hidden window would otherwise swallow. */
export interface DesktopNotice {
  kind: DesktopNoticeKind;
  title: string;
  body: string;
  /** Replaces an earlier notice with the same tag instead of stacking. */
  tag: string;
}

/** Per-device desktop preferences, kept by the main process in `userData`. */
export interface DesktopSettings {
  openAtLogin: boolean;
  /** Tray icon (the menu bar item on macOS). */
  showInTray: boolean;
  /** Windows and Linux: the close button hides to the tray instead of quitting. */
  closeHides: boolean;
  /** macOS Dock badge / Windows taskbar overlay while a timer runs. Off by default. */
  runningBadge: boolean;
  shortcuts: DesktopShortcutBindings;
}

export type DesktopSettingsPatch = Partial<Omit<DesktopSettings, "shortcuts">> & {
  shortcuts?: Partial<DesktopShortcutBindings>;
};

/**
 * Why a binding is not active. `invalid` and `duplicate` are refused before
 * saving; `taken` is saved (it may free up later) but `globalShortcut.register`
 * returned false — another application or the OS holds the chord.
 */
export type DesktopShortcutProblem = "invalid" | "duplicate" | "taken";

export interface DesktopShortcutStatus {
  action: DesktopShortcutAction;
  accelerator: string | null;
  registered: boolean;
  problem: DesktopShortcutProblem | null;
  /** For `duplicate`: the action already holding the chord. */
  conflictsWith?: DesktopShortcutAction;
}

export type DesktopLoginItemStatus = "enabled" | "disabled" | "requires-approval" | "unsupported";

export interface DesktopSettingsSnapshot {
  settings: DesktopSettings;
  shortcuts: DesktopShortcutStatus[];
  /** True while Settings is recording a key and every shortcut is unregistered. */
  shortcutsSuspended: boolean;
  /** What the OS reports, which can differ from the preference (macOS approval). */
  loginItem: DesktopLoginItemStatus;
  capabilities: {
    /** The close button's behaviour is a choice (not on macOS, where close always hides). */
    closeHides: boolean;
    /** A running badge exists on this platform (macOS, Windows). */
    runningBadge: boolean;
  };
}

export interface DesktopSettingsUpdate {
  snapshot: DesktopSettingsSnapshot;
  /** Bindings in the patch that were refused and not saved. */
  refused: DesktopShortcutStatus[];
}

/**
 * Why this copy of the app does not update itself (Stage 7,
 * `electron/src/updater-model.ts`).
 *
 * - `store`: the Mac App Store or the Microsoft Store replaces the app.
 * - `sandbox`: Snap or Flatpak, whose store replaces it.
 * - `package-manager`: a deb, rpm or tar.gz install, which the system's
 *   package manager (or the person) upgrades.
 * - `no-feed`: a build with no update feed — every unsigned macOS or Windows
 *   build, and any local build.
 * - `unpackaged`: a development run.
 * - `turned-off`: `TRACKYOURTIME_DISABLE_UPDATES=1`, for managed machines.
 */
export type DesktopUpdateDisabledReason =
  | "store"
  | "sandbox"
  | "package-manager"
  | "no-feed"
  | "unpackaged"
  | "turned-off";

export type DesktopUpdateStatus =
  | { kind: "disabled"; reason: DesktopUpdateDisabledReason }
  /** Nothing in progress. `lastCheckedAt` is null before the first check answered. */
  | { kind: "idle"; lastCheckedAt: string | null }
  | { kind: "checking"; lastCheckedAt: string | null }
  /** `percent` is null until the first progress event. */
  | { kind: "downloading"; version: string; percent: number | null }
  /** Downloaded: installed when the app quits, or now on "Restart to update". */
  | { kind: "ready"; version: string }
  /** The last check or download failed; the next scheduled check tries again. */
  | { kind: "error"; lastCheckedAt: string | null };

export interface DesktopUpdateSnapshot {
  /** The running app's version (`app.getVersion()`). */
  currentVersion: string;
  status: DesktopUpdateStatus;
}

/**
 * The updater, as Settings → Desktop sees it. Nothing here restarts the app on
 * its own: `restart` is only ever called from a click on "Restart to update".
 */
export interface DesktopUpdates {
  getStatus: () => Promise<DesktopUpdateSnapshot>;
  onStatus: (listener: (snapshot: DesktopUpdateSnapshot) => void) => () => void;
  /** Checks now; resolves with the snapshot once the check has started. */
  check: () => Promise<DesktopUpdateSnapshot>;
  /** Quits and installs a downloaded update. Resolves false when none is ready. */
  restart: () => Promise<boolean>;
}

/** The desktop-app surface beyond auth: tray, shortcuts, settings, attention. */
export interface DesktopShell {
  publishTimerState: (state: DesktopTimerState) => Promise<void>;
  onCommand: (listener: (command: DesktopCommand) => void) => () => void;
  getSettings: () => Promise<DesktopSettingsSnapshot>;
  updateSettings: (patch: DesktopSettingsPatch) => Promise<DesktopSettingsUpdate>;
  onSettingsChanged: (listener: (snapshot: DesktopSettingsSnapshot) => void) => () => void;
  /** While recording a key: unregister every global shortcut so the press reaches the page. */
  suspendShortcuts: (suspended: boolean) => Promise<void>;
  showWindow: () => Promise<void>;
  /** Posts only when the window is hidden or not focused; resolves whether it did. */
  notify: (notice: DesktopNotice) => Promise<boolean>;
  /** Auto-update (Stage 7). Optional so an older preload is still a valid bridge. */
  updates?: DesktopUpdates;
}

/**
 * Why this copy of the app cannot record which application is in front.
 *
 * - `store`: a Mac App Store or Microsoft Store build (sandboxed children,
 *   and review risk for an app that watches other apps).
 * - `linux-sandbox`: Snap or Flatpak, where the host's display tools are out
 *   of reach.
 * - `wayland`: a Wayland session, which gives no application the frontmost
 *   window; XWayland would answer, wrongly.
 * - `unsupported-platform`: an OS or session with no mechanism at all.
 * - `tool-missing`: Linux without `xprop`; `hint` names the package.
 * - `blocked-by-policy`: Windows PowerShell in Constrained Language Mode.
 * - `source-failed`: the helper kept dying and capture gave up for now.
 * - `newer-format`: a newer build wrote the activity folder; this one leaves it alone.
 */
export type DesktopActivityUnavailableReason =
  | "store"
  | "linux-sandbox"
  | "wayland"
  | "unsupported-platform"
  | "tool-missing"
  | "blocked-by-policy"
  | "source-failed"
  | "newer-format";

/** Device preferences: they stay when the account signs out. */
export interface DesktopActivitySettings {
  /** Off until somebody turns it on. */
  enabled: boolean;
  /** Window titles are their own opt-in, and turning them off deletes stored ones. */
  storeTitles: boolean;
  /** Application key globs that are never recorded. */
  excludedApps: string[];
  retentionDays: number;
  /** Autopilot starts, switches and stops timers from what is recorded. Off until turned on. */
  autopilot: boolean;
  /** Minutes on one piece of work, with no timer running, before Autopilot starts it. */
  autopilotStartMinutes: number;
}

export interface DesktopActivityApp {
  key: string;
  name: string;
}

/**
 * "Always file <app> under …". A structural copy of core's `ActivityRule`
 * (shared cannot import core); `electron/src/activity/wire.ts` fails `tsc`
 * when the two drift.
 */
export interface DesktopActivityRule {
  id: string;
  pattern: string;
  description?: string;
  projectId?: string | null;
  taskId?: string | null;
  tagIds?: string[];
  billable?: boolean;
}

/** A half-open `[start, end)` span in epoch ms. */
export interface DesktopActivityInterval {
  start: number;
  end: number;
}

export type DesktopActivitySupport =
  | { supported: true }
  | { supported: false; reason: DesktopActivityUnavailableReason; hint: string | null };

export interface DesktopActivitySnapshot {
  settings: DesktopActivitySettings;
  support: DesktopActivitySupport;
  /** Whether window titles can be recorded on this OS at all: false on macOS for now. */
  titlesAvailable: boolean;
  /** An account and workspace to file activity under is known. */
  scoped: boolean;
  /** Enabled, supported, scoped, and the person is neither idle nor locked. */
  recording: boolean;
  /**
   * Why an enabled, supported, scoped capture is not recording right now:
   * no input for a while (or none yet since an unlock), or the screen is
   * locked. Null whenever capture would record, or could not anyway.
   */
  paused: "idle" | "locked" | null;
  /** Stored segments of the current scope. */
  storedSegments: number;
  /** The current scope's apps, newest first, at most 30. */
  recentApps: DesktopActivityApp[];
  /** The current scope's rules. */
  rules: DesktopActivityRule[];
  /** What Autopilot is doing; `active: false` and empty while it is off. */
  autopilot: DesktopAutopilotState;
}

/** What a suggestion or Autopilot would file work under. */
export interface DesktopActivityProposal {
  description?: string;
  projectId?: string | null;
  taskId?: string | null;
  tagIds?: string[];
  billable?: boolean;
}

export interface DesktopActivitySuggestion {
  start: number;
  end: number;
  topApps: { key: string; name: string; seconds: number; share: number }[];
  /** Up to three titles of the dominant app; empty unless titles are stored. */
  titles: string[];
  ruleId?: string;
  proposed: DesktopActivityProposal;
}

export type DesktopActivityAcceptCheck =
  | { ok: true; start: number; end: number }
  | { ok: false; reason: "already-tracked" | "no-scope" | "bad-range" };

/**
 * What Autopilot files an app's work under. A structural copy of core's
 * `AutopilotFiling`; `electron/src/activity/wire.ts` keeps the two equal.
 */
export interface DesktopAutopilotFiling {
  /** Equal keys are the same work (description, project and task). */
  key: string;
  fields: DesktopActivityProposal;
  /** A rule the person wrote, or learned from what they tracked. */
  via: "rule" | "learned";
  ruleId?: string;
}

/** What Autopilot is looking at right now. */
export interface DesktopAutopilotWatch {
  app: DesktopActivityApp;
  /** When the watched stretch of work began. */
  since: number;
  /** Time on it so far. */
  creditedMs: number;
  /** Null when Autopilot cannot tell what this app is for. */
  filing: DesktopAutopilotFiling | null;
  /** Not started until the next break: undone, stopped by hand, or "not work". */
  held: boolean;
}

export type DesktopAutopilotAction = "start" | "switch" | "stop";

/** One thing Autopilot did, newest first in the state. */
export interface DesktopAutopilotLogEntry {
  id: string;
  kind: DesktopAutopilotAction;
  /** The instant the entry was started, switched or stopped AT (retroactive). */
  at: number;
  /** When Autopilot did it. */
  decidedAt: number;
  app: DesktopActivityApp | null;
  /** What was started or switched to; null for a stop. */
  filing: DesktopAutopilotFiling | null;
  /** Taken back with Undo. */
  undone: boolean;
}

export interface DesktopAutopilotState {
  /** Switched on, and capture is recording for an account. */
  active: boolean;
  /** The running entry Autopilot opened, while it is still exactly that entry. */
  owned: {
    start: number;
    filingKey: string;
    app: DesktopActivityApp | null;
    via: "rule" | "learned";
    /** The log entry that started it, for Undo. */
    logId: string;
  } | null;
  watch: DesktopAutopilotWatch | null;
  /** The last day of actions, newest first, at most 30. */
  log: DesktopAutopilotLogEntry[];
  /** Apps Autopilot has learned a filing for from this person's entries. */
  learnedApps: number;
  /**
   * Epoch ms a pause ends at, or null. While paused Autopilot starts,
   * switches and stops nothing; its own timer keeps running and stays its own.
   */
  pausedUntil: number | null;
}

/** The running entry, as the renderer describes it to Autopilot. */
export interface DesktopAutopilotRunning {
  start: number;
  description: string;
  projectId: string | null;
  taskId: string | null;
}

/** One of this person's entries, for learning what each app is used for. */
export interface DesktopAutopilotHistoryEntry {
  start: number;
  end: number;
  description: string;
  projectId: string | null;
  taskId: string | null;
  tagIds: string[];
  billable: boolean;
}

/**
 * What the renderer should do now. A `token` names the decision; the renderer
 * reports back with it once the write was made (or failed), and only then
 * does Autopilot count the timer as its own.
 */
export type DesktopAutopilotPlan =
  | { kind: "none" }
  | {
      kind: "start" | "switch";
      token: string;
      at: number;
      filing: DesktopAutopilotFiling;
      app: DesktopActivityApp;
      creditedMs: number;
    }
  | { kind: "stop"; token: string; at: number; app: DesktopActivityApp | null };

/**
 * Autopilot (on top of Stage 8 capture). Main decides from what it recorded;
 * the renderer makes the write through the same mutations as the tracker, so
 * an Autopilot start is an ordinary start — optimistic, queued offline,
 * `source: "desktop"`.
 */
export interface DesktopAutopilot {
  /** This person's recent entries, to learn which app is used for what. */
  learn: (history: DesktopAutopilotHistoryEntry[]) => Promise<void>;
  /** `tracked` is everything tracked WITHOUT the running entry. */
  plan: (input: {
    running: DesktopAutopilotRunning | null;
    tracked: DesktopActivityInterval[];
  }) => Promise<DesktopAutopilotPlan>;
  /**
   * The write for a plan was made (`ok`) or refused. `written` is what was
   * actually filed — a project the catalog no longer has is dropped first.
   */
  applied: (result: {
    token: string;
    ok: boolean;
    written?: { description: string; projectId: string | null; taskId: string | null };
  }) => Promise<void>;
  /**
   * Not now: hold a filing or an app until the next break, optionally treat a
   * span as accounted for (an undone start), and mark a log entry undone.
   */
  hold: (input: {
    filingKey?: string;
    appKey?: string;
    dismiss?: DesktopActivityInterval;
    logId?: string;
  }) => Promise<void>;
  /**
   * Pause for an hour (`paused: true`), or resume now. The length is the main
   * process's (`AUTOPILOT_PAUSE_MS`), so the tray item and the screens agree.
   * A pause survives a restart and ends on sign-out.
   */
  pause: (input: { paused: boolean }) => Promise<void>;
}

/**
 * Desktop activity capture (Stage 8). Raw segments never cross this bridge:
 * the main process composes suggestions and answers with those.
 */
export interface DesktopActivity {
  snapshot: () => Promise<DesktopActivitySnapshot>;
  onChanged: (listener: (snapshot: DesktopActivitySnapshot) => void) => () => void;
  updateSettings: (patch: Partial<DesktopActivitySettings>) => Promise<DesktopActivitySnapshot>;
  /** Whose activity is recorded. There is no way to clear it but `forget`. */
  setScope: (scope: { userId: string; workspaceId: string }) => Promise<void>;
  /** Sign-out and account deletion: every row, rule and dismissal, and the scope. */
  forget: () => Promise<void>;
  /** "Delete all activity now": every row, rule and dismissal; the scope stays. */
  wipe: () => Promise<DesktopActivitySnapshot>;
  /** Null when there is no scope or the store belongs to a newer build. */
  suggestions: (input: {
    from: number;
    to: number;
    tracked: DesktopActivityInterval[];
  }) => Promise<DesktopActivitySuggestion[] | null>;
  checkAccept: (input: {
    start: number;
    end: number;
    edited: boolean;
    tracked: DesktopActivityInterval[];
  }) => Promise<DesktopActivityAcceptCheck>;
  /** Treat a just-accepted span as tracked for a few minutes, until the entry lists. */
  markAccepted: (span: DesktopActivityInterval) => Promise<void>;
  dismiss: (span: DesktopActivityInterval) => Promise<boolean>;
  /** Replaces a rule with the same pattern. */
  addRule: (rule: Omit<DesktopActivityRule, "id">) => Promise<DesktopActivityRule[]>;
  removeRule: (id: string) => Promise<DesktopActivityRule[]>;
  /** Optional so a preload from before Autopilot is still a valid bridge. */
  autopilot?: DesktopAutopilot;
}

/**
 * `window.electronAPI`. Guard every use: the same export also runs in a
 * browser, an installed PWA and the Capacitor shells, where it is undefined.
 */
export interface DesktopBridge {
  isDesktop: true;
  /**
   * The OS, known synchronously so the pre-paint script can put it on
   * `<html data-platform>` before the first frame (the macOS traffic-light
   * inset depends on it). Widened to `string` for platforms Electron supports
   * and this app does not style.
   */
  platform: DesktopPlatform | (string & {});
  quit: () => Promise<void>;
  openExternal: (url: string) => Promise<boolean>;

  /**
   * OS-level idle, which sees input in every application — a renderer only
   * sees its own. Optional so a caller keeps guarding on it.
   */
  getIdleState?: () => Promise<DesktopIdlePayload>;
  onIdleState?: (listener: (payload: DesktopIdlePayload) => void) => () => void;

  /** The bearer session token's home (Stage 2). */
  secureStore: DesktopSecureStore;

  /** Tray, global shortcuts, desktop settings and notifications (Stages 4 and 5). */
  desktop: DesktopShell;

  /** Activity capture (Stage 8). Optional so an older preload is still a valid bridge. */
  activity?: DesktopActivity;
}

/**
 * Every IPC channel name, in one place. The main process registers handlers
 * under these and the preload invokes them, so a rename is one edit.
 */
export const DESKTOP_IPC = {
  quit: "app:quit",
  openExternal: "app:openExternal",
  getIdle: "idle:get",
  tokenGet: "secure-store:get",
  tokenSet: "secure-store:set",
  tokenDelete: "secure-store:delete",
  tokenStatus: "secure-store:status",
  desktopPublishState: "desktop:timer-state",
  desktopSettingsGet: "desktop:settings-get",
  desktopSettingsUpdate: "desktop:settings-update",
  desktopSuspendShortcuts: "desktop:shortcuts-suspend",
  desktopShowWindow: "desktop:window-show",
  desktopNotify: "desktop:notify",
  updateGetStatus: "update:status",
  updateCheck: "update:check",
  updateRestart: "update:restart",
  activitySnapshot: "activity:snapshot",
  activitySettings: "activity:settings",
  activityScope: "activity:scope",
  activityForget: "activity:forget",
  activityWipe: "activity:wipe",
  activitySuggestions: "activity:suggestions",
  activityCheckAccept: "activity:check-accept",
  activityAccepted: "activity:accepted",
  activityDismiss: "activity:dismiss",
  activityRuleAdd: "activity:rule-add",
  activityRuleRemove: "activity:rule-remove",
  activityAutopilotLearn: "activity:autopilot-learn",
  activityAutopilotPlan: "activity:autopilot-plan",
  activityAutopilotApplied: "activity:autopilot-applied",
  activityAutopilotHold: "activity:autopilot-hold",
  activityAutopilotPause: "activity:autopilot-pause",
  /** main → renderer push, not an invoke. */
  idleState: "idle:state",
  /** main → renderer push. */
  desktopCommand: "desktop:command",
  /** main → renderer push. */
  desktopSettingsChanged: "desktop:settings-changed",
  /** main → renderer push. */
  updateStatusChanged: "update:status-changed",
  /** main → renderer push, at most one per two seconds. */
  activityChanged: "activity:changed",
} as const;

export type DesktopIpcChannel = (typeof DESKTOP_IPC)[keyof typeof DESKTOP_IPC];

/**
 * The origin the packaged app serves its export from. A constant on purpose:
 * `localStorage`, the offline queue and every server's trust list are keyed by
 * origin, so changing the scheme or host after a release orphans all of them.
 */
export const DESKTOP_APP_SCHEME = "app";
export const DESKTOP_APP_HOST = "-";
export const DESKTOP_APP_ORIGIN = `${DESKTOP_APP_SCHEME}://${DESKTOP_APP_HOST}` as const;
