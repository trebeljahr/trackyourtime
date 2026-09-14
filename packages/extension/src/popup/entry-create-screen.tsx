import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from "react";
import { deviceTimeZone, type DurationFormat } from "@starter/core";
import type { BackgroundState } from "../lib/messaging";
import { formatDurationFor, formatIdleSpanFor } from "../i18n/format";
import { usePopupLocale, useT } from "../i18n/use-t";
import { EntryForm } from "./entry-form";
import { Header } from "./header";
import { describeSync } from "./sync-label";
import type { EntryDraft } from "./route";

/**
 * Log a block of time that was never timed.
 *
 * The one screen in the popup with a submit button, and the exception proves
 * the per-field rule: `entries.create` needs both ends at once, so there is no
 * row to patch until they exist and nothing that could be committed field by
 * field. The button stays disabled until the range is valid, checked locally so
 * the user hears about it without a round trip.
 *
 * A manual create never opens a timer. An entry with an open end IS a running
 * timer, and `timer:start` is the only door to one — which is why `entry:create`
 * requires both ends and this form cannot clear either.
 */

export type EntryCreateScreenProps = {
  state: BackgroundState;
  /** The last failure, already translated into human terms. */
  error: string | null;
  note?: string | null;
  /** The draft lives on the route, so a stolen focus cannot take it. */
  draft: EntryDraft;
  onBack: () => void;
  onGoTracker: () => void;
  onDraftChange: (draft: EntryDraft) => void;
  onCreateEntry: (draft: EntryDraft) => Promise<boolean>;
  onSearchDescriptions: (query: string) => void;
  onCreateClient: (name: string) => Promise<boolean>;
  onCreateProject: (name: string, clientId: string | null) => Promise<boolean>;
  onCreateTag: (name: string) => Promise<boolean>;
  onCreateTask: (name: string) => Promise<boolean>;
  /**
   * Wording for the other screen that writes a new entry through this form —
   * accepting an edited activity suggestion. The form, the validation and the
   * submit rule are the same; only what the screen calls itself differs.
   */
  labels?: { title: string; submit: string; busy: string; testId: string };
};

export function EntryCreateScreen({
  state,
  error,
  note = null,
  draft,
  onBack,
  onGoTracker,
  onDraftChange,
  onCreateEntry,
  onSearchDescriptions,
  onCreateClient,
  onCreateProject,
  onCreateTag,
  onCreateTask,
  labels: givenLabels,
}: EntryCreateScreenProps): JSX.Element {
  const t = useT("popup");
  const locale = usePopupLocale();
  const labels = givenLabels ?? {
    title: t("entryNew.title"),
    submit: t("entryNew.add"),
    busy: t("entryNew.adding"),
    testId: "entry-new",
  };
  const [busy, setBusy] = useState(false);
  /** True while the project picker is naming a new project. */
  const [namingProject, setNamingProject] = useState(false);
  const alertRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (error === null) return;
    alertRef.current?.scrollIntoView({ block: "nearest" });
  }, [error]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    const target = event.target as HTMLElement;
    const tag = target.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea") return;
    if (target.getAttribute("role") === "combobox") return;
    event.preventDefault();
    onBack();
  };

  const sync = describeSync(
    t,
    state.syncStatus,
    state.serverReachable,
    state.pendingSync,
  );

  const durationFormat: DurationFormat = state.settings?.durationFormat ?? "hms";
  const seconds = Math.round(
    (Date.parse(draft.end) - Date.parse(draft.start)) / 1000,
  );
  const valid = seconds > 0;

  const submit = async (): Promise<void> => {
    if (busy || !valid) return;
    setBusy(true);
    // Navigation on success is the caller's: it owns the stack, and it is the
    // only thing that can pair leaving this screen with the note that says
    // what happened.
    await onCreateEntry(draft);
    setBusy(false);
  };

  return (
    <div className="screen" onKeyDown={onKeyDown} data-testid={`${labels.testId}-screen`}>
      <Header title={labels.title} onBack={onBack} sync={sync} />

      <div className="popup__body">
        <p
          ref={alertRef}
          className="notice screen__alert"
          role="alert"
          aria-live="assertive"
          data-testid={`${labels.testId}-error`}
        >
          {error ?? ""}
        </p>

        {note !== null ? (
          <p className="notice notice--ok" role="status">
            {note}
          </p>
        ) : null}

        {state.pendingIdle !== null ? (
          <button
            type="button"
            className="alert alert--idle"
            onClick={onGoTracker}
            data-testid="idle-alert"
          >
            {t("idle.alert", {
              span: formatIdleSpanFor(state.pendingIdle.idleSec, locale),
            })}
          </button>
        ) : null}

        <div className="detail">
          <EntryForm
            mode="create"
            state={state}
            values={draft}
            // A new entry is written in the clock of the device writing it —
            // there is no earlier recording whose zone it should inherit.
            zone={deviceTimeZone()}
            onChange={(next) => onDraftChange(next)}
            onSearchDescriptions={onSearchDescriptions}
            onNamingProject={setNamingProject}
            onCreateClient={onCreateClient}
            onCreateProject={onCreateProject}
            onCreateTag={onCreateTag}
            onCreateTask={onCreateTask}
          />

          <p className="detail__note" data-testid={`${labels.testId}-duration`}>
            {valid
              ? t("entryNew.duration", {
                  duration: formatDurationFor(seconds, locale, durationFormat),
                })
              : t("errors.badTimeRange")}
          </p>

          <button
            type="button"
            className="button button--primary button--block"
            disabled={busy || !valid || namingProject}
            onClick={() => {
              void submit();
            }}
            data-testid={`${labels.testId}-submit`}
          >
            {busy ? labels.busy : labels.submit}
          </button>
        </div>
      </div>
    </div>
  );
}
