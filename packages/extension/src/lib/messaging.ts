/**
 * The one channel between the popup and the service worker.
 *
 * The worker owns everything stateful — the session token, the api-client,
 * the sync socket, the offline queue. The popup is a renderer: it sends a
 * message and gets a full {@link BackgroundState} snapshot back. Snapshots
 * are whole, never partial, so the popup never merges — it just re-renders.
 * That matters because the popup is destroyed every time it closes, and a
 * half-applied patch would be indistinguishable from a stale one.
 */
import type {
  Client,
  DescriptionSuggestion,
  DetailedEntry,
  DetailedFavorite,
  DeviceSession,
  IdleAnswer,
  PendingIdle,
  Project,
  QueuedMutationSummary,
  QuickStart,
  QuickStartItem,
  RecentEntry,
  ResolvedSettings,
  SyncStatus,
  Tag,
  Task,
  TimeEntry,
  UpdateSettingsInput,
  VersionRefusal,
  WorkspaceSummary,
} from "@starter/core";
import type {
  ActivityRule,
  ActivitySuggestion,
} from "@starter/core/activity/index";
import type { ActivitySettings } from "../background/activity/settings";
import type { ActivityStorageProblem } from "../background/activity/store";
import type { DeviceSignInError } from "./device-auth-store";
import type { SessionSource } from "./session";

export type { ActivityRule, ActivitySettings, ActivitySuggestion, DeviceSignInError, SessionSource };

/**
 * Which of the popup's surfaces is on screen.
 *
 * The snapshot is whole, but not everything in it is cheap: the entry window
 * costs an `entries.list` page, and the popup re-reads the snapshot every three
 * seconds. Declaring the view lets `buildState` fetch only what is being looked
 * at and answer `null` — "not loaded for this view" — for the rest, which is a
 * different thing from an empty list.
 *
 * The worker holds the view rather than every message carrying it, so a
 * `state:get` already in flight when the user navigates still comes back
 * describing the screen they are now on.
 */
export type PopupView = "tracker" | "settings" | "entries" | "suggestions";

/**
 * Everything the Suggestions screen and Settings → Activity render.
 *
 * `settings` and `permitted` are on every snapshot — they are two local reads,
 * and the tracker's header decides from them whether to offer the screen at
 * all. `suggestions` and `rules` are filled only for the views that show them.
 */
export type ActivitySnapshot = {
  settings: ActivitySettings;
  /** Whether the optional `tabs` permission is granted right now. */
  permitted: boolean;
  /** The calendar day, in this device's zone, the suggestions describe. */
  day: string;
  /**
   * Untracked blocks on `day`, oldest first, or null when not loaded for this
   * view. Instants are epoch ms, the shape core computes them in.
   */
  suggestions: ActivitySuggestion[] | null;
  /** "Always file …" rules in the order they are tried, or null when not loaded. */
  rules: ActivityRule[] | null;
  /** Stored segments on this device, or null when not counted for this view. */
  storedSegments: number | null;
  /**
   * Why this build cannot use the activity database, or null when it can (or
   * has not needed to look). `newer-version`: a newer extension upgraded it,
   * and capture is off here until that version is back.
   */
  storageProblem: ActivityStorageProblem | null;
};

/** The fields an accepted suggestion is filed with. */
export type AcceptedFields = {
  description: string;
  projectId: string | null;
  taskId: string | null;
  billable?: boolean;
  tagIds?: string[];
};

/**
 * What the settings screen may change.
 *
 * `originId` is stripped: it identifies this worker, and the popup has no
 * business knowing it. The worker stamps it on the way out so the server's
 * `settings.changed` echo can be dropped as our own.
 */
export type SettingsPatch = Omit<UpdateSettingsInput, "originId">;

/**
 * The bounded window of past entries the popup browses.
 *
 * `entries.list` needs both ends, so the popup gets a fixed trailing window
 * rather than the web app's sentinel range: a 380px list nobody can filter or
 * search should not be able to grow without limit.
 *
 * `DetailedEntry`, not `TimeEntry` — the server already denormalizes the
 * project colour, project name, client name and task name onto each row, so a
 * popup row needs no join against `projects`/`clients`.
 */
export type EntryPage = {
  /**
   * Newest first, as the server returns them, with the running entry removed.
   * `entries.list` matches on overlap, so the running entry would otherwise
   * appear in the list *and* on the tracker, giving one row two editors.
   */
  entries: DetailedEntry[];
  /** Inclusive start of the window, ISO. Rendered as "the last N days". */
  from: string;
  to: string;
  /** True when `entries:more` would fetch another page. */
  hasMore: boolean;
  /**
   * Rows with a mutation still sitting in the offline queue. They render from
   * the local overlay and are not editable: a second edit stacked on an unsent
   * one would replay in an order the user never chose.
   */
  pendingIds: string[];
};

export type PopupToBackground =
  | { type: "state:get" }
  | { type: "auth:sign-in"; email: string; password: string }
  | { type: "auth:sign-out" }
  /**
   * "Sign in with the web app": start a device authorization, open its
   * approval page in a tab, and wait for it. Works for any server, and for an
   * account with two-factor authentication, which a password cannot complete.
   */
  | { type: "auth:device-start" }
  /** Stop waiting for the device authorization the popup started. */
  | { type: "auth:device-cancel" }
  | {
      type: "timer:start";
      description: string;
      projectId: string | null;
      taskId: string | null;
      /**
       * Omitted falls back to the picked project's `billableDefault`, which is
       * what the popup's own form wants. A quick start sends it explicitly:
       * the flag was decided when the favorite was pinned, or when the recent
       * entry was originally tracked, and re-deriving it here would silently
       * change what a pin means.
       */
      billable?: boolean;
      /**
       * Tags to open the entry with. A quick start passes the ones the
       * favorite or the recent already carries, for the same reason it passes
       * `billable` — they are part of what is being repeated.
       */
      tagIds?: string[];
    }
  | { type: "timer:stop" }
  /**
   * Edit the entry that is currently running.
   *
   * Every field is optional and absent means "leave it alone", which is the
   * same contract `entries.update` has server-side — so a patch queued offline
   * replays as exactly the edit that was made, not as a whole-entry overwrite
   * that would clobber a change some other device made in between.
   *
   * The entry is named by the worker rather than the popup: the popup's copy of
   * the running entry can be a few seconds stale, and an id from a snapshot
   * taken before another device stopped the timer would edit the wrong row.
   */
  | {
      type: "timer:update";
      description?: string;
      projectId?: string | null;
      taskId?: string | null;
      billable?: boolean;
      /** Replaces the whole set; `[]` clears it. */
      tagIds?: string[];
    }
  /** Pin the given combination. Idempotent — pinning twice is one pin. */
  | { type: "favorite:add"; quick: QuickStart }
  | { type: "favorite:remove"; id: string }
  /** The user's answer to the idle prompt the popup is showing. */
  | { type: "idle:answer"; answer: IdleAnswer }
  | { type: "client:create"; name: string }
  | { type: "tag:create"; name: string }
  | { type: "project:create"; name: string; clientId: string | null }
  | { type: "task:create"; name: string }
  /**
   * Use a different Track Your Time server.
   *
   * The worker re-validates everything the popup checked (the address, and
   * that a Track Your Time server answers at it and trusts this extension's
   * origin), because anything can send this message.
   *
   * Moving to another server signs out of the old one, and the extension's
   * sign-out discards its offline queue. `discardUnsent` is the person having
   * been told that and said yes; without it the worker refuses with
   * `UNSENT_CHANGES` while anything is queued, so a popup whose count was a
   * poll behind cannot throw work away that nobody was asked about.
   */
  | { type: "config:set-server"; origin: string; discardUnsent?: boolean }
  /**
   * Tell the worker which surface is showing.
   *
   * Sent only when the view actually changes, and answered like any other
   * message — with a whole snapshot, now scoped to the new view. Moving *into*
   * the entries view also marks the cached window stale, because arriving at a
   * list is exactly the moment it should be true rather than up to fifteen
   * seconds old.
   */
  | { type: "view:set"; view: PopupView }
  /**
   * Fetch the next page of the entry window and append it.
   *
   * The append happens in the worker. The contract is whole snapshots, and a
   * popup that concatenated pages itself would be merging domain state — the
   * one thing it is not allowed to do, because it is destroyed on every close
   * and has no baseline to merge onto.
   */
  | { type: "entries:more" }
  /**
   * Log a past entry.
   *
   * Both ends are required, unlike an edit: an entry with an open end IS a
   * running timer, and `timer:start` is the only door to one — routing a manual
   * create through here would let the popup open a second timer without going
   * past the stop-whatever-is-running rule.
   *
   * `source` and `timeZone` are stamped by the worker, not sent from here, for
   * the same reason `timer:start` does it: an entry logged from the toolbar
   * stays traceable to the toolbar, and a create queued offline keeps the zone
   * it was written in rather than the one it happens to sync from.
   */
  | {
      type: "entry:create";
      description: string;
      projectId: string | null;
      taskId: string | null;
      /** Omitted lets the picked project's `billableDefault` decide, as on start. */
      billable?: boolean;
      tagIds?: string[];
      start: string;
      end: string;
    }
  /**
   * Edit one past entry. Absent fields are left alone, as in `timer:update`.
   *
   * Unlike `timer:update` this one names its entry, and the asymmetry is the
   * point: "whichever entry is running" is a fact only the worker can resolve,
   * while "the row the user opened" is a fact only the popup knows.
   *
   * Only fields the user actually touched may be sent, and that is not economy:
   * `entries.update` refuses an invoiced entry on the mere *presence* of
   * `projectId`, `taskId`, `billable`, `start` or `end` — changed or not — so a
   * form that always sent its whole shape would be refused on an entry it never
   * modified.
   *
   * `end` is deliberately not nullable. Clearing it re-opens the entry, which
   * either starts a second timer or fails with CONFLICT against the one already
   * running; neither is something a 380px surface should be able to do.
   */
  | {
      type: "entry:update";
      id: string;
      description?: string;
      projectId?: string | null;
      taskId?: string | null;
      billable?: boolean;
      /** Replaces the whole set; `[]` clears it. */
      tagIds?: string[];
      start?: string;
      end?: string;
    }
  /** Delete one past entry. Refused server-side when the entry is invoiced. */
  | { type: "entry:remove"; id: string }
  /**
   * Patch settings. Nested blocks are merged key by key server-side, so a patch
   * carrying only `{ idle: { enabled: true } }` leaves the threshold and the
   * behaviour alone.
   *
   * Carried as one object rather than flattened onto the message because that
   * object is exactly what `updateSettingsSchema` accepts; rebuilding it from
   * flat fields here would be a second place for the shape to drift.
   *
   * Not queueable offline. `settings.update` is not one of core's offline ops,
   * and making it one would need a merge policy for two partial patches to the
   * same block — which the server does not have either. Offline this fails into
   * the error banner and the user retries, which is honest.
   */
  | { type: "settings:update"; patch: SettingsPatch }
  /**
   * Fill the device list.
   *
   * Sent when the Devices section is opened, never by the poll: a list of
   * signed-in sessions is not something that has to be right to the second, and
   * putting it on the snapshot's critical path would cost a `devices.list`
   * round trip every three seconds for a panel that is usually closed.
   */
  | { type: "devices:list" }
  /**
   * Ask what this person has called work like this before.
   *
   * Answered like everything else — with a whole snapshot, carrying the rows
   * and the query they answer. The query goes to the SERVER rather than
   * filtering a list held here, because the rows are a page out of six months:
   * a local filter would confidently answer "no match" for a description that
   * is certainly there, having simply not been among the rows the unfiltered
   * call happened to return.
   *
   * Never fails loudly. A typeahead that raises the popup's error banner
   * because the network blinked is worse than one that quietly offers nothing,
   * so the worker swallows the failure and leaves the last rows in place.
   */
  | { type: "descriptions:search"; query: string }
  /**
   * Sign one OTHER device out.
   *
   * Never this one. Revoking the current session kills the bearer token while
   * the worker still holds a session record, so the popup would keep rendering
   * `signedIn: true` against a dead credential — the half-applied state the
   * snapshot contract exists to prevent. Signing this device out is
   * `auth:sign-out`, which clears the record too. The worker refuses a current
   * session id so a UI regression cannot reach the server.
   */
  | { type: "device:revoke"; id: string }
  | { type: "devices:revoke-others" }
  /**
   * Which day the Suggestions screen shows, as a `YYYY-MM-DD` key in this
   * device's zone. Held by the worker like the view, and re-sent by the popup
   * whenever the snapshot's `activity.day` disagrees with its route.
   */
  | { type: "activity:day"; day: string }
  /**
   * Turn a suggestion into an entry.
   *
   * `start`/`end` are what the popup showed (epoch ms). The worker recomputes
   * against the entries as they are NOW before creating anything, because the
   * snapshot can be seconds old and the same span may have been tracked on
   * another device since. A plain accept is clipped to what is still untracked;
   * `edited: true` means the person set the times in the form themselves, which
   * are kept as long as they still overlap an untracked block.
   */
  | ({
      type: "activity:accept";
      start: number;
      end: number;
      edited: boolean;
    } & AcceptedFields)
  /** Hide a suggestion by marking its span as accounted for, on this device only. */
  | { type: "activity:dismiss"; start: number; end: number }
  /** "Always file <pattern> under …", a local rule. */
  | {
      type: "activity:rule-add";
      pattern: string;
      projectId: string | null;
      taskId: string | null;
      description?: string;
      billable?: boolean;
      tagIds?: string[];
    }
  | { type: "activity:rule-remove"; id: string }
  /**
   * Change the capture settings. Enabling is refused unless the popup has
   * already obtained the `tabs` permission from the click that asked for it.
   */
  | { type: "activity:settings"; patch: Partial<ActivitySettings> }
  /** Settings → Activity → "Delete all activity now". */
  | { type: "activity:wipe" }
  /**
   * Point the extension at another workspace.
   *
   * The extension's own choice: it never moves the web app's session, so a
   * switch in one place cannot retarget a timer started from the other. The
   * worker re-checks membership against a fresh list, because anything can
   * send this message.
   */
  | { type: "workspace:switch"; workspaceId: string }
  /**
   * Discard one held queued change: a left workspace's, or one waiting for a
   * newer build or a server update.
   *
   * The only way such a row ever leaves the queue short of a sign-out: it is
   * never replayed and never dropped on its own, because it is time no server
   * has seen. The worker refuses a row that is not held right now.
   */
  | { type: "queue:discard-held"; id: string };

/**
 * A queued change held here rather than sent, and why.
 *
 * `hold` is core's own `HoldReason`, `null` for a workspace this person has
 * left, or `other-account` for a change another account queued in this
 * browser — the queue outlives a web-app sign-out and account switch, and
 * those rows must never replay under the next account.
 */
export type HeldSyncRow = Omit<QueuedMutationSummary, "hold"> & {
  hold: QueuedMutationSummary["hold"] | "other-account";
};

/** The device authorization the popup is waiting on, as much as it may see. */
export type PendingDeviceSignIn = {
  /** The code the person checks on the approval page. */
  userCode: string;
  /** Epoch ms. */
  expiresAt: number;
};

/**
 * Whether this build and the server in use can work together, and what the
 * server said about itself — for the popup's version banner.
 */
export type ServerCompatibility = {
  /** Which side is too old, or null when both fit or it is not known yet. */
  refusal: VersionRefusal | null;
  /** The server's release, e.g. "0.3.1", when it said. */
  release: string | null;
  /** The server's API level, or null when not known yet. */
  apiLevel: number | null;
  /** The lowest server level this build works with (`MIN_SERVER_API_LEVEL`). */
  minServerApiLevel: number;
};

export type BackgroundState = {
  apiUrl: string;
  /** See {@link ServerCompatibility}. Present signed in and signed out. */
  compatibility: ServerCompatibility;
  /**
   * Whether the server trusts this extension's origin, as it last said.
   *
   * Every request the extension makes is a CORS request, and an untrusted
   * origin's requests fail exactly like a dead network. `false` is the server
   * saying so, and the popup says the true thing — which setting to change —
   * on the signed-in and the signed-out screens alike. `null` is "not said"
   * (an older server, or no answer yet), which is never treated as a refusal.
   */
  originTrusted: boolean | null;
  /**
   * "Track Your Time 0.1.0 (1a2b3c4)" for the server in use, or null when it
   * has not said. Read from its `/api/health`, or remembered from the check
   * that chose it.
   */
  serverVersion: string | null;
  /** Where "Open Track Your Time" goes. Discovered from the API's /api/health. */
  webUrl: string | null;
  signedIn: boolean;
  sessionSource: SessionSource | null;
  /**
   * The device authorization the popup's "Sign in with the web app" started,
   * while it waits. Null otherwise, and never the device code itself.
   */
  pendingDeviceAuth: PendingDeviceSignIn | null;
  /** Why the last popup-started device sign-in ended without a session. */
  deviceSignInError: DeviceSignInError | null;
  email: string | null;
  running: TimeEntry | null;
  projects: Project[];
  clients: Client[];
  /** Every unarchived tag — tags are not scoped to a project. */
  tags: Tag[];
  /** Every unarchived task — tasks are workspace-wide, like tags. */
  tasks: Task[];
  /**
   * The quick-start row: pins first, then recents, already merged.
   *
   * Merged in the worker rather than the popup because the worker owns all
   * state, and because the merge rule — a recent that is already pinned is
   * dropped — has to match what the web app shows or the same browser
   * disagrees with itself.
   */
  quickStarts: QuickStartItem[];
  /** The pins alone, so the popup can tell what unpinning would remove. */
  favorites: DetailedFavorite[];
  /** The derived tier, kept separate so a stale merge can be recomputed. */
  recents: RecentEntry[];
  todaySec: number;
  /** The live-update socket alone — see {@link BackgroundState.serverReachable}. */
  syncStatus: SyncStatus;
  /**
   * Whether the server answered the last read that reached a verdict.
   *
   * Reported separately from `syncStatus` because the two really are separate,
   * and collapsing them is what made a working toolbar say "Offline": every
   * read and write goes over plain HTTP, which keeps working when the
   * WebSocket upgrade is the only thing that failed. In that state the popup
   * is behind on other devices' changes, but nothing the user does here is
   * lost — a very different thing to tell them.
   */
  serverReachable: boolean;
  /**
   * Mutations waiting to be replayed. Zero on a healthy connection.
   *
   * Counted on the signed-out snapshot too: a web-app sign-out ends the
   * linked session without clearing the queue, and switching servers from
   * the sign-in screen would discard those rows — the picker has to know
   * there are some before it can ask.
   */
  pendingSync: number;
  /**
   * An idle span waiting to be explained, or null.
   *
   * The service worker has no UI, so with the `ask` behaviour it detects the
   * idleness, leaves the timer running and parks the question here for
   * whenever the popup is next opened. Nothing is discarded in the meantime.
   */
  pendingIdle: PendingIdle | null;
  /**
   * The view the popup last declared, echoed back.
   *
   * Without it the popup cannot tell a snapshot describing the screen it is on
   * from one taken a navigation ago, and would render "nothing here" for the
   * gap instead of "loading".
   */
  view: PopupView;
  /**
   * The user's resolved settings, or null before the first read has succeeded.
   *
   * Present in every snapshot, not just the settings view: the entries screen
   * renders clock times and durations, and `timeFormat` / `durationFormat`
   * decide how. It is close to free — `resolveSettings` answers from
   * `cachedSettings` until a foreign `settings.changed` event or a local write
   * replaces it.
   */
  settings: ResolvedSettings | null;
  /**
   * The entry window the popup is browsing, or null when the entries view is
   * not open.
   *
   * Null rather than an empty page because the two mean opposite things on
   * screen: "not fetched" is a loading line, "fetched and empty" is a real
   * answer that deserves its own words.
   */
  entries: EntryPage | null;
  /**
   * True when a sync event says an entry changed since this window was
   * fetched.
   *
   * The cached rows are still served rather than dropped: blanking a list under
   * someone mid-scroll is worse than showing it a second late. The next
   * `resolveEntryPage` refetches instead of honouring the TTL.
   */
  entriesStale: boolean;
  /**
   * Signed-in sessions, or null when they have never been asked for.
   *
   * Null rather than `[]` because an empty list is impossible — the caller's own
   * session is always in it — and would therefore be a bug worth seeing rather
   * than an empty state worth rendering.
   */
  devices: DeviceSession[] | null;
  /**
   * Descriptions this person has used before, or null until one is asked for.
   *
   * Fetched on demand like {@link BackgroundState.devices}, and for the same
   * reason: it is not worth a round trip every three seconds for a field
   * nobody is typing in.
   */
  descriptions: DescriptionSuggestion[] | null;
  /**
   * The query {@link BackgroundState.descriptions} answers.
   *
   * The popup compares it against what is in the field before offering the
   * rows. Typing outruns the round trip, so without it the list would spend
   * most of its life describing a prefix the user has already moved past.
   */
  descriptionsFor: string | null;
  /** Activity capture: always present, heavier halves scoped by view. */
  activity: ActivitySnapshot;
  /**
   * The workspaces this person belongs to, as last known. The popup offers a
   * picker only with more than one.
   */
  workspaces: WorkspaceSummary[];
  /** The workspace every request is addressed to, or null before any is known. */
  activeWorkspaceId: string | null;
  /**
   * Queued changes held here — for a workspace this person no longer belongs
   * to (`hold: null`), for another account (`other-account`), or for a `HoldReason` (a newer build wrote them, or the
   * server lacks the procedure they need) — never sent while held, never
   * dropped on their own, and NOT in `pendingSync`. Each names its workspace
   * when the name is still known.
   */
  heldSync: HeldSyncRow[];
};

/**
 * Values a refusal carries for the popup's translated sentence — the server's
 * level in a `SERVER_TOO_OLD`, say — since the worker's `message` is English.
 */
export type ErrorDetails = Readonly<Record<string, string | number | null>>;

export type BackgroundResponse =
  | { ok: true; state: BackgroundState }
  | { ok: false; code: string; message: string; details?: ErrorDetails };

const errorResponse = (code: string, message: string): BackgroundResponse => ({
  ok: false,
  code,
  message,
});

/**
 * Send one message and always resolve.
 *
 * An MV3 worker can be asleep, mid-restart, or throw before it replies, and
 * `chrome.runtime.sendMessage` surfaces all of that as a rejection or an
 * undefined response. Rejecting into the caller would leave the popup blank;
 * an `{ ok: false }` gives it something to render.
 */
export async function sendToBackground(
  message: PopupToBackground,
): Promise<BackgroundResponse> {
  try {
    const response: unknown = await chrome.runtime.sendMessage(message);

    // A worker that died before responding yields undefined, not an error.
    if (typeof response !== "object" || response === null) {
      return errorResponse(
        "NO_RESPONSE",
        "The extension background worker did not respond. Try again.",
      );
    }
    return response as BackgroundResponse;
  } catch (error) {
    return errorResponse(
      "PORT_CLOSED",
      error instanceof Error ? error.message : "Could not reach the extension.",
    );
  }
}
