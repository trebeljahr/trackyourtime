import { History, Star, Play } from "lucide-react";
import { QuickStartDrawer } from "./quick-start-drawer";
import { ClientPicker } from "./client-picker";
import { useState, type FormEvent, type JSX } from "react";
import {
  createId,
  deviceTimeZone,
  withProject,
  withTask,
  type DescriptionSuggestion,
  type DurationFormat,
  type EntryFields,
  type IdleAnswer,
  type Project,
  type QuickStart,
  type TimeEntry,
} from "@starter/core";
import type { BackgroundState } from "../lib/messaging";
import { formatDurationFor } from "../i18n/format";
import { usePopupLocale, useT } from "../i18n/use-t";
import { HeldQueue, WorkspacePicker } from "./workspace-bar";
import { DescriptionField } from "./description-field";
import { formatElapsed } from "./entry-format";
import { Header } from "./header";
import { TagPicker } from "./tag-picker";
import { IdlePanel } from "./idle-panel";
import { Menu } from "./menu";
import { ProjectPicker } from "./project-picker";
import { Switch } from "./switch";
import { describeSync } from "./sync-label";
import { useOpenPanels } from "./catalog-edit";
import { TimeField } from "./time-field";
import { TaskPicker } from "./task-picker";
import { useElapsedSec } from "./use-elapsed";

/** An edit to the running entry. Absent fields are left alone. */
export type RunningPatch = {
  start?: string;
  description?: string;
  clientId?: string | null;
  projectId?: string | null;
  taskId?: string | null;
  billable?: boolean;
  tagIds?: string[];
};

export type TrackerScreenProps = {
  state: BackgroundState;
  /** The last failure, already translated into human terms. */
  error: string | null;
  onStart: (
    description: string,
    projectId: string | null,
    taskId: string | null,
    /** Explicit for a quick start; omitted lets the project default decide. */
    billable?: boolean,
    tagIds?: string[],
    clientId?: string | null,
  ) => Promise<boolean>;
  onStop: () => Promise<boolean>;
  /** Edits the entry that is running. The worker resolves which one that is. */
  onUpdateRunning: (patch: RunningPatch) => Promise<boolean>;
  onPinFavorite: (quick: QuickStart) => Promise<boolean>;
  onUnpinFavorite: (id: string) => Promise<boolean>;
  /** Resolves the idle span the worker parked while the popup was closed. */
  onAnswerIdle: (answer: IdleAnswer) => Promise<boolean>;
  onSignOut?: () => Promise<boolean>;
  /** Opens account settings in the web app. */
  onOpenSettings: () => void;
  onOpenEntries: () => void;
  /** The Suggestions screen. Its header button shows only while capture is on. */
  onOpenSuggestions: () => void;
  /** Asks the worker what this person has called work like this before. */
  onSearchDescriptions: (query: string) => void;
  /** Loads the task list for a project into the worker's snapshot. */
  onCreateClient: (name: string) => Promise<boolean>;
  onCreateTag: (name: string) => Promise<boolean>;
  onCreateProject: (name: string, clientId: string | null) => Promise<boolean>;
  onCreateTask: (name: string) => Promise<boolean>;
  /** Points the extension (never the web app) at another workspace. */
  onSwitchWorkspace: (workspaceId: string) => Promise<boolean>;
  /** Discards one change held for a workspace the person has left. */
  onDiscardHeld: (id: string) => Promise<boolean>;
};

/** Local-clock seconds elapsed today, the ceiling on a running entry's share. */
const secondsSinceMidnight = (nowMs: number = Date.now()): number => {
  const now = new Date(nowMs);
  return now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
};

/**
 * The entry the popup shows the instant Start is pressed, before the worker
 * has answered. Only the fields the composer renders are ever read from it;
 * the server-owned ones are placeholders that the real snapshot overwrites a
 * moment later.
 */
const provisionalEntry = (
  description: string,
  projectId: string | null,
  taskId: string | null,
  billable: boolean,
  tagIds: string[],
): TimeEntry => {
  const now = new Date().toISOString();
  return {
    id: createId(),
    workspaceId: "",
    authorId: "",
    description,
    projectId,
    taskId,
    billable,
    start: now,
    end: null,
    durationSec: 0,
    hourlyRate: null,
    currency: "",
    source: "extension",
    timeZone: deviceTimeZone(),
    runaway: null,
    tagIds,
    invoiceId: null,
    importId: null,
    createdAt: now,
    updatedAt: now,
  };
};

/**
 * The rule the server applies to an omitted `billable`, reproduced here.
 *
 * The composer now has a toggle, so it always sends a concrete value — and
 * that value has to start where the server would have put it, or picking a
 * billable project would quietly track unbillable time.
 */
const billableDefaultFor = (
  projects: Project[],
  projectId: string | null,
): boolean => {
  if (projectId === null) return false;
  return (
    projects.find((candidate) => candidate.id === projectId)?.billableDefault ??
    false
  );
};

export function TrackerScreen({
  state,
  error,
  onStart,
  onStop,
  onUpdateRunning,
  onPinFavorite,
  onUnpinFavorite,
  onAnswerIdle,
  onOpenSettings,
  onSignOut,
  onOpenEntries,
  onOpenSuggestions,
  onSearchDescriptions,
  onCreateClient,
  onCreateTag,
  onCreateProject,
  onCreateTask,
  onSwitchWorkspace,
  onDiscardHeld,
}: TrackerScreenProps): JSX.Element {
  const t = useT("popup");
  const locale = usePopupLocale();
  const [description, setDescription] = useState("");
  const [clientId, setClientId] = useState<string | null | undefined>(
    undefined,
  );
  const [projectId, setProjectId] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [billable, setBillable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [drawer, setDrawer] = useState<"recents" | "favorites" | null>(null);

  /** Which pickers have a create or edit panel open; see the hook. */
  const panels = useOpenPanels();

  // While a start/stop is in flight this holds the timer the user just asked
  // for. `null` (the outer one) means "no override" — the inner `running` is
  // itself nullable, which is exactly the stopped case, so the two cannot be
  // collapsed into one nullable field.
  const [optimistic, setOptimistic] = useState<{
    running: TimeEntry | null;
  } | null>(null);

  const running = optimistic === null ? state.running : optimistic.running;
  const elapsedSec = useElapsedSec(running);

  /**
   * One set of fields, showing either a draft or the entry that is running.
   *
   * They are re-seeded whenever the timer's *identity* changes — which covers a
   * start or a stop made on another device, not just in this popup — and never
   * on a plain refresh, so an edit being typed here is not overwritten three
   * seconds later by the poll. Done during render rather than in an effect so
   * the fields are right on the first paint after a cross-device change.
   */
  const runningId = running?.id ?? null;
  const [lastRunningId, setLastRunningId] = useState<string | null>(null);
  if (lastRunningId !== runningId) {
    setLastRunningId(runningId);
    if (running !== null) {
      setDescription(running.description);
      setClientId(running.clientId);
      setProjectId(running.projectId);
      setTaskId(running.taskId);
      setBillable(running.billable);
      setTagIds(running.tagIds);
    } else {
      // The description and the task belonged to the entry that just ended.
      // The project, its tags and its billable flag stay: the next block of
      // work is usually the same kind of work, and re-picking every label
      // would undo the point of a one-click toolbar.
      setDescription("");
      setTaskId(null);
    }
  }

  /**
   * Push an edit at the running entry, or do nothing when composing a draft.
   *
   * Deliberately not gated on `busy` and not awaited: labelling work as you go
   * is the whole point of editing a running timer, and a picker that refused
   * the second change until the first round trip finished would feel broken.
   */
  const patchRunning = (patch: RunningPatch): void => {
    if (running === null) return;
    void onUpdateRunning(patch);
  };

  /**
   * The five fields as `@starter/core` sees them, so the popup answers project
   * and task with the same rules the web app does rather than a second
   * implementation of them that can drift.
   */
  const fields: EntryFields = {
    description,
    clientId,
    projectId,
    taskId,
    billable,
    tagIds,
  };

  const selectProject = (next: string | null): void => {
    const updated = withProject(fields, next);
    if (updated === fields) return;
    setProjectId(updated.projectId);

    if (running !== null) {
      const clientPatch =
        clientId === undefined && (state.compatibility?.apiLevel ?? 0) >= 7
          ? {
              clientId:
                state.projects.find((project) => project.id === projectId)
                  ?.clientId ?? null,
            }
          : {};
      if (clientPatch.clientId !== undefined) setClientId(clientPatch.clientId);
      patchRunning({ projectId: updated.projectId, ...clientPatch });
      return;
    }
    // Only a draft follows the project's default. Changing the project under a
    // running entry must not silently re-decide whether that time is billable.
    setBillable(billableDefaultFor(state.projects, updated.projectId));
  };

  const selectTask = (next: string | null): void => {
    const updated = withTask(fields, next);
    if (updated === fields) return;
    setTaskId(updated.taskId);
    patchRunning({ taskId: updated.taskId });
  };

  const selectTags = (next: string[]): void => {
    setTagIds(next);
    patchRunning({ tagIds: next });
  };

  const toggleBillable = (): void => {
    const next = !billable;
    setBillable(next);
    patchRunning({ billable: next });
  };

  /**
   * Save a settled description against the running entry.
   *
   * A draft needs no write — `setDescription` has already recorded it, and it
   * reaches the server when Start is pressed.
   */
  const commitDescription = (next: string): void => {
    setDescription(next);
    if (running === null) return;
    if (next === running.description) return;
    patchRunning({ description: next });
  };

  /**
   * A suggestion taken with everything the entry behind it carried.
   *
   * The whole point of the gesture is that it is one action: filling the
   * fields one at a time would send `timer:update` four times against a
   * running entry, and on a draft would re-derive `billable` from the project
   * halfway through and overwrite the flag the suggestion came with.
   */
  const fillFromSuggestion = (suggestion: DescriptionSuggestion): void => {
    setDescription(suggestion.description);
    setClientId(suggestion.clientId);
    setProjectId(suggestion.projectId);
    setTaskId(suggestion.taskId);
    setTagIds(suggestion.tagIds);
    setBillable(suggestion.billable);
    if (running === null) return;
    patchRunning({
      description: suggestion.description,
      clientId: suggestion.clientId,
      projectId: suggestion.projectId,
      taskId: suggestion.taskId,
      tagIds: suggestion.tagIds,
      billable: suggestion.billable,
    });
  };

  const pin = async (quick: QuickStart): Promise<void> => {
    setBusy(true);
    await onPinFavorite(quick);
    setBusy(false);
  };

  const unpin = async (id: string): Promise<void> => {
    setBusy(true);
    await onUnpinFavorite(id);
    setBusy(false);
  };

  const start = async (quick?: QuickStart): Promise<void> => {
    if (busy) return;
    const next = quick ?? {
      description: "",
      projectId: null,
      taskId: null,
      billable: false,
    };
    setBusy(true);
    setDrawer(null);
    setOptimistic({
      running: {
        ...provisionalEntry(
          next.description,
          next.projectId,
          next.taskId,
          next.billable,
          [],
        ),
        clientId: next.clientId,
      },
    });
    try {
      await onStart(
        next.description,
        next.projectId,
        next.taskId,
        next.billable,
        [],
        next.clientId,
      );
    } finally {
      setOptimistic(null);
      setBusy(false);
    }
  };

  const answerIdle = async (answer: IdleAnswer): Promise<void> => {
    if (busy) return;
    setBusy(true);
    // No optimistic override: which entry ends up running depends on the
    // answer, and guessing wrong would flash the opposite of what happened.
    await onAnswerIdle(answer);
    setBusy(false);
  };

  const stop = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setOptimistic({ running: null });
    await onStop();
    setOptimistic(null);
    setBusy(false);
  };

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (running === null) void start();
    else void stop();
  };

  // `state.todaySec` counts finished entries only, so the running one is added
  // here — clamped to the part of it that falls inside today, or an overnight
  // timer would credit the whole night to this morning.
  const runningToday =
    running === null ? 0 : Math.min(elapsedSec, secondsSinceMidnight());
  const todaySec = state.todaySec + runningToday;

  // Tasks are workspace-wide, so the snapshot always carries the whole list.
  const tasks = state.tasks;

  const sync = describeSync(
    t,
    state.syncStatus,
    state.serverReachable,
    state.pendingSync,
  );

  // The same setting the entries list and the entry forms read, so a user who
  // asked for decimal is not shown two spellings of a duration at once.
  const durationFormat: DurationFormat =
    state.settings?.durationFormat ?? "hms";

  return (
    <div className="screen" data-testid="tracker-screen">
      <Header
        title="Track Your Time"
        branded
        onOpenEntries={onOpenEntries}
        accountMenu={
          <Menu
            webUrl={state.webUrl}
            email={state.email}
            name={state.profileName}
            image={state.profileImage}
            onOpenSettings={onOpenSettings}
            onSignOut={onSignOut}
            sharedSession={state.sessionSource === "web"}
          />
        }
        // Off by default, so by default the tracker looks exactly as it did.
        onOpenSuggestions={
          state.activity.settings.enabled ? onOpenSuggestions : undefined
        }
      />

      <div className="popup__body">
        <nav className="timer-shortcuts" aria-label={t("quickStart.shortcuts")}>
          <button
            type="button"
            disabled={busy}
            onClick={() => setDrawer("recents")}
            data-testid="open-recents"
          >
            <History size={21} aria-hidden="true" />
            {t("quickStart.recents")}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setDrawer("favorites")}
            data-testid="open-favorites"
          >
            <Star size={21} aria-hidden="true" />
            {t("quickStart.favorites")}
          </button>
        </nav>
        {drawer !== null && (
          <QuickStartDrawer
            kind={drawer}
            items={
              drawer === "recents"
                ? state.recents.map((item) => ({
                    ...item,
                    kind: "recent" as const,
                  }))
                : state.favorites.map((item) => ({
                    ...item,
                    kind: "favorite" as const,
                  }))
            }
            busy={busy}
            onClose={() => setDrawer(null)}
            onStart={(quick) => void start(quick)}
            onPin={(quick) => void pin(quick)}
            onUnpin={(id) => void unpin(id)}
          />
        )}

        {/* First, because it decides where everything below is filed. A draft
            in the form is kept across a switch; its project may not exist in
            the next workspace, which the picker then shows as unset. */}
        <WorkspacePicker
          workspaces={state.workspaces}
          activeWorkspaceId={state.activeWorkspaceId}
          disabled={busy}
          onSwitch={(workspaceId) => {
            setClientId(undefined);
            setProjectId(null);
            setTaskId(null);
            setTagIds([]);
            void onSwitchWorkspace(workspaceId);
          }}
          t={t}
        />

        {/* Above everything else: it is a question about the time already on
            the clock below, and answering it changes what that clock says. */}
        {state.pendingIdle !== null ? (
          <IdlePanel
            pending={state.pendingIdle}
            busy={busy}
            onAnswer={(answer) => {
              void answerIdle(answer);
            }}
          />
        ) : null}

        {/* One form for both states. The fields are the same either way — a
            draft's and a running entry's — so splitting them into two blocks
            would mean two places for every field to drift out of step. */}
        {running !== null ? (
          <form
            id="tracker-form"
            className="form"
            onSubmit={submit}
            data-testid={
              running === null ? "tracker-start-form" : "tracker-running"
            }
          >
            {running !== null ? (
              <div className="tracker-clock">
                <span className="elapsed" data-testid="tracker-elapsed">
                  {formatElapsed(elapsedSec, durationFormat, locale)}
                </span>
                <TimeField
                  label={t("fields.startTime")}
                  value={running.start}
                  zone={running.timeZone ?? deviceTimeZone()}
                  timeFormat={state.settings?.timeFormat ?? "24h"}
                  onCommit={(start) => patchRunning({ start })}
                  testId="tracker-start-time"
                />
              </div>
            ) : null}

            <DescriptionField
              id="description"
              label={t("fields.description")}
              value={description}
              // A draft has nothing settled behind it, so it compares against
              // itself: leaving an untouched field then writes nothing, and
              // Escape has nothing to restore it to.
              committed={running?.description ?? description}
              placeholder={t("tracker.descriptionPlaceholder")}
              autoFocus
              suggestions={state.descriptions ?? []}
              suggestionsFor={state.descriptionsFor}
              onSearch={onSearchDescriptions}
              onType={setDescription}
              onCommit={commitDescription}
              onFill={fillFromSuggestion}
              testId="tracker-description"
            />

            <ProjectPicker
              projects={state.projects}
              clients={state.clients}
              value={projectId}
              onChange={selectProject}
              busy={busy}
              onCreateClient={onCreateClient}
              onCreateProject={onCreateProject}
              onPendingChange={panels.track("project")}
              testId="tracker-project"
            />

            <ClientPicker
              state={state}
              value={clientId}
              projectId={projectId}
              onChange={(next) => {
                setClientId(next);
                patchRunning({ clientId: next });
              }}
              onCreate={onCreateClient}
              testId="tracker-client"
            />

            <TaskPicker
              tasks={tasks}
              value={taskId}
              onChange={selectTask}
              onCreate={onCreateTask}
              onPendingChange={panels.track("task")}
              testId="tracker-task"
            />

            <TagPicker
              tags={state.tags}
              value={tagIds}
              onChange={selectTags}
              onCreate={onCreateTag}
              onPendingChange={panels.track("tags")}
              testId="tracker-tags"
            />

            <Switch
              checked={billable}
              onChange={toggleBillable}
              label={billable ? t("fields.billable") : t("fields.notBillable")}
              variant="struck"
              currency={state.settings?.currency}
              testId="tracker-billable"
            />
          </form>
        ) : (
          <section className="new-timer" aria-labelledby="new-timer-title">
            <h2 id="new-timer-title">{t("tracker.newTimer")}</h2>
            <p className="popup__hint">{t("tracker.newTimerHint")}</p>
            <button
              type="button"
              className="button button--primary button--block new-timer__start"
              disabled={busy}
              onClick={() => void start()}
              data-testid="tracker-start"
            >
              <Play size={20} aria-hidden="true" />
              {t("tracker.newTimer")}
            </button>
          </section>
        )}

        <p className="today">
          <span>{t("tracker.today")}</span>
          <span className="today__value" data-testid="tracker-today">
            {formatDurationFor(todaySec, locale, durationFormat)}
          </span>
        </p>

        {/* Hidden while a timer runs, where the row would only offer to stop
            this one and start another. */}

        <HeldQueue rows={state.heldSync} onDiscard={onDiscardHeld} t={t} />

        <p
          className="notice"
          role="alert"
          aria-live="assertive"
          data-testid="tracker-error"
        >
          {error ?? ""}
        </p>
      </div>

      <div className="footer">
        {running !== null && (
          <button
            className="button button--danger button--block"
            type="submit"
            form="tracker-form"
            disabled={busy || panels.any}
            data-testid="tracker-stop"
          >
            {t("tracker.stop")}
          </button>
        )}
        <div className="footer__row">
          <span
            className="status"
            data-testid="tracker-sync-status"
            title={sync.title}
          >
            <span className={`status__dot status__dot--${sync.tone}`} />
            {sync.label}
          </span>
        </div>
      </div>
    </div>
  );
}
