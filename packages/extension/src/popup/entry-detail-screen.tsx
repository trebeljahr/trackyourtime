import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from "react";
import {
  dayKeyInZone,
  deviceTimeZone,
  isTempId,
  type DetailedEntry,
  type DurationFormat,
} from "@starter/core";
import type { BackgroundState } from "../lib/messaging";
import { formatDurationFor, formatIdleSpanFor } from "../i18n/format";
import { usePopupLocale, useT } from "../i18n/use-t";
import { ConfirmPanel } from "./confirm-panel";
import { entryDayLabel, entrySubtitle, entryZone } from "./entry-format";
import { EntryForm, type EntryFieldPatch } from "./entry-form";
import { Header } from "./header";
import { describeSync } from "./sync-label";
import type { EntryDraft } from "./route";

/**
 * One past entry, editable field by field.
 *
 * There is no Save button, and that is not a shortcut. The popup is destroyed
 * on focus loss, so a Save button means a form full of corrections can
 * evaporate with no warning; and per-field commits are the only shape that is
 * safe against an invoiced entry, which `entries.update` refuses on the mere
 * presence of `projectId`, `taskId`, `billable`, `start` or `end` — so a form
 * that saved its whole shape at once could not edit the description of an
 * invoiced row at all.
 *
 * Deletion is the exception: it is confirmed, and it IS gated on the round
 * trip, because a second press while the first is in flight would ask the
 * server to delete a row that is already gone.
 */

export type EntryDetailScreenProps = {
  state: BackgroundState;
  /** The last failure, already translated into human terms. */
  error: string | null;
  note?: string | null;
  /** Which row this screen is about. The row itself comes from the snapshot. */
  id: string;
  onBack: () => void;
  onGoTracker: () => void;
  onUpdateEntry: (id: string, patch: EntryFieldPatch) => Promise<boolean>;
  onDeleteEntry: (id: string) => Promise<boolean>;
  onSearchDescriptions: (query: string) => void;
  onCreateClient: (name: string) => Promise<boolean>;
  onCreateProject: (name: string, clientId: string | null) => Promise<boolean>;
  onCreateTag: (name: string) => Promise<boolean>;
  onCreateTask: (name: string) => Promise<boolean>;
  /** The window has loaded and no longer holds this id — deleted elsewhere. */
  onMissing: () => void;
};

const draftFrom = (entry: DetailedEntry): EntryDraft => ({
  description: entry.description,
  projectId: entry.projectId,
  taskId: entry.taskId,
  billable: entry.billable,
  tagIds: entry.tagIds,
  start: entry.start,
  // An open end means a running entry, which never reaches this screen — the
  // worker filters it out of the window. Falling back to the start keeps the
  // form total rather than making every field nullable for a case that cannot
  // happen.
  end: entry.end ?? entry.start,
});

export function EntryDetailScreen({
  state,
  error,
  note = null,
  id,
  onBack,
  onGoTracker,
  onUpdateEntry,
  onDeleteEntry,
  onSearchDescriptions,
  onCreateClient,
  onCreateProject,
  onCreateTag,
  onCreateTask,
  onMissing,
}: EntryDetailScreenProps): JSX.Element {
  const t = useT("popup");
  const locale = usePopupLocale();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const alertRef = useRef<HTMLParagraphElement>(null);

  const page = state.entries;
  const entry = page?.entries.find((candidate) => candidate.id === id) ?? null;

  /**
   * The fields on screen, seeded from the row and re-seeded ONLY when the
   * route's id changes.
   *
   * Keying on `updatedAt` instead would re-seed after the user's own commit
   * and stomp a second field mid-typing. The cost is that a foreign edit made
   * while this screen is open is not picked up until you leave and come back —
   * the same trade the tracker already makes with the running entry.
   */
  const [values, setValues] = useState<EntryDraft | null>(null);
  const [seededId, setSeededId] = useState<string | null>(null);
  if (entry !== null && seededId !== id) {
    setSeededId(id);
    setValues(draftFrom(entry));
  }

  useEffect(() => {
    if (error === null) return;
    alertRef.current?.scrollIntoView({ block: "nearest" });
  }, [error]);

  // Only once the window has actually loaded: an id that is merely not fetched
  // yet is a loading state, not a missing row.
  useEffect(() => {
    if (page === null) return;
    if (page.entries.some((candidate) => candidate.id === id)) return;
    onMissing();
  }, [page, id, onMissing]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    const target = event.target as HTMLElement;
    const tag = target.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea") return;
    if (target.getAttribute("role") === "combobox") return;
    event.preventDefault();
    if (confirming) {
      setConfirming(false);
      return;
    }
    onBack();
  };

  const sync = describeSync(
    t,
    state.syncStatus,
    state.serverReachable,
    state.pendingSync,
  );

  const durationFormat: DurationFormat = state.settings?.durationFormat ?? "hms";
  const zone = entry === null ? deviceTimeZone() : entryZone(entry);
  const title =
    entry === null
      ? t("entryDetail.title")
      : entryDayLabel(
          dayKeyInZone(Date.parse(entry.start), zone),
          dayKeyInZone(Date.now(), deviceTimeZone()),
          t,
          locale,
        );

  // A row that only exists as a queued `entries.create` cannot be edited: an
  // update naming its temp id would be refused on replay and the edit lost.
  const queued =
    entry !== null && (isTempId(entry.id) || page?.pendingIds.includes(entry.id) === true);
  const invoiced = entry !== null && entry.invoiceId !== null;

  const commit = (next: EntryDraft, patch: EntryFieldPatch): void => {
    setValues(next);
    if (Object.keys(patch).length === 0) return;
    // Deliberately not awaited and not gated on `busy`, the same rule the
    // tracker applies to a running entry: labelling as you go must not block
    // on a round trip, or the second correction feels broken.
    void onUpdateEntry(id, patch);
  };

  const remove = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    await onDeleteEntry(id);
    setBusy(false);
  };

  return (
    <div className="screen" onKeyDown={onKeyDown} data-testid="entry-screen">
      <Header title={title} onBack={onBack} sync={sync} />

      <div className="popup__body">
        <p
          ref={alertRef}
          className="notice screen__alert"
          role="alert"
          aria-live="assertive"
          data-testid="entry-error"
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

        {entry === null || values === null ? (
          <p className="loading" data-testid="entry-loading">
            {t("app.loading")}
          </p>
        ) : (
          <div className="detail">
            {queued ? (
              <p className="detail__locked" data-testid="entry-queued">
                {t("entryDetail.queued")}
              </p>
            ) : null}

            {invoiced ? (
              <p className="detail__locked" data-testid="entry-invoiced">
                {t("entryDetail.invoiced")}
              </p>
            ) : null}

            <EntryForm
              mode="edit"
              state={state}
              values={values}
              zone={zone}
              locked={invoiced}
              readOnly={queued}
              onChange={commit}
                onSearchDescriptions={onSearchDescriptions}
                onCreateClient={onCreateClient}
                onCreateProject={onCreateProject}
                onCreateTag={onCreateTag}
                onCreateTask={onCreateTask}
            />

            {confirming ? (
              <ConfirmPanel
                title={t("entryDetail.deleteTitle")}
                hint={t("entryDetail.deleteHint", {
                  duration: formatDurationFor(entry.durationSec, locale, durationFormat),
                  day: title,
                  subtitle: entrySubtitle(entry, t),
                })}
                confirmLabel={t("actions.delete")}
                danger
                busy={busy}
                onConfirm={() => {
                  void remove();
                }}
                onCancel={() => setConfirming(false)}
                testId="entry-delete-confirm"
              />
            ) : invoiced ? (
              /* The server refuses it, so offering the button would only be a
                 way to be told no. */
              <p className="detail__note">{t("entryDetail.cannotDelete")}</p>
            ) : (
              <div className="detail__actions">
                {/* Enabled even while queued, unlike every field above it: a
                    row that exists only as a queued `entries.create` is deleted
                    by dropping that mutation, which is the one way to take back
                    something logged offline before it is ever sent. */}
                <button
                  type="button"
                  className="button button--danger"
                  disabled={busy}
                  onClick={() => setConfirming(true)}
                  data-testid="entry-delete"
                >
                  {t("entryDetail.deleteEntry")}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
