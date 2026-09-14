import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from "react";
import {
  dayKeyInZone,
  deviceTimeZone,
  formatClockInZone,
  zonedDayStartMs,
  type DurationFormat,
  type TimeFormat,
} from "@starter/core";
import type {
  AcceptedFields,
  ActivityRule,
  ActivitySuggestion,
  BackgroundState,
} from "../lib/messaging";
import { DayStepper } from "./day-stepper";
import { Header } from "./header";
import { ProjectPicker } from "./project-picker";
import type { EntryDraft } from "./route";
import { describeSync } from "./sync-label";
import { formatDurationFor, formatIdleSpanFor, intlLocale } from "../i18n/format";
import { usePopupLocale, useT } from "../i18n/use-t";

/**
 * Time this browser saw you working that no entry covers yet, one day at a time.
 *
 * Every row is a proposal and nothing more: capture never creates an entry on
 * its own, and nothing captured leaves the device until somebody presses
 * Accept here. Accept files the block with whatever a local rule proposes;
 * Edit opens the same form a manual entry uses; Dismiss marks the span as
 * accounted for on this device; "Always file …" teaches this device a rule for
 * the block's busiest site.
 */

export type SuggestionsScreenProps = {
  state: BackgroundState;
  error: string | null;
  note?: string | null;
  /** The day on the route; null is today. */
  day: string | null;
  onBack: () => void;
  onGoTracker: () => void;
  onOpenActivitySettings: () => void;
  onChangeDay: (day: string | null) => void;
  onAccept: (suggestion: ActivitySuggestion, fields: AcceptedFields) => Promise<boolean>;
  onEdit: (draft: EntryDraft) => void;
  onDismiss: (suggestion: ActivitySuggestion) => Promise<boolean>;
  onAddRule: (pattern: string, projectId: string | null) => Promise<boolean>;
  onRemoveRule: (id: string) => Promise<boolean>;
  onCreateClient: (name: string) => Promise<boolean>;
  onCreateProject: (name: string, clientId: string | null) => Promise<boolean>;
};

/** What a suggestion would be filed with if accepted as it stands. */
export const acceptedFieldsOf = (suggestion: ActivitySuggestion): AcceptedFields => ({
  description: suggestion.proposed.description ?? "",
  projectId: suggestion.proposed.projectId ?? null,
  taskId: suggestion.proposed.taskId ?? null,
  ...(suggestion.proposed.billable !== undefined ? { billable: suggestion.proposed.billable } : {}),
  ...(suggestion.proposed.tagIds !== undefined ? { tagIds: suggestion.proposed.tagIds } : {}),
});

/** The suggestion as a draft for the entry form. */
export const draftOf = (
  suggestion: ActivitySuggestion,
  billableDefault: boolean,
): EntryDraft => {
  const fields = acceptedFieldsOf(suggestion);
  return {
    description: fields.description,
    projectId: fields.projectId,
    taskId: fields.taskId,
    billable: fields.billable ?? billableDefault,
    tagIds: fields.tagIds ?? [],
    start: new Date(suggestion.start).toISOString(),
    end: new Date(suggestion.end).toISOString(),
  };
};

/** "42%", "42 %" — whatever the popup's language writes. */
const percent = (share: number, locale: string): string =>
  new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(share);

type RowProps = {
  suggestion: ActivitySuggestion;
  state: BackgroundState;
  busy: boolean;
  zone: string;
  timeFormat: TimeFormat;
  durationFormat: DurationFormat;
  onRun: (action: () => Promise<boolean>) => Promise<boolean>;
  props: SuggestionsScreenProps;
};

function SuggestionRow({
  suggestion,
  state,
  busy,
  zone,
  timeFormat,
  durationFormat,
  onRun,
  props,
}: RowProps): JSX.Element {
  const t = useT("popup");
  const locale = usePopupLocale();
  const [filing, setFiling] = useState(false);
  const [ruleProject, setRuleProject] = useState<string | null>(
    suggestion.proposed.projectId ?? null,
  );
  const [naming, setNaming] = useState(false);

  const topKey = suggestion.topKeys[0]?.key ?? "";
  const range = `${formatClockInZone(new Date(suggestion.start).toISOString(), zone, timeFormat)}–${formatClockInZone(new Date(suggestion.end).toISOString(), zone, timeFormat)}`;
  const seconds = Math.round((suggestion.end - suggestion.start) / 1000);
  const project =
    suggestion.proposed.projectId === undefined || suggestion.proposed.projectId === null
      ? null
      : (state.projects.find((it) => it.id === suggestion.proposed.projectId) ?? null);
  const billableDefault = project?.billableDefault ?? false;

  return (
    <li className="activity__item" data-testid="suggestion-row">
      <div className="activity__head">
        <span className="activity__range" data-testid="suggestion-range">
          {range}
        </span>
        <span className="activity__duration">
          {formatDurationFor(seconds, locale, durationFormat)}
        </span>
      </div>

      <p className="activity__keys" data-testid="suggestion-hosts">
        {suggestion.topKeys
          .slice(0, 3)
          .map((key) => `${key.key} ${percent(key.share, intlLocale(locale))}`)
          .join(" · ")}
      </p>

      <p className="activity__proposal" data-testid="suggestion-proposal">
        {project !== null
          ? t("suggestions.filesUnder", { project: project.name })
          : suggestion.ruleId !== undefined
            ? t("suggestions.filedByRule")
            : t("fields.noProject")}
        {suggestion.proposed.description ? ` · “${suggestion.proposed.description}”` : ""}
      </p>

      <div className="activity__actions">
        <button
          type="button"
          className="button button--primary"
          disabled={busy}
          onClick={() => {
            void onRun(() => props.onAccept(suggestion, acceptedFieldsOf(suggestion)));
          }}
          data-testid="suggestion-accept"
        >
          {t("suggestions.accept")}
        </button>
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={() => props.onEdit(draftOf(suggestion, billableDefault))}
          data-testid="suggestion-edit"
        >
          {t("suggestions.edit")}
        </button>
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={() => {
            void onRun(() => props.onDismiss(suggestion));
          }}
          data-testid="suggestion-dismiss"
        >
          {t("suggestions.dismiss")}
        </button>
      </div>

      {topKey !== "" ? (
        filing ? (
          <div className="panel" data-testid="suggestion-rule-panel">
            <p className="panel__title">{t("suggestions.alwaysFile", { site: topKey })}</p>
            <ProjectPicker
              projects={state.projects}
              clients={state.clients}
              value={ruleProject}
              onChange={setRuleProject}
              busy={busy}
              onCreateClient={props.onCreateClient}
              onCreateProject={props.onCreateProject}
              onPendingChange={setNaming}
              testId="suggestion-rule-project"
            />
            <div className="panel__actions">
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => setFiling(false)}
              >
                {t("actions.cancel")}
              </button>
              <button
                type="button"
                className="button button--primary"
                disabled={busy || naming}
                onClick={() => {
                  void onRun(() => props.onAddRule(topKey, ruleProject)).then((ok) => {
                    if (ok) setFiling(false);
                  });
                }}
                data-testid="suggestion-rule-save"
              >
                {t("suggestions.saveRule")}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="button button--block"
            disabled={busy}
            onClick={() => setFiling(true)}
            data-testid="suggestion-rule-open"
          >
            {t("suggestions.alwaysFileOpen", { site: topKey })}
          </button>
        )
      ) : null}
    </li>
  );
}

function RuleList({
  rules,
  state,
  busy,
  onRun,
  onRemoveRule,
}: {
  rules: ActivityRule[];
  state: BackgroundState;
  busy: boolean;
  onRun: (action: () => Promise<boolean>) => Promise<boolean>;
  onRemoveRule: (id: string) => Promise<boolean>;
}): JSX.Element | null {
  const t = useT("popup");
  if (rules.length === 0) return null;
  return (
    <section className="activity__rules" data-testid="activity-rules">
      <p className="field__label">{t("suggestions.rules")}</p>
      {rules.map((rule) => {
        const project =
          rule.projectId === undefined || rule.projectId === null
            ? null
            : (state.projects.find((it) => it.id === rule.projectId) ?? null);
        return (
          <div className="device" key={rule.id} data-testid="activity-rule">
            <div className="device__text">
              <span className="device__name">{rule.pattern}</span>
              <span className="device__hint">{project?.name ?? t("fields.noProject")}</span>
            </div>
            <button
              type="button"
              className="button device__action"
              disabled={busy}
              onClick={() => {
                void onRun(() => onRemoveRule(rule.id));
              }}
              data-testid={`activity-rule-remove-${rule.id}`}
            >
              {t("suggestions.remove")}
            </button>
          </div>
        );
      })}
    </section>
  );
}

export function SuggestionsScreen(props: SuggestionsScreenProps): JSX.Element {
  const { state, error, note = null, day, onBack, onGoTracker, onOpenActivitySettings, onChangeDay } =
    props;
  const t = useT("popup");
  const locale = usePopupLocale();
  const [busy, setBusy] = useState(false);
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

  const run = async (action: () => Promise<boolean>): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    const ok = await action();
    setBusy(false);
    return ok;
  };

  const zone = deviceTimeZone();
  const todayKey = dayKeyInZone(Date.now(), zone);
  const shownDay = day ?? todayKey;
  // Noon, not midnight: the stepper derives the day from an instant, and a
  // day start is one DST hour away from being read as the day before.
  const dayInstant = new Date(zonedDayStartMs(shownDay, zone) + 12 * 3_600_000).toISOString();

  const { activity } = state;
  const timeFormat: TimeFormat = state.settings?.timeFormat ?? "24h";
  const durationFormat: DurationFormat = state.settings?.durationFormat ?? "hms";
  // The snapshot can describe the day the popup was on a moment ago.
  const current = activity.day === shownDay ? activity.suggestions : null;

  const sync = describeSync(t, state.syncStatus, state.serverReachable, state.pendingSync);

  return (
    <div className="screen" onKeyDown={onKeyDown} data-testid="suggestions-screen">
      <Header title={t("suggestions.title")} onBack={onBack} sync={sync} />

      <div className="popup__body">
        <p
          ref={alertRef}
          className="notice screen__alert"
          role="alert"
          aria-live="assertive"
          data-testid="suggestions-error"
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
            {t("idle.alert", { span: formatIdleSpanFor(state.pendingIdle.idleSec, locale) })}
          </button>
        ) : null}

        {!activity.settings.enabled || !activity.permitted ? (
          <div className="activity__off" data-testid="suggestions-off">
            <p>{t("suggestions.off")}</p>
            <button
              type="button"
              className="button button--primary button--block"
              onClick={onOpenActivitySettings}
              data-testid="suggestions-open-settings"
            >
              {t("suggestions.openSettings")}
            </button>
          </div>
        ) : null}

        <DayStepper
          value={dayInstant}
          zone={zone}
          onChange={(next) => onChangeDay(next >= todayKey ? null : next)}
          disabled={busy}
          testId="suggestions-day"
        />

        {current === null ? (
          <p className="loading" data-testid="suggestions-loading">
            {t("app.loading")}
          </p>
        ) : current.length === 0 ? (
          <p className="entries__empty" data-testid="suggestions-empty">
            {t("suggestions.empty")}
          </p>
        ) : (
          <ul className="activity" data-testid="suggestions-list">
            {current.map((suggestion) => (
              <SuggestionRow
                key={`${suggestion.start}-${suggestion.end}`}
                suggestion={suggestion}
                state={state}
                busy={busy}
                zone={zone}
                timeFormat={timeFormat}
                durationFormat={durationFormat}
                onRun={run}
                props={props}
              />
            ))}
          </ul>
        )}

        <RuleList
          rules={activity.rules ?? []}
          state={state}
          busy={busy}
          onRun={run}
          onRemoveRule={props.onRemoveRule}
        />
      </div>
    </div>
  );
}
