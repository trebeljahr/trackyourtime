"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, Sparkles, Trash2 } from "lucide-react";
import { deviceTimeZone, type EntryFields } from "@starter/core";
import {
  addDaysToKey,
  dayKeyInZone,
  zonedDayStartMs,
  type DesktopActivity,
  type DesktopActivitySnapshot,
  type DesktopActivitySuggestion,
} from "@starter/shared";

import {
  acceptSuggestion,
  type AcceptFields,
  type AcceptOutcome,
  type KnownCatalog,
} from "@/components/activity/accept-suggestion";
import { ActivityRuleDialog } from "@/components/activity/activity-rule-dialog";
import { SuggestionCard } from "@/components/activity/suggestion-card";
import { useActivitySuggestions } from "@/components/activity/use-activity-suggestions";
import { useDesktopActivitySnapshot } from "@/components/activity/use-desktop-activity";
import { EmptyState } from "@/components/empty-state";
import { TAG_LIST_INPUT } from "@/components/tags/use-tags";
import { ManualEntryDialog, type ManualEntrySeed } from "@/components/tracker/manual-entry-dialog";
import { useEntryMutations, type ManualEntryArgs } from "@/components/tracker/use-entry-mutations";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useIsElectron } from "@/hooks/use-shell";
import { useFormat } from "@/i18n/use-format";
import type { Translator } from "@/i18n/translator";
import { useT } from "@/i18n/use-t";
import { getActiveWorkspaceId } from "@/lib/active-workspace";
import { desktopActivity } from "@/lib/desktop-activity";
import { trpc } from "@/lib/trpc";

/**
 * `/app/activity` — the desktop app's activity suggestions, one day at a time.
 *
 * Every card is a proposal and nothing more: capture never creates an entry
 * on its own, and nothing recorded leaves the computer until somebody presses
 * Add here. Main composes the cards from what it recorded minus what is
 * tracked (`use-activity-suggestions.ts`); raw activity never reaches this
 * renderer.
 *
 * The prerendered page — and the page in a browser — is a notice pointing at
 * the desktop app and the extension. The desktop UI replaces it after
 * hydration (`useIsElectron`), so the served HTML and the hydrated tree always
 * agree.
 */
export function SuggestionsScreen(): React.JSX.Element {
  const t = useT("activity");
  const electron = useIsElectron();
  // Resolved after mount too: a desktop build whose preload predates the
  // activity bridge gets the web's notice rather than a dead screen.
  const activity = React.useMemo(() => (electron ? desktopActivity() : null), [electron]);

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6" data-testid="activity-page">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold">{t("page.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("page.description")}</p>
      </header>
      {activity === null ? <WebNotice /> : <DesktopSuggestions activity={activity} />}
    </div>
  );
}

function WebNotice(): React.JSX.Element {
  const t = useT("activity");
  return (
    <EmptyState
      icon={Sparkles}
      title={t("web.title")}
      description={t("web.body")}
      action={
        <div className="flex flex-wrap justify-center gap-2">
          <Button asChild>
            <Link href="/download/" data-testid="activity-web-download">
              {t("web.download")}
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/extension/" data-testid="activity-web-extension">
              {t("web.extension")}
            </Link>
          </Button>
        </div>
      }
      testId="activity-web-notice"
    />
  );
}

/** Why nothing (new) is being recorded, or null while it is. */
const statusOf = (
  snapshot: DesktopActivitySnapshot,
): "unavailable" | "off" | "noScope" | null => {
  if (!snapshot.support.supported) return "unavailable";
  if (!snapshot.settings.enabled) return "off";
  if (!snapshot.scoped) return "noScope";
  return null;
};

/** What an accept files by default: the suggestion's proposal as it stands. */
export const acceptFieldsOf = (suggestion: DesktopActivitySuggestion): AcceptFields => ({
  description: suggestion.proposed.description ?? "",
  projectId: suggestion.proposed.projectId ?? null,
  taskId: suggestion.proposed.taskId ?? null,
  tagIds: suggestion.proposed.tagIds ?? [],
  ...(suggestion.proposed.billable !== undefined ? { billable: suggestion.proposed.billable } : {}),
});

/**
 * Whether "Edit & add" changed the block's times, to the minute (the form's
 * time fields hold minutes). Only then is the accept an edited one, which keeps
 * the person's times; an edit of the project or the description alone is
 * still a plain accept and is clipped to what is untracked NOW — otherwise
 * time tracked since the card was drawn would be filed a second time.
 */
export const timesEdited = (
  suggestion: Pick<DesktopActivitySuggestion, "start" | "end">,
  args: Pick<ManualEntryArgs, "start" | "end">,
): boolean => {
  const minute = 60_000;
  const moved = (was: number, now: string): boolean => {
    const parsed = Date.parse(now);
    return !Number.isFinite(parsed) || Math.floor(parsed / minute) !== Math.floor(was / minute);
  };
  return moved(suggestion.start, args.start) || moved(suggestion.end, args.end);
};

/** The toast for an accept that created nothing. */
const refusalMessage = (
  reason: Exclude<AcceptOutcome, { ok: true }>["reason"],
  t: Translator<"activity">,
): string => {
  switch (reason) {
    case "already-tracked":
      return t("toasts.alreadyTracked");
    case "workspace-changed":
      return t("toasts.workspaceChanged");
    default:
      return t("toasts.addFailed");
  }
};

function DesktopSuggestions({ activity }: { activity: DesktopActivity }): React.JSX.Element {
  const t = useT("activity");
  const format = useFormat();
  const snapshot = useDesktopActivitySnapshot();
  const mutations = useEntryMutations();
  const zone = deviceTimeZone();

  // `?day=YYYY-MM-DD`, read from `location` in an effect: `useSearchParams`
  // would force a Suspense boundary under the static export.
  const [day, setDay] = React.useState<string | null>(null);
  React.useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("day");
    // After mount by necessity, per the note above: `useSearchParams` would
    // force a Suspense boundary under the static export.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (requested !== null && /^\d{4}-\d{2}-\d{2}$/.test(requested)) setDay(requested);
  }, []);
  // Reads the clock during render, deliberately: "which day is it now" is the
  // fallback when `?day=` names none, and freezing it at mount would leave the
  // screen on yesterday across midnight. No hydration concern — this subtree
  // only renders once `window.electronAPI` has answered, which never happens
  // during the prerender.
  // eslint-disable-next-line react-hooks/purity
  const today = dayKeyInZone(Date.now(), zone);
  const shownDay = day ?? today;
  const range = React.useMemo(
    () => ({
      start: zonedDayStartMs(shownDay, zone),
      end: zonedDayStartMs(addDaysToKey(shownDay, 1), zone),
    }),
    [shownDay, zone],
  );
  const { suggestions, loaded, failed, refresh, trackedBetween } = useActivitySuggestions(activity, range);

  const projects = trpc.projects.list.useQuery({});
  const tasks = trpc.tasks.list.useQuery({});
  const tags = trpc.tags.list.useQuery(TAG_LIST_INPUT);
  const catalog = React.useMemo<KnownCatalog>(
    () => ({
      projects:
        projects.data === undefined
          ? null
          : new Map(projects.data.map((project) => [project.id, { billableDefault: project.billableDefault }])),
      tasks: tasks.data === undefined ? null : new Set(tasks.data.map((task) => task.id)),
      tags: tags.data === undefined ? null : new Set(tags.data.map((tag) => tag.id)),
    }),
    [projects.data, tasks.data, tags.data],
  );
  // Behind a ref so `accept` keeps one identity while the catalog queries
  // settle; written from an effect, never during render, since the only
  // reader is the async accept path.
  const catalogRef = React.useRef<KnownCatalog>(catalog);
  React.useEffect(() => {
    catalogRef.current = catalog;
  }, [catalog]);
  const projectName = (id: string | null | undefined): string | null =>
    id === null || id === undefined ? null : (projects.data?.find((project) => project.id === id)?.name ?? null);

  const [busy, setBusy] = React.useState(false);
  const [editing, setEditing] = React.useState<DesktopActivitySuggestion | null>(null);
  const [ruleFor, setRuleFor] = React.useState<DesktopActivitySuggestion | null>(null);

  const accept = React.useCallback(
    async (start: number, end: number, edited: boolean, fields: AcceptFields): Promise<void> => {
      setBusy(true);
      try {
        const outcome = await acceptSuggestion(
          { start, end, edited, fields },
          {
            activity,
            workspaceId: getActiveWorkspaceId,
            tracked: trackedBetween,
            catalog: () => catalogRef.current,
            createManualEntry: mutations.createManualEntry,
            now: Date.now,
          },
        );
        if (outcome.ok) toast.success(t("toasts.added"));
        else toast.info(refusalMessage(outcome.reason, t));
      } catch {
        toast.error(t("toasts.addFailed"));
      } finally {
        setBusy(false);
        await refresh({ fresh: true });
      }
    },
    [activity, mutations.createManualEntry, refresh, t, trackedBetween],
  );

  const dismiss = React.useCallback(
    async (suggestion: DesktopActivitySuggestion): Promise<void> => {
      setBusy(true);
      try {
        const done = await activity.dismiss({ start: suggestion.start, end: suggestion.end });
        if (!done) toast.error(t("toasts.dismissFailed"));
      } catch {
        toast.error(t("toasts.dismissFailed"));
      } finally {
        setBusy(false);
        await refresh();
      }
    },
    [activity, refresh, t],
  );

  const saveRule = React.useCallback(
    async (pattern: string, fields: EntryFields): Promise<boolean> => {
      try {
        await activity.addRule({
          pattern,
          ...(fields.description.trim() !== "" ? { description: fields.description.trim() } : {}),
          projectId: fields.projectId,
          taskId: fields.taskId,
          tagIds: fields.tagIds,
          billable: fields.billable,
        });
        await refresh();
        return true;
      } catch {
        toast.error(t("toasts.ruleFailed"));
        return false;
      }
    },
    [activity, refresh, t],
  );

  const removeRule = React.useCallback(
    async (id: string): Promise<void> => {
      await activity.removeRule(id).catch(() => undefined);
      await refresh();
    },
    [activity, refresh],
  );

  const status = snapshot === null ? null : statusOf(snapshot);
  const appName = (pattern: string): string =>
    snapshot?.recentApps.find((app) => app.key === pattern)?.name ?? pattern;

  const editSeed: ManualEntrySeed | null =
    editing === null
      ? null
      : (() => {
          const fields = acceptFieldsOf(editing);
          const projectDefault =
            fields.projectId === null
              ? false
              : (projects.data?.find((project) => project.id === fields.projectId)?.billableDefault ?? false);
          return { ...fields, billable: fields.billable ?? projectDefault };
        })();

  const ruleSeed: EntryFields = (() => {
    if (ruleFor === null) return { description: "", projectId: null, taskId: null, billable: false, tagIds: [] };
    const fields = acceptFieldsOf(ruleFor);
    return { ...fields, billable: fields.billable ?? false };
  })();

  return (
    <div className="space-y-6" data-testid="activity-screen">
      {status !== null ? (
        <div
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm"
          data-testid="activity-status"
          data-status={status}
        >
          <span>{t(`status.${status}`)}</span>
          {status === "off" ? (
            <Button asChild size="sm" variant="outline">
              <Link href="/app/settings?tab=desktop" data-testid="activity-open-settings">
                {t("status.openSettings")}
              </Link>
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="flex items-center gap-2" data-testid="activity-day">
        <Button
          type="button"
          size="icon"
          variant="outline"
          aria-label={t("day.previous")}
          onClick={() => setDay(addDaysToKey(shownDay, -1))}
          data-testid="activity-day-previous"
        >
          <ChevronLeft className="size-4" />
        </Button>
        <span className="min-w-40 text-center font-medium" data-testid="activity-day-label">
          {format.date(range.start + 12 * 60 * 60 * 1000, "dayLabel")}
        </span>
        <Button
          type="button"
          size="icon"
          variant="outline"
          aria-label={t("day.next")}
          disabled={shownDay >= today}
          onClick={() => setDay(addDaysToKey(shownDay, 1))}
          data-testid="activity-day-next"
        >
          <ChevronRight className="size-4" />
        </Button>
        {shownDay !== today ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => setDay(null)} data-testid="activity-day-today">
            {t("day.today")}
          </Button>
        ) : null}
      </div>

      {failed ? (
        <p className="text-sm text-destructive" data-testid="activity-refresh-failed">
          {t("refreshFailed")}
        </p>
      ) : null}

      {!loaded ? (
        <div className="space-y-3" data-testid="activity-loading" aria-label={t("loading")}>
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      ) : suggestions === null ? (
        <p className="text-sm text-muted-foreground" data-testid="activity-unavailable">
          {snapshot !== null && !snapshot.scoped ? t("status.noScope") : t("status.locked")}
        </p>
      ) : suggestions.length === 0 ? (
        <EmptyState icon={Sparkles} title={t("empty")} testId="activity-empty" />
      ) : (
        <ul className="space-y-3" data-testid="activity-suggestions">
          {suggestions.map((suggestion) => (
            <SuggestionCard
              key={`${suggestion.start}:${suggestion.end}`}
              suggestion={suggestion}
              projectName={projectName(suggestion.proposed.projectId)}
              busy={busy}
              onAdd={() =>
                void accept(suggestion.start, suggestion.end, false, acceptFieldsOf(suggestion))
              }
              onEdit={() => setEditing(suggestion)}
              onDismiss={() => void dismiss(suggestion)}
              onAlwaysFile={() => setRuleFor(suggestion)}
            />
          ))}
        </ul>
      )}

      {snapshot !== null && snapshot.rules.length > 0 ? (
        <section className="space-y-2" data-testid="activity-rules">
          <h2 className="text-sm font-medium text-muted-foreground">{t("rules.heading")}</h2>
          <ul className="divide-y divide-border rounded-lg border border-border">
            {snapshot.rules.map((rule) => (
              <li
                key={rule.id}
                className="flex items-center justify-between gap-2 px-4 py-2 text-sm"
                data-testid="activity-rule"
              >
                <span className="min-w-0 truncate">
                  {appName(rule.pattern)}
                  {" → "}
                  {projectName(rule.projectId) ?? rule.description ?? t("card.noProject")}
                </span>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label={t("rules.remove", { app: appName(rule.pattern) })}
                  onClick={() => void removeRule(rule.id)}
                  data-testid="activity-rule-remove"
                >
                  <Trash2 className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <ManualEntryDialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        seed={editSeed ?? { description: "", projectId: null, taskId: null, billable: false, tagIds: [] }}
        range={
          editing === null
            ? undefined
            : { start: new Date(editing.start).toISOString(), end: new Date(editing.end).toISOString() }
        }
        mutations={mutations}
        onAdd={(args: ManualEntryArgs) => {
          if (editing === null) return;
          const edited = timesEdited(editing, args);
          void accept(
            edited ? Date.parse(args.start) : editing.start,
            edited ? Date.parse(args.end) : editing.end,
            edited,
            {
              description: args.description,
              projectId: args.projectId,
              taskId: args.taskId ?? null,
              tagIds: args.tagIds ?? [],
              billable: args.billable,
            },
          );
        }}
      />

      <ActivityRuleDialog
        app={ruleFor?.topApps[0] ?? null}
        seed={ruleSeed}
        onOpenChange={(open) => {
          if (!open) setRuleFor(null);
        }}
        onSave={saveRule}
      />
    </div>
  );
}
