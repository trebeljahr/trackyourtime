"use client";

import * as React from "react";
import type { DesktopActivitySuggestion } from "@starter/shared";

import { Button } from "@/components/ui/button";
import { useFormat } from "@/i18n/use-format";
import { useT } from "@/i18n/use-t";
import { useFormatSettings } from "@/lib/format";

export type SuggestionCardProps = {
  suggestion: DesktopActivitySuggestion;
  /** The proposed project's name, when the suggestion proposes one the catalog knows. */
  projectName: string | null;
  busy: boolean;
  onAdd: () => void;
  onEdit: () => void;
  onDismiss: () => void;
  onAlwaysFile: () => void;
};

/**
 * One block of untracked activity: when, how long, which apps, and what it
 * would be filed as. Display only — every action is the screen's.
 */
export function SuggestionCard({
  suggestion,
  projectName,
  busy,
  onAdd,
  onEdit,
  onDismiss,
  onAlwaysFile,
}: SuggestionCardProps): React.JSX.Element {
  const t = useT("activity");
  const format = useFormat();
  const { clock, duration } = useFormatSettings();

  const seconds = Math.round((suggestion.end - suggestion.start) / 1000);
  const range = `${clock(new Date(suggestion.start).toISOString())}–${clock(new Date(suggestion.end).toISOString())}`;
  const top = suggestion.topApps[0] ?? null;
  const description = suggestion.proposed.description?.trim() ?? "";
  const proposal =
    projectName !== null
      ? t("card.filesUnder", { project: projectName })
      : suggestion.ruleId !== undefined
        ? t("card.filedByRule")
        : t("card.noProject");

  return (
    <li
      className="space-y-3 rounded-lg border border-border bg-card p-4"
      data-testid="activity-suggestion"
      data-start={suggestion.start}
      data-end={suggestion.end}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-medium tabular-nums" data-testid="activity-suggestion-range">
          {range}
        </span>
        <span
          className="font-mono text-sm tabular-nums text-muted-foreground"
          data-testid="activity-suggestion-duration"
        >
          {duration(seconds)}
        </span>
      </div>

      <p className="text-sm" data-testid="activity-suggestion-apps">
        {suggestion.topApps
          .map((app) => t("card.appShare", { app: app.name, share: format.percent(app.share) }))
          .join(" · ")}
      </p>

      {suggestion.titles.length > 0 ? (
        <ul className="space-y-0.5 text-xs text-muted-foreground" data-testid="activity-suggestion-titles">
          {suggestion.titles.map((title) => (
            <li key={title} className="truncate">
              {title}
            </li>
          ))}
        </ul>
      ) : null}

      <p className="text-sm text-muted-foreground" data-testid="activity-suggestion-proposal">
        {proposal}
        {description !== "" ? ` · “${description}”` : ""}
      </p>

      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={onAdd} disabled={busy} data-testid="activity-suggestion-add">
          {t("actions.add")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onEdit}
          disabled={busy}
          data-testid="activity-suggestion-edit"
        >
          {t("actions.editAndAdd")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={onDismiss}
          disabled={busy}
          data-testid="activity-suggestion-dismiss"
        >
          {t("actions.dismiss")}
        </Button>
        {top !== null ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={onAlwaysFile}
            disabled={busy}
            data-testid="activity-suggestion-rule"
          >
            {t("actions.alwaysFile", { app: top.name })}
          </Button>
        ) : null}
      </div>
    </li>
  );
}
