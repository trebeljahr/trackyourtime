import { useState, type FormEvent, type JSX } from "react";
import {
  createId,
  deviceTimeZone,
  formatDuration,
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
import { Combobox } from "./combobox";
import { DescriptionField } from "./description-field";
import { formatElapsed } from "./entry-format";
import { Header } from "./header";
import { TagPicker } from "./tag-picker";
import { IdlePanel } from "./idle-panel";
import { Menu } from "./menu";
import { ProjectPicker } from "./project-picker";
import { QuickStartList } from "./quick-start-list";
import { Switch } from "./switch";
import { describeSync } from "./sync-label";
import { useSelectWhenCreated } from "./use-created-row";
import { useElapsedSec } from "./use-elapsed";

/** An edit to the running entry. Absent fields are left alone. */
export type RunningPatch = {
  description?: string;
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
  ) => Promise<boolean>;
  onStop: () => Promise<boolean>;
  /** Edits the entry that is running. The worker resolves which one that is. */
  onUpdateRunning: (patch: RunningPatch) => Promise<boolean>;
  onPinFavorite: (quick: QuickStart) => Promise<boolean>;
  onUnpinFavorite: (id: string) => Promise<boolean>;
  /** Resolves the idle span the worker parked while the popup was closed. */
  onAnswerIdle: (answer: IdleAnswer) => Promise<boolean>;
  /**
   * Pushes the in-popup settings screen.
   *
   * The cog is the popup's top-right button, and everything that used to hang
   * off the overflow menu — the API URL, signing out, the settings the web app
   * owns — now lives behind it. The menu is left with the two things the popup
   * genuinely cannot do: reports and the calendar, which need width.
   */
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
    projects.find((candidate) => candidate.id === projectId)
      ?.billableDefault ?? false
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
  onOpenEntries,
  onOpenSuggestions,
  onSearchDescriptions,
  onCreateClient,
  onCreateTag,
  onCreateProject,
  onCreateTask,
}: TrackerScreenProps): JSX.Element {
  const [description, setDescription] = useState("");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [billable, setBillable] = useState(false);
  const [busy, setBusy] = useState(false);

  /** True while {@link ProjectPicker} has its new-project panel open. */
  const [namingProject, setNamingProject] = useState(false);

  // While a start/stop is in flight this holds the timer the user just asked
  // for. `null` (the outer one) means "no override" — the inner `running` is
  // itself nullable, which is exactly the stopped case, so the two cannot be
  // collapsed into one nullable field.
  const [optimistic, setOptimistic] = useState<{ running: TimeEntry | null } | null>(
    null,
  );

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
      patchRunning({ projectId: updated.projectId });
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

  // A task made from the picker is the task this entry wants — see the hook.
  const createTask = useSelectWhenCreated(state.tasks, (task) => {
    selectTask(task.id);
  });

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
    setProjectId(suggestion.projectId);
    setTaskId(suggestion.taskId);
    setTagIds(suggestion.tagIds);
    setBillable(suggestion.billable);
    if (running === null) return;
    patchRunning({
      description: suggestion.description,
      projectId: suggestion.projectId,
      taskId: suggestion.taskId,
      tagIds: suggestion.tagIds,
      billable: suggestion.billable,
    });
  };

  /**
   * Start a favorite or a recent.
   *
   * Same call as the composer's own submit — `timer:start` with the fields
   * already chosen — so the worker's billable defaulting, offline queueing and
   * optimistic badge all apply unchanged. The only difference is that
   * `billable` is explicit, because a pin already decided it.
   */
  const startQuick = async (quick: QuickStart): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setOptimistic({
      running: provisionalEntry(
        quick.description,
        quick.projectId,
        quick.taskId,
        quick.billable,
        // Quick starts open untagged on purpose: tags ride alongside a
        // QuickStart rather than inside it, so one recurring combination does
        // not fragment into a recent per set of labels.
        [],
      ),
    });
    await onStart(
      quick.description,
      quick.projectId,
      quick.taskId,
      quick.billable,
    );
    setOptimistic(null);
    setBusy(false);
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

  const start = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setOptimistic({
      running: provisionalEntry(
        description.trim(),
        projectId,
        taskId,
        billable,
        tagIds,
      ),
    });

    // Explicit rather than omitted: the composer has a billable toggle now, so
    // the flag on screen is what the entry has to open with — letting the
    // server re-derive it from the project would ignore the toggle.
    await onStart(description.trim(), projectId, taskId, billable, tagIds);

    // Either way the override goes: on success the worker's snapshot is the
    // better truth, on failure dropping it reverts the UI to what is real. The
    // fields are not cleared here — they now show the running entry, and the
    // re-seed above keeps them in step with it.
    setOptimistic(null);
    setBusy(false);
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
    state.syncStatus,
    state.serverReachable,
    state.pendingSync,
  );

  // The same setting the entries list and the entry forms read, so a user who
  // asked for decimal is not shown two spellings of a duration at once.
  const durationFormat: DurationFormat = state.settings?.durationFormat ?? "hms";

  return (
    <div className="screen" data-testid="tracker-screen">
      {/* No back and no title: the elapsed clock below is the title, and that
          is exactly what pays for a header on the one screen where every pixel
          is already spoken for. */}
      <Header
        onOpenEntries={onOpenEntries}
        onOpenSettings={onOpenSettings}
        // Off by default, so by default the tracker looks exactly as it did.
        onOpenSuggestions={state.activity.settings.enabled ? onOpenSuggestions : undefined}
      />

      <div className="popup__body">
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

        {/* Hidden while a timer runs, where the row would only offer to stop
            this one and start another. */}
        {running === null ? (
          <QuickStartList
            items={state.quickStarts}
            disabled={busy}
            onStart={(quick) => {
              void startQuick(quick);
            }}
            onPin={(quick) => {
              void pin(quick);
            }}
            onUnpin={(id) => {
              void unpin(id);
            }}
          />
        ) : null}

        {/* One form for both states. The fields are the same either way — a
            draft's and a running entry's — so splitting them into two blocks
            would mean two places for every field to drift out of step. */}
        <form
          className="form"
          onSubmit={submit}
          data-testid={running === null ? "tracker-start-form" : "tracker-running"}
        >
          {running !== null ? (
            <span className="elapsed" data-testid="tracker-elapsed">
              {formatElapsed(elapsedSec, durationFormat)}
            </span>
          ) : null}

          <DescriptionField
            id="description"
            label="Description"
            value={description}
            // A draft has nothing settled behind it, so it compares against
            // itself: leaving an untouched field then writes nothing, and
            // Escape has nothing to restore it to.
            committed={running?.description ?? description}
            placeholder="What are you working on?"
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
            onPendingChange={setNamingProject}
            testId="tracker-project"
          />

          <Combobox
            label="Task"
            options={tasks.map((task) => ({ id: task.id, label: task.name }))}
            value={taskId}
            onChange={selectTask}
            emptyLabel="No task"
            placeholder="Search tasks…"
            onCreate={async (name) => {
              await createTask(name, () => onCreateTask(name));
            }}
            createLabel={(name) => `Create task “${name}”`}
            testId="tracker-task"
          />

          <TagPicker
            tags={state.tags}
            value={tagIds}
            onChange={selectTags}
            onCreate={onCreateTag}
            testId="tracker-tags"
          />

          <Switch
            checked={billable}
            onChange={toggleBillable}
            label={billable ? "Billable" : "Not billable"}
            variant="struck"
            testId="tracker-billable"
          />

          <button
            className={
              running === null
                ? "button button--primary button--block"
                : "button button--danger button--block"
            }
            type="submit"
            disabled={busy || namingProject}
            data-testid={running === null ? "tracker-start" : "tracker-stop"}
          >
            {running === null ? "Start" : "Stop"}
          </button>
        </form>

        <p className="today">
          <span>Today</span>
          <span className="today__value" data-testid="tracker-today">
            {formatDuration(todaySec, durationFormat)}
          </span>
        </p>

        <p className="notice" role="alert" aria-live="assertive" data-testid="tracker-error">
          {error ?? ""}
        </p>
      </div>

      <div className="footer">
        <div className="footer__row">
          <span className="footer__email" title={state.email ?? ""}>
            {state.email ?? "Signed in"}
          </span>
          <span className="status" data-testid="tracker-sync-status" title={sync.title}>
            <span className={`status__dot status__dot--${sync.tone}`} />
            {sync.label}
          </span>
          {/* Nothing to overflow into when the web app's origin has not been
              discovered — both remaining items are links to it. */}
          {state.webUrl !== null ? <Menu webUrl={state.webUrl} /> : null}
        </div>
      </div>
    </div>
  );
}
