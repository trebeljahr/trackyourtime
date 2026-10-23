"use client";

import { useProjectOptions } from "@/hooks/use-catalog-options";

import * as React from "react";
import { Sparkles } from "lucide-react";
import type { EntryFields } from "@starter/core";
import type { TimeEntry } from "@starter/shared";

import { ActivityRuleDialog } from "@/components/activity/activity-rule-dialog";
import { undoAutopilotStart } from "@/components/activity/autopilot-actions";
import { autopilotStripView, type AutopilotStripView } from "@/components/activity/autopilot-strip-view";
import { filingLabel } from "@/components/activity/autopilot-driver";
import { useActivePause, useDesktopActivitySnapshot } from "@/components/activity/use-desktop-activity";
import type { EntryMutations } from "@/components/tracker/use-entry-mutations";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { useT } from "@/i18n/use-t";
import { nudgeAutopilot } from "@/lib/autopilot-nudge";
import { desktopActivity } from "@/lib/desktop-activity";
import { useFormatSettings } from "@/lib/format";
import { trpc } from "@/lib/trpc";

const EMPTY_FIELDS: EntryFields = { description: "", projectId: null, taskId: null, billable: false, tagIds: [] };

/**
 * Autopilot's line in the tracker bar (desktop app only): one quiet row, never
 * a dialog, and nothing at all while there is nothing to say.
 */
export function AutopilotStrip({
  running,
  mutations,
}: {
  running: TimeEntry | null;
  mutations: Pick<EntryMutations, "removeEntry">;
}): React.JSX.Element | null {
  const t = useT("activity");
  const format = useFormatSettings();
  const utils = trpc.useUtils();
  const snapshot = useDesktopActivitySnapshot();
  const projects = useProjectOptions({}, { enabled: snapshot?.autopilot?.active === true });
  const [teaching, setTeaching] = React.useState<{ key: string; name: string } | null>(null);
  const [busy, setBusy] = React.useState(false);

  const pausedUntil = useActivePause(snapshot?.autopilot?.pausedUntil);
  const view =
    snapshot === null
      ? null
      : autopilotStripView(snapshot.autopilot, running, snapshot.settings.autopilotStartMinutes, pausedUntil);

  const projectName = (id: string | null | undefined): string | null =>
    id === null || id === undefined ? null : (projects.data?.find((project) => project.id === id)?.name ?? null);

  const hold = async (input: { filingKey?: string; appKey?: string }): Promise<void> => {
    const autopilot = desktopActivity()?.autopilot;
    if (autopilot === undefined) return;
    await autopilot.hold(input).catch(() => undefined);
    nudgeAutopilot();
  };

  const resume = async (): Promise<void> => {
    const autopilot = desktopActivity()?.autopilot;
    if (autopilot === undefined) return;
    await autopilot.pause({ paused: false }).catch(() => undefined);
    nudgeAutopilot();
  };

  const undo = async (owned: Extract<AutopilotStripView, { kind: "owned" }>): Promise<void> => {
    const activity = desktopActivity();
    const autopilot = activity?.autopilot;
    if (activity === null || autopilot === undefined) return;
    setBusy(true);
    try {
      await undoAutopilotStart({
        utils,
        mutations,
        activity,
        autopilot,
        at: owned.at,
        filingKey: owned.filingKey,
        logId: owned.logId,
      });
      toast.info(t("autopilot.toast.undone"));
    } catch {
      toast.error(t("autopilot.toast.undoFailed"));
    } finally {
      setBusy(false);
    }
  };

  const saveRule = async (pattern: string, fields: EntryFields): Promise<boolean> => {
    const activity = desktopActivity();
    if (activity === null) return false;
    try {
      await activity.addRule({
        pattern,
        ...(fields.description.trim() !== "" ? { description: fields.description.trim() } : {}),
        projectId: fields.projectId,
        taskId: fields.taskId,
        tagIds: fields.tagIds,
        billable: fields.billable,
      });
      // Main plans with the rule at once: the timer starts from when the work began.
      nudgeAutopilot();
      return true;
    } catch {
      toast.error(t("toasts.ruleFailed"));
      return false;
    }
  };

  const dialog = (
    <ActivityRuleDialog
      app={teaching}
      seed={EMPTY_FIELDS}
      onOpenChange={(open) => {
        if (!open) setTeaching(null);
      }}
      onSave={saveRule}
    />
  );

  if (view === null) return teaching === null ? null : dialog;

  const span = (ms: number): string => format.durationShort(Math.round(ms / 1000));
  const clockAt = (ms: number): string => format.clock(new Date(ms).toISOString());
  const resumeButton = (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className="h-7 px-2"
      onClick={() => void resume()}
      data-testid="autopilot-strip-resume"
    >
      {t("autopilot.strip.resume")}
    </Button>
  );
  const threshold = format.durationShort((snapshot?.settings.autopilotStartMinutes ?? 5) * 60);

  return (
    <div
      className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground"
      data-testid="autopilot-strip"
      data-kind={view.kind}
    >
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-brand/10 text-brand" aria-hidden>
        <Sparkles className="size-3" />
      </span>

      {view.kind === "owned" ? (
        <>
          <span className="min-w-0 truncate">
            {view.app === null
              ? t("autopilot.strip.ownedNoApp", { time: clockAt(view.at) })
              : t("autopilot.strip.owned", { time: clockAt(view.at), app: view.app })}
            {view.pausedUntil !== null ? (
              <span data-testid="autopilot-strip-paused">
                {" · "}
                {t("autopilot.strip.pausedShort", { time: clockAt(view.pausedUntil) })}
              </span>
            ) : null}
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 px-2"
            disabled={busy}
            onClick={() => void undo(view)}
            data-testid="autopilot-strip-undo"
          >
            {t("autopilot.strip.undo")}
          </Button>
          {view.pausedUntil !== null ? resumeButton : null}
        </>
      ) : null}

      {view.kind === "paused" ? (
        <>
          <span className="min-w-0 truncate" data-testid="autopilot-strip-paused">
            {t("autopilot.strip.paused", { time: clockAt(view.until) })}
          </span>
          {resumeButton}
        </>
      ) : null}

      {view.kind === "warming" ? (
        <>
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="truncate">
              {t("autopilot.strip.warming", {
                span: span(view.watch.creditedMs),
                app: view.watch.app.name,
                label: filingLabel(view.watch.filing?.fields ?? {}, projectName, t),
                threshold,
              })}
            </span>
            <span className="h-0.5 w-full max-w-xs overflow-hidden rounded-full bg-brand/10" aria-hidden>
              <span
                className="block h-full rounded-full bg-brand transition-[width] duration-700 ease-out"
                style={{ width: `${Math.round(view.progress * 100)}%` }}
              />
            </span>
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 px-2"
            onClick={() => void hold({ filingKey: view.watch.filing?.key, appKey: view.watch.app.key })}
            data-testid="autopilot-strip-not-now"
          >
            {t("autopilot.strip.notNow")}
          </Button>
        </>
      ) : null}

      {view.kind === "ask" ? (
        <>
          <span className="min-w-0 truncate">
            {t("autopilot.strip.ask", { span: span(view.watch.creditedMs), app: view.watch.app.name })}
          </span>
          <span className="flex gap-1">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 px-2"
              onClick={() => setTeaching(view.watch.app)}
              data-testid="autopilot-strip-track-as"
            >
              {t("autopilot.strip.trackAs")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-2"
              onClick={() => void hold({ appKey: view.watch.app.key })}
              data-testid="autopilot-strip-not-work"
            >
              {t("autopilot.strip.notWork")}
            </Button>
          </span>
        </>
      ) : null}

      {view.kind === "held" ? (
        <span className="min-w-0 truncate">{t("autopilot.strip.held", { app: view.watch.app.name })}</span>
      ) : null}

      {dialog}
    </div>
  );
}
