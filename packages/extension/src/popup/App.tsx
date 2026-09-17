import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { dayKeyInZone, deviceTimeZone, type QuickStart } from "@starter/core";
import {
  sendToBackground,
  type AcceptedFields,
  type ActivitySettings,
  type ActivitySuggestion,
  type BackgroundResponse,
  type BackgroundState,
  type PopupToBackground,
  type PopupView,
  type SettingsPatch,
} from "../lib/messaging";
import { DEFAULT_API_URL } from "../lib/config";
import { describeError } from "./errors";
import type { EntryFieldPatch } from "./entry-form";
import {
  back,
  defaultDraft,
  navigate,
  topOf,
  viewOf,
  ROOT_STACK,
  type EntryDraft,
  type PopupStack,
  type Route,
  type SettingsSection,
} from "./route";
import { forgetRoute, loadRoute, rememberRoute } from "./route-memory";
import { Screens } from "./screens";
import { rememberTheme } from "./theme";
import { OriginNotTrustedNotice } from "./origin-not-trusted-notice";
import { VersionBanner } from "./version-banner";
import { applyLocalePreference, useT } from "../i18n/use-t";
import { SignInScreen } from "./sign-in-screen";
import type { SetServerOutcome } from "./switch-server";
import type { RunningPatch } from "./tracker-screen";

/**
 * The whole popup.
 *
 * It owns no domain state of its own: every message returns a full
 * {@link BackgroundState}, which is stored verbatim and rendered. The only
 * local state is "have we heard from the worker yet", "what went wrong last
 * time", "what just happened" and "which screen are we on" — everything else
 * lives in the service worker, which survives the popup being destroyed on
 * every close.
 *
 * Navigation is that last one, and it is deliberately kept out of the snapshot
 * contract: which screen is painted is not domain state, so it is held here
 * and mirrored into `chrome.storage.session` directly rather than being routed
 * through a service worker that might have to be woken to answer.
 */

/** How often an open popup re-reads the worker's snapshot. */
const REFRESH_MS = 3000;

/**
 * How long a manual draft may sit unsaved before it is written to route
 * memory.
 *
 * A write per keystroke would put a `chrome.storage.session` round trip behind
 * every letter of a description; 500 ms is short enough that a stolen focus
 * almost never lands inside the gap, and the unmount below flushes what is
 * still pending.
 */
const DRAFT_MEMORY_DEBOUNCE_MS = 500;

export function App(): JSX.Element {
  const t = useT("popup");
  const [state, setState] = useState<BackgroundState | null>(null);
  const [error, setError] = useState<string | null>(null);

  // `send` must keep a stable identity (it is a mount-effect dependency), yet
  // the failure it translates has to be said in the language on screen NOW —
  // a ref gives it both, the same trick `apiUrlRef` plays below.
  const tRef = useRef(t);
  tRef.current = t;

  /**
   * A one-line outcome of the transition that just happened, rendered by the
   * screen it landed on.
   *
   * UI state, not domain state: "Entry deleted." describes a navigation, and
   * the worker has no opinion about it. Cleared by the next navigation and by
   * the next failure, so it can never be read as a description of something
   * other than the step that produced it.
   */
  const [note, setNote] = useState<string | null>(null);

  const [stack, setStack] = useState<PopupStack>(ROOT_STACK);

  // The callbacks below need the stack they are navigating *from*, and reading
  // it out of `stack` would make every one of them change identity on every
  // navigation — including `onSelectProject`, which is an effect dependency in
  // the entry form. A ref kept in step at every set point keeps them stable.
  const stackRef = useRef<PopupStack>(ROOT_STACK);

  // "Could not reach X" has to name the URL that actually failed, but reading
  // it from state would make `send` change identity on every snapshot — and a
  // `send` that changes identity re-runs the mount effect below. A ref keeps
  // the message current and the callback stable.
  const apiUrlRef = useRef(DEFAULT_API_URL);

  /** True once the stack has been set by anything at all: a tap, or a restore. */
  const navigatedRef = useRef(false);

  /** The view a `view:set` is currently in flight for, so it is not re-sent. */
  const requestedViewRef = useRef<PopupView | null>(null);

  /** The day an `activity:day` is in flight for, for the same reason. */
  const requestedDayRef = useRef<string | null>(null);

  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * One funnel for every message, so a fresh snapshot is applied and a
   * failure is translated in exactly one place. Resolves true on success,
   * which is all the callers need to decide whether to clear their inputs.
   */
  const send = useCallback(
    async (message: PopupToBackground): Promise<boolean> => {
      const response: BackgroundResponse = await sendToBackground(message);
      if (response.ok) {
        apiUrlRef.current = response.state.apiUrl;
        setState(response.state);
        setError(null);
        return true;
      }
      setError(
        describeError(
          response.code,
          response.message,
          apiUrlRef.current,
          tRef.current,
          response.details,
        ),
      );
      // A failure retires whatever the last transition said: "Entry added."
      // sitting above "The end has to be after the start." reads as though
      // both were true of the same action.
      setNote(null);
      return false;
    },
    [],
  );

  useEffect(() => {
    void send({ type: "state:get" });
  }, [send]);

  /**
   * Re-poll while the popup is open.
   *
   * The contract is request/response only, so nothing lets the worker push. A
   * popup left open would otherwise render its mount-time snapshot forever:
   * "Connecting…" that never becomes "Synced" (the socket opens milliseconds
   * after `buildState` reads its status), "Offline" after the network is back,
   * or a timer someone started on another device staying invisible.
   *
   * Deliberately silent — it must not clear or set the error banner, or a
   * blip would wipe the message from the action the user just took.
   */
  useEffect(() => {
    const handle = setInterval(() => {
      void sendToBackground({ type: "state:get" }).then((response) => {
        if (!response.ok) return;
        apiUrlRef.current = response.state.apiUrl;
        setState(response.state);
      });
    }, REFRESH_MS);
    return () => clearInterval(handle);
  }, []);

  /**
   * Move the stack, and everything that goes with moving it.
   *
   * The error is cleared on every navigation because an error names an action
   * taken on the screen you just left, and the note is replaced rather than
   * merged for the same reason. Route memory is written here rather than by
   * each caller so a screen can never be reached without being remembered —
   * except the root, which is forgotten instead: the toolbar button must open
   * on the timer, and a remembered tracker is indistinguishable from none.
   */
  const applyStack = useCallback(
    (next: PopupStack, nextNote: string | null): void => {
      navigatedRef.current = true;
      stackRef.current = next;
      setStack(next);
      setError(null);
      setNote(nextNote);
      if (next.length === 1) void forgetRoute();
      else void rememberRoute(next);
    },
    [],
  );

  const go = useCallback(
    (route: Route): void => {
      applyStack(navigate(stackRef.current, route), null);
    },
    [applyStack],
  );

  /**
   * Back one level, carrying a one-line account of what just happened.
   *
   * The note is a required argument rather than a defaulted one, and that is
   * load-bearing: {@link goBack} below is handed straight to a button's
   * `onClick`, so a defaulted parameter here would be filled with React's
   * synthetic event — which then goes into `note` and is rendered as a child.
   */
  const goBackWith = useCallback(
    (nextNote: string | null): void => {
      applyStack(back(stackRef.current), nextNote);
    },
    [applyStack],
  );

  const goBack = useCallback((): void => {
    goBackWith(null);
  }, [goBackWith]);

  const goTracker = useCallback((): void => {
    go({ name: "tracker" });
  }, [go]);

  /**
   * Follow the account's theme.
   *
   * `theme` is a synced user preference, so picking dark in the web app
   * darkens this popup on the next snapshot — including one taken three
   * seconds after another device changed it. Remembered as it is applied, so
   * the next open paints in the right theme before React runs at all.
   */
  useEffect(() => {
    const theme = state?.settings?.theme;
    if (theme === undefined) return;
    rememberTheme(theme);
  }, [state?.settings?.theme]);

  /**
   * Follow the account's language, for the same reasons as the theme: it is
   * a synced preference, and remembering it as it is applied is what lets the
   * next open render its first frame in the right language.
   */
  useEffect(() => {
    const locale = state?.settings?.locale;
    if (locale === undefined) return;
    applyLocalePreference(locale);
  }, [state?.settings?.locale]);

  /**
   * Tell the worker which surface is being looked at.
   *
   * Driven off the snapshot rather than fired from `applyStack`, because the
   * worker's view outlives this popup: a previous open that ended on the
   * entries list leaves a live worker still scoped to it, and reconciling
   * against `state.view` fixes that on mount for free. The ref keeps a second
   * poll tick from re-sending while the first is still in flight, and is
   * released the moment the worker agrees.
   */
  useEffect(() => {
    if (state === null) return;
    const desired = viewOf(topOf(stack));
    if (state.view === desired) {
      requestedViewRef.current = null;
      return;
    }
    if (requestedViewRef.current === desired) return;
    requestedViewRef.current = desired;
    void send({ type: "view:set", view: desired });
  }, [state, stack, send]);

  /**
   * Tell the worker which day the Suggestions screen is showing.
   *
   * The same reconciliation as the view above: the route owns the day, the
   * worker holds a copy that an eviction resets to today, and the snapshot's
   * `activity.day` says which one it computed.
   */
  useEffect(() => {
    if (state === null) return;
    const top = topOf(stack);
    if (top.name !== "suggestions" && top.name !== "suggestion-edit") return;
    if (state.view !== "suggestions") return;
    const desired = top.day ?? dayKeyInZone(Date.now(), deviceTimeZone());
    if (state.activity.day === desired) {
      requestedDayRef.current = null;
      return;
    }
    if (requestedDayRef.current === desired) return;
    requestedDayRef.current = desired;
    void send({ type: "activity:day", day: desired });
  }, [state, stack, send]);

  /**
   * Come back to the screen the popup was on moments ago.
   *
   * Applied only if the user has not navigated in the meantime: the snapshot
   * request goes out first so the tracker paints as fast as it always did, and
   * a storage read that resolved after a deliberate tap must not yank the
   * screen out from under it.
   */
  useEffect(() => {
    void (async (): Promise<void> => {
      const remembered = await loadRoute();
      if (remembered === null) return;
      if (navigatedRef.current) return;
      applyStack(remembered, null);
    })();
  }, [applyStack]);

  /**
   * A session that ended takes the stack with it.
   *
   * Nothing beyond the tracker means anything signed out, and the sign-in
   * screen is rendered in place of the whole stack anyway — so leaving a
   * settings route standing would only mean signing back in and landing in
   * Devices. The worker resets its own `activeView` in `forgetSession`, so no
   * `view:set` is owed here.
   */
  useEffect(() => {
    if (state === null || state.signedIn) return;
    if (stackRef.current.length === 1) return;
    stackRef.current = ROOT_STACK;
    setStack(ROOT_STACK);
    setNote(null);
    void forgetRoute();
  }, [state]);

  // The popup is being torn down, so this races the teardown and may not land.
  // That is the debounce's one cost, and it is cheaper than a session-storage
  // write behind every keystroke of a description.
  useEffect(
    () => () => {
      if (draftTimerRef.current === null) return;
      clearTimeout(draftTimerRef.current);
      void rememberRoute(stackRef.current);
    },
    [],
  );

  const signIn = useCallback(
    (email: string, password: string): Promise<boolean> =>
      send({ type: "auth:sign-in", email, password }),
    [send],
  );

  /**
   * Switch servers, answering the picker rather than the screen banner.
   *
   * Not through `send`: a refused server is the picker's own sentence, shown
   * under the address that was refused, and `send` would also raise it in the
   * screen's banner — one failure announced twice. The worker's codes are
   * translated by `describeError` against the server that was asked for; its
   * English sentence (core's `checkServer`) is only the fallback for a code
   * errors.ts does not know.
   */
  const setServer = useCallback(
    async (origin: string, discardUnsent: boolean): Promise<SetServerOutcome> => {
      const response = await sendToBackground({
        type: "config:set-server",
        origin,
        discardUnsent,
      });
      if (response.ok) {
        apiUrlRef.current = response.state.apiUrl;
        setState(response.state);
        setError(null);
        return { ok: true };
      }
      // Every refusal is described against the server that was asked for,
      // in the popup's language; a code errors.ts does not know keeps the
      // worker's own sentence.
      return {
        ok: false,
        code: response.code,
        message: describeError(
          response.code,
          response.message,
          origin,
          tRef.current,
          response.details,
        ),
      };
    },
    [],
  );

  const startDeviceSignIn = useCallback(
    (): Promise<boolean> => send({ type: "auth:device-start" }),
    [send],
  );

  const cancelDeviceSignIn = useCallback(
    (): Promise<boolean> => send({ type: "auth:device-cancel" }),
    [send],
  );

  const createTag = useCallback(
    (name: string): Promise<boolean> => send({ type: "tag:create", name }),
    [send],
  );

  const createClient = useCallback(
    (name: string): Promise<boolean> => send({ type: "client:create", name }),
    [send],
  );

  const createProject = useCallback(
    (name: string, clientId: string | null): Promise<boolean> =>
      send({ type: "project:create", name, clientId }),
    [send],
  );

  const createTask = useCallback(
    (name: string): Promise<boolean> => send({ type: "task:create", name }),
    [send],
  );

  const pinFavorite = useCallback(
    (quick: QuickStart): Promise<boolean> =>
      send({ type: "favorite:add", quick }),
    [send],
  );

  const updateRunning = useCallback(
    (patch: RunningPatch): Promise<boolean> =>
      send({ type: "timer:update", ...patch }),
    [send],
  );

  const unpinFavorite = useCallback(
    (id: string): Promise<boolean> => send({ type: "favorite:remove", id }),
    [send],
  );

  const signOut = useCallback(
    (): Promise<boolean> => send({ type: "auth:sign-out" }),
    [send],
  );

  const updateSettings = useCallback(
    (patch: SettingsPatch): Promise<boolean> =>
      send({ type: "settings:update", patch }),
    [send],
  );

  /**
   * Ask the worker for description suggestions.
   *
   * Silent, like the poll and for the same reason: it must not clear or set
   * the error banner. A typeahead that wiped the server's refusal off screen
   * because somebody kept typing would be taking the answer away mid-sentence,
   * and a network blip is not something a suggestion list should announce.
   */
  const searchDescriptions = useCallback((query: string): void => {
    void sendToBackground({ type: "descriptions:search", query }).then(
      (response) => {
        if (!response.ok) return;
        apiUrlRef.current = response.state.apiUrl;
        setState(response.state);
      },
    );
  }, []);

  const listDevices = useCallback(
    (): Promise<boolean> => send({ type: "devices:list" }),
    [send],
  );

  const revokeDevice = useCallback(
    (id: string): Promise<boolean> => send({ type: "device:revoke", id }),
    [send],
  );

  const revokeOtherDevices = useCallback(
    (): Promise<boolean> => send({ type: "devices:revoke-others" }),
    [send],
  );

  const loadMoreEntries = useCallback(
    (): Promise<boolean> => send({ type: "entries:more" }),
    [send],
  );

  const updateEntry = useCallback(
    (id: string, patch: EntryFieldPatch): Promise<boolean> =>
      // Spread rather than listed field by field: `EntryFieldPatch` is the
      // message's own optional set minus the id, and an absent key stays
      // absent through a spread — which is what tells the worker "leave this
      // alone" rather than "clear it".
      send({ type: "entry:update", id, ...patch }),
    [send],
  );

  const deleteEntry = useCallback(
    async (id: string): Promise<boolean> => {
      const ok = await send({ type: "entry:remove", id });
      if (ok) goBackWith(tRef.current("app.notes.entryDeleted"));
      return ok;
    },
    [send, goBackWith],
  );

  const createEntry = useCallback(
    async (draft: EntryDraft): Promise<boolean> => {
      const ok = await send({
        type: "entry:create",
        description: draft.description.trim(),
        projectId: draft.projectId,
        taskId: draft.taskId,
        billable: draft.billable,
        tagIds: draft.tagIds,
        start: draft.start,
        end: draft.end,
      });
      if (ok) goBackWith(tRef.current("app.notes.entryAdded"));
      return ok;
    },
    [send, goBackWith],
  );

  /**
   * A keystroke in the manual form.
   *
   * The draft lives on the route, so this replaces the top frame rather than
   * pushing — and deliberately does NOT go through `applyStack`: typing is not
   * a navigation, and clearing the error banner on every letter would take the
   * server's refusal off screen before it had been read.
   */
  const changeDraft = useCallback((draft: EntryDraft): void => {
    const next = navigate(stackRef.current, { name: "entry-new", draft });
    stackRef.current = next;
    setStack(next);
    if (draftTimerRef.current !== null) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = setTimeout(() => {
      draftTimerRef.current = null;
      void rememberRoute(stackRef.current);
    }, DRAFT_MEMORY_DEBOUNCE_MS);
  }, []);

  /**
   * A keystroke in a suggestion's entry form. Replaces the top frame without
   * a navigation, exactly like {@link changeDraft} does for a manual entry.
   */
  const changeSuggestionDraft = useCallback((day: string | null, draft: EntryDraft): void => {
    const next = navigate(stackRef.current, { name: "suggestion-edit", day, draft });
    stackRef.current = next;
    setStack(next);
    if (draftTimerRef.current !== null) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = setTimeout(() => {
      draftTimerRef.current = null;
      void rememberRoute(stackRef.current);
    }, DRAFT_MEMORY_DEBOUNCE_MS);
  }, []);

  const acceptSuggestion = useCallback(
    async (suggestion: ActivitySuggestion, fields: AcceptedFields): Promise<boolean> => {
      const ok = await send({
        type: "activity:accept",
        start: suggestion.start,
        end: suggestion.end,
        edited: false,
        ...fields,
      });
      if (ok) setNote(tRef.current("app.notes.entryAdded"));
      return ok;
    },
    [send],
  );

  const acceptEditedSuggestion = useCallback(
    async (draft: EntryDraft): Promise<boolean> => {
      const ok = await send({
        type: "activity:accept",
        start: Date.parse(draft.start),
        end: Date.parse(draft.end),
        edited: true,
        description: draft.description.trim(),
        projectId: draft.projectId,
        taskId: draft.taskId,
        billable: draft.billable,
        tagIds: draft.tagIds,
      });
      if (ok) goBackWith(tRef.current("app.notes.entryAdded"));
      return ok;
    },
    [send, goBackWith],
  );

  const dismissSuggestion = useCallback(
    (suggestion: ActivitySuggestion): Promise<boolean> =>
      send({ type: "activity:dismiss", start: suggestion.start, end: suggestion.end }),
    [send],
  );

  const addActivityRule = useCallback(
    (pattern: string, projectId: string | null): Promise<boolean> =>
      send({ type: "activity:rule-add", pattern, projectId, taskId: null }),
    [send],
  );

  const removeActivityRule = useCallback(
    (id: string): Promise<boolean> => send({ type: "activity:rule-remove", id }),
    [send],
  );

  const saveActivitySettings = useCallback(
    (patch: Partial<ActivitySettings>): Promise<boolean> =>
      send({ type: "activity:settings", patch }),
    [send],
  );

  /**
   * Ask Chrome for `tabs`. Must run inside the click: the prompt is refused
   * outside a user gesture, so nothing may be awaited before this call.
   */
  const requestActivityPermission = useCallback(async (): Promise<boolean> => {
    try {
      const granted = await chrome.permissions.request({ permissions: ["tabs"] });
      if (!granted) {
        setError(tRef.current("errors.activityPermission"));
      }
      return granted;
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : tRef.current("errors.activityPermissionFailed"),
      );
      return false;
    }
  }, []);

  const wipeActivity = useCallback(
    async (): Promise<boolean> => {
      const ok = await send({ type: "activity:wipe" });
      if (ok) setNote(tRef.current("app.notes.activityWiped"));
      return ok;
    },
    [send],
  );

  const openSection = useCallback(
    (section: SettingsSection | null): void => {
      go({ name: "settings", section });
    },
    [go],
  );

  const openEntry = useCallback(
    (id: string): void => {
      go({ name: "entry", id });
    },
    [go],
  );

  const newEntry = useCallback((): void => {
    go({ name: "entry-new", draft: defaultDraft() });
  }, [go]);

  /**
   * The window loaded and the row is not in it — deleted on another device,
   * or scrolled out of the window by an edit that moved its start.
   *
   * Guarded on still being the entry route: the detail screen's effect can
   * fire once more as it unmounts, and a second `back()` would drop the user
   * out of the entries list they were just returned to.
   */
  const entryMissing = useCallback((): void => {
    if (topOf(stackRef.current).name !== "entry") return;
    goBackWith(tRef.current("app.notes.entryGone"));
  }, [goBackWith]);

  if (state === null) {
    return (
      <div className="popup">
        <div className="popup__body">
          {error === null ? (
            <p className="loading" data-testid="popup-loading">
              {t("app.loading")}
            </p>
          ) : (
            <>
              <p className="notice" role="alert" aria-live="assertive">
                {error}
              </p>
              <button
                className="button button--block"
                type="button"
                onClick={() => {
                  void send({ type: "state:get" });
                }}
                data-testid="popup-retry"
              >
                {t("app.retry")}
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="popup">
      <VersionBanner compatibility={state.compatibility} t={t} />
      {state.originTrusted === false ? <OriginNotTrustedNotice apiUrl={state.apiUrl} /> : null}
      {state.signedIn ? (
        <Screens
          route={topOf(stack)}
          tracker={{
            state,
            error,
            onStart: (description, projectId, taskId, billable, tagIds) =>
              send({
                type: "timer:start",
                description,
                projectId,
                taskId,
                billable,
                tagIds,
              }),
            onStop: () => send({ type: "timer:stop" }),
            onUpdateRunning: updateRunning,
            onPinFavorite: pinFavorite,
            onUnpinFavorite: unpinFavorite,
            onAnswerIdle: (answer) => send({ type: "idle:answer", answer }),
            onOpenSettings: () => openSection(null),
            onOpenEntries: () => go({ name: "entries" }),
            onOpenSuggestions: () => go({ name: "suggestions", day: null }),
            onSearchDescriptions: searchDescriptions,
            onCreateClient: createClient,
            onCreateTag: createTag,
            onCreateProject: createProject,
            onCreateTask: createTask,
            onSwitchWorkspace: (workspaceId) =>
              send({ type: "workspace:switch", workspaceId }),
            onDiscardHeld: (id) => send({ type: "queue:discard-held", id }),
          }}
          settings={{
            state,
            error,
            note,
            onOpenSection: openSection,
            onBack: goBack,
            onGoTracker: goTracker,
            onUpdateSettings: updateSettings,
            onListDevices: listDevices,
            onRevokeDevice: revokeDevice,
            onRevokeOtherDevices: revokeOtherDevices,
            onSignOut: signOut,
            onSetServer: setServer,
            onSaveActivitySettings: saveActivitySettings,
            onRequestActivityPermission: requestActivityPermission,
            onWipeActivity: wipeActivity,
          }}
          entries={{
            state,
            error,
            note,
            onBack: goBack,
            onGoTracker: goTracker,
            onOpenEntry: openEntry,
            onNewEntry: newEntry,
            onLoadMore: loadMoreEntries,
          }}
          entry={{
            state,
            error,
            note,
            onBack: goBack,
            onGoTracker: goTracker,
            onUpdateEntry: updateEntry,
            onDeleteEntry: deleteEntry,
            onSearchDescriptions: searchDescriptions,
            onCreateClient: createClient,
            onCreateProject: createProject,
            onCreateTag: createTag,
            onCreateTask: createTask,
            onMissing: entryMissing,
          }}
          entryNew={{
            state,
            error,
            note,
            onBack: goBack,
            onGoTracker: goTracker,
            onDraftChange: changeDraft,
            onCreateEntry: createEntry,
            onSearchDescriptions: searchDescriptions,
            onCreateClient: createClient,
            onCreateProject: createProject,
            onCreateTag: createTag,
            onCreateTask: createTask,
          }}
          suggestions={{
            state,
            error,
            note,
            onBack: goBack,
            onGoTracker: goTracker,
            onOpenActivitySettings: () => openSection("activity"),
            onChangeDay: (day) => go({ name: "suggestions", day }),
            onAccept: acceptSuggestion,
            onEdit: (draft) => {
              const top = topOf(stackRef.current);
              go({
                name: "suggestion-edit",
                day: top.name === "suggestions" ? top.day : null,
                draft,
              });
            },
            onDismiss: dismissSuggestion,
            onAddRule: addActivityRule,
            onRemoveRule: removeActivityRule,
            onCreateClient: createClient,
            onCreateProject: createProject,
          }}
          suggestionEdit={{
            state,
            error,
            note,
            onBack: goBack,
            onGoTracker: goTracker,
            onDraftChange: changeSuggestionDraft,
            onAccept: acceptEditedSuggestion,
            onSearchDescriptions: searchDescriptions,
            onCreateClient: createClient,
            onCreateProject: createProject,
            onCreateTag: createTag,
            onCreateTask: createTask,
          }}
        />
      ) : (
        <SignInScreen
          apiUrl={state.apiUrl}
          serverVersion={state.serverVersion}
          webUrl={state.webUrl}
          pendingSync={state.pendingSync}
          pendingDeviceAuth={state.pendingDeviceAuth}
          deviceSignInError={state.deviceSignInError}
          error={error}
          onSignIn={signIn}
          onStartDeviceSignIn={startDeviceSignIn}
          onCancelDeviceSignIn={cancelDeviceSignIn}
          onSetServer={setServer}
        />
      )}
    </div>
  );
}
