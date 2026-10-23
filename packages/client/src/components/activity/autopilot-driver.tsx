"use client";

import { useProjectOptions, useTaskOptions } from "@/hooks/use-catalog-options";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";
import { filingKeyOf } from "@starter/core";
import type { DesktopActivity, DesktopAutopilot, DesktopAutopilotPlan, TimeEntry } from "@starter/shared";

import { withKnownCatalog, type KnownCatalog } from "@/components/activity/accept-suggestion";
import { currentRunning, undoAutopilotStart } from "@/components/activity/autopilot-actions";
import {
  autopilotHistoryRange,
  autopilotTrackedRange,
  describeRunning,
  fieldsOfProposal,
  historyFrom,
  trackedWithoutRunning,
} from "@/components/activity/autopilot-data";
import { fetchEntriesBetween } from "@/components/activity/tracked-intervals";
import { TAG_LIST_INPUT } from "@/components/tags/use-tags";
import { useViewerId } from "@/components/tracker/own-entries";
import { useEntryMutations, type EntryMutations } from "@/components/tracker/use-entry-mutations";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { useIsElectron } from "@/hooks/use-shell";
import type { Translator } from "@/i18n/translator";
import { useT } from "@/i18n/use-t";
import { getActiveWorkspaceId } from "@/lib/active-workspace";
import { onAutopilotNudge } from "@/lib/autopilot-nudge";
import { desktopActivity } from "@/lib/desktop-activity";
import { focusTrackerDescription, notifyDesktop } from "@/lib/desktop-shell";
import { useFormatSettings, type FormatSettings } from "@/lib/format";
import { listOwnQueuedMutations } from "@/lib/offline";
import { trpc } from "@/lib/trpc";

/** How often Autopilot looks. Its thresholds are minutes; this only bounds the lag. */
export const AUTOPILOT_PLAN_EVERY_MS = 20_000;
/** How often what each app is used for is learned again. */
export const AUTOPILOT_LEARN_EVERY_MS = 10 * 60_000;
/** A plan's `entries.list` read may answer from cache this long; a sync event invalidates it sooner. */
export const AUTOPILOT_TRACKED_STALE_MS = 30_000;
const LEARN_STALE_MS = 5 * 60_000;
const LEARN_MAX_PAGES = 15;
const TOAST_ID = "trackyourtime-autopilot";
const TOAST_MS = 15_000;

const sameEntry = (a: TimeEntry | null, b: TimeEntry | null): boolean =>
  a === null || b === null ? a === b : a.id === b.id && a.start === b.start;

/** What a filing reads as: its description, else its project, else a placeholder. */
export const filingLabel = (
  fields: { description?: string; projectId?: string | null },
  projectName: (id: string | null | undefined) => string | null,
  t: Translator<"activity">,
): string => {
  const description = (fields.description ?? "").trim();
  if (description !== "") return description;
  return projectName(fields.projectId) ?? t("autopilot.noDescription");
};

/**
 * Autopilot's renderer half. Main decides (`electron/src/activity/autopilot.ts`
 * over core's `decideAutopilot`); this asks it every few seconds what to do,
 * makes the write through `useEntryMutations` — so an Autopilot start is an
 * ordinary start: optimistic, queued offline, `source: "desktop"` — reports
 * back, and says what it did, in a toast and, while the window is hidden, a
 * system notification.
 *
 * Mounted once, in `AppShell`. Renders nothing and mounts nothing on the web,
 * and nothing in the desktop app until Autopilot is switched on.
 */
export function DesktopAutopilotDriver(): React.JSX.Element | null {
  const electron = useIsElectron();
  const activity = React.useMemo(() => (electron ? desktopActivity() : null), [electron]);
  const [state, setState] = React.useState<{ active: boolean; retentionDays: number }>({
    active: false,
    retentionDays: 14,
  });

  React.useEffect(() => {
    if (activity === null) return;
    let live = true;
    const take = (snapshot: Awaited<ReturnType<DesktopActivity["snapshot"]>>): void => {
      if (!live) return;
      const next = { active: snapshot.autopilot?.active === true, retentionDays: snapshot.settings.retentionDays };
      // Same values, same object: main pushes often, and this must not re-render the loop.
      setState((previous) =>
        previous.active === next.active && previous.retentionDays === next.retentionDays ? previous : next,
      );
    };
    const off = activity.onChanged(take);
    activity.snapshot().then(take, () => undefined);
    return () => {
      live = false;
      off();
    };
  }, [activity]);

  const autopilot = activity?.autopilot ?? null;
  if (activity === null || autopilot === null || !state.active) return null;
  return <AutopilotLoop activity={activity} autopilot={autopilot} retentionDays={state.retentionDays} />;
}

type LoopContext = {
  mutations: EntryMutations;
  viewerId: string | null;
  catalog: KnownCatalog;
  projectName: (id: string | null | undefined) => string | null;
  format: FormatSettings;
  t: Translator<"activity">;
  goToTracker: () => void;
};

function AutopilotLoop({
  activity,
  autopilot,
  retentionDays,
}: {
  activity: DesktopActivity;
  autopilot: DesktopAutopilot;
  retentionDays: number;
}): null {
  const t = useT("activity");
  const format = useFormatSettings();
  const router = useRouter();
  const utils = trpc.useUtils();
  const mutations = useEntryMutations();
  const viewerId = useViewerId();
  const projects = useProjectOptions({});
  const tasks = useTaskOptions({});
  const tags = trpc.tags.list.useQuery(TAG_LIST_INPUT);

  const context = React.useMemo<LoopContext>(() => {
    const projectName = (id: string | null | undefined): string | null =>
      id === null || id === undefined ? null : (projects.data?.find((project) => project.id === id)?.name ?? null);
    return {
      mutations,
      viewerId,
      catalog: {
        projects:
          projects.data === undefined
            ? null
            : new Map(projects.data.map((project) => [project.id, { billableDefault: project.billableDefault }])),
        tasks: tasks.data === undefined ? null : new Set(tasks.data.map((task) => task.id)),
        tags: tags.data === undefined ? null : new Set(tags.data.map((tag) => tag.id)),
      },
      projectName,
      format,
      t,
      goToTracker: () => {
        router.push("/app/track");
        focusTrackerDescription();
      },
    };
  }, [format, mutations, projects.data, router, t, tags.data, tasks.data, viewerId]);

  // The loop reads the latest context through a ref, so its timers are
  // installed once. Written from an effect: every reader runs after a commit.
  const contextRef = React.useRef(context);
  React.useEffect(() => {
    contextRef.current = context;
  }, [context]);

  const busy = React.useRef(false);

  const undo = React.useCallback(
    async (at: number, writtenKey: string): Promise<void> => {
      const { mutations: apply, t: tr } = contextRef.current;
      toast.dismiss(TOAST_ID);
      try {
        await undoAutopilotStart({ utils, mutations: apply, activity, autopilot, at, filingKey: writtenKey });
        toast.info(tr("autopilot.toast.undone"));
      } catch {
        toast.error(tr("autopilot.toast.undoFailed"));
      }
    },
    [activity, autopilot, utils],
  );

  const announce = React.useCallback(
    (plan: Exclude<DesktopAutopilotPlan, { kind: "none" }>, label: string, writtenKey: string | null): void => {
      const { format: fmt, t: tr, goToTracker } = contextRef.current;
      const time = fmt.clock(new Date(plan.at).toISOString());
      const evidence =
        plan.kind === "stop"
          ? null
          : tr("autopilot.toast.evidence", { span: fmt.durationShort(Math.round(plan.creditedMs / 1000)), app: plan.app.name });
      const via = plan.kind === "stop" ? null : tr(`autopilot.via.${plan.filing.via}`);

      toast.custom(
        () => (
          <AutopilotToast
            kind={plan.kind}
            title={tr(`autopilot.toast.${plan.kind === "start" ? "started" : plan.kind === "switch" ? "switched" : "stopped"}`, {
              label,
            })}
            when={tr(plan.kind === "start" ? "autopilot.toast.since" : "autopilot.toast.at", { time })}
            detail={plan.kind === "stop" ? tr("autopilot.toast.stoppedBody") : `${evidence ?? ""} · ${via ?? ""}`}
            onUndo={plan.kind === "start" && writtenKey !== null ? () => void undo(plan.at, writtenKey) : null}
            onChange={
              plan.kind === "stop"
                ? null
                : () => {
                    toast.dismiss(TOAST_ID);
                    goToTracker();
                  }
            }
            t={tr}
          />
        ),
        { id: TOAST_ID, duration: TOAST_MS },
      );

      // Only posted while the window is hidden or behind another app; a click
      // brings it back to /app/activity.
      notifyDesktop({
        kind: "autopilot",
        tag: TOAST_ID,
        title: tr(`autopilot.notice.${plan.kind === "start" ? "started" : plan.kind === "switch" ? "switched" : "stopped"}`, {
          label,
          time,
        }),
        body:
          plan.kind === "stop"
            ? tr("autopilot.notice.stoppedBody")
            : tr("autopilot.notice.body", {
                span: fmt.durationShort(Math.round(plan.creditedMs / 1000)),
                app: plan.app.name,
              }),
      });
    },
    [undo],
  );

  const tick = React.useCallback(async (): Promise<void> => {
    if (busy.current) return;
    busy.current = true;
    try {
      const { viewerId: viewer } = contextRef.current;
      const now = Date.now();
      const before = currentRunning(utils);
      const workspaceId = getActiveWorkspaceId();
      const range = autopilotTrackedRange(now);
      const [entries, queued] = await Promise.all([
        fetchEntriesBetween(utils, range, { staleTime: AUTOPILOT_TRACKED_STALE_MS }),
        workspaceId === null ? Promise.resolve([]) : listOwnQueuedMutations(workspaceId),
      ]);
      const tracked = trackedWithoutRunning({ entries, viewerId: viewer, running: before, queued, range, now });
      const plan = await autopilot.plan({ running: describeRunning(before), tracked });
      if (plan.kind === "none") return;

      // Something started or stopped while main was asked: this plan answers
      // a question nobody is asking any more. Dropped unreported; the next
      // tick asks again.
      const running = currentRunning(utils);
      if (!sameEntry(before, running)) return;

      const { mutations: apply, catalog, projectName } = contextRef.current;
      const at = new Date(plan.at).toISOString();

      if (plan.kind === "stop") {
        if (running === null) return;
        const label = filingLabel(running, projectName, contextRef.current.t);
        apply.stopTimer(at);
        await autopilot.applied({ token: plan.token, ok: true });
        announce(plan, label, null);
        return;
      }

      const fields = withKnownCatalog(fieldsOfProposal(plan.filing.fields), catalog);
      const written = { description: fields.description, projectId: fields.projectId, taskId: fields.taskId };
      const start = {
        description: fields.description,
        projectId: fields.projectId,
        taskId: fields.taskId,
        billable: fields.billable,
        tagIds: fields.tagIds,
        start: at,
      };
      if (plan.kind === "start") {
        if (running !== null) return;
        apply.startTimer(start);
      } else {
        if (running === null) return;
        apply.splitAtIdle({ end: at, resume: start });
      }
      await autopilot.applied({ token: plan.token, ok: true, written });
      announce(plan, filingLabel(fields, projectName, contextRef.current.t), filingKeyOf(written));
    } catch {
      // A failed read or a closed bridge: nothing was written, try next tick.
    } finally {
      busy.current = false;
    }
  }, [announce, autopilot, utils]);

  const learn = React.useCallback(async (): Promise<void> => {
    try {
      const now = Date.now();
      const entries = await fetchEntriesBetween(utils, autopilotHistoryRange(now, retentionDays), {
        staleTime: LEARN_STALE_MS,
        maxPages: LEARN_MAX_PAGES,
      });
      await autopilot.learn(historyFrom({ entries, viewerId: contextRef.current.viewerId, now }));
    } catch {
      // Learning is an improvement, never a requirement: rules still work.
    }
  }, [autopilot, retentionDays, utils]);

  React.useEffect(() => {
    void learn().then(() => tick());
    const planTimer = window.setInterval(() => void tick(), AUTOPILOT_PLAN_EVERY_MS);
    const learnTimer = window.setInterval(() => void learn(), AUTOPILOT_LEARN_EVERY_MS);
    const offNudge = onAutopilotNudge(() => void tick());
    return () => {
      window.clearInterval(planTimer);
      window.clearInterval(learnTimer);
      offNudge();
    };
  }, [learn, tick]);

  return null;
}

/** The toast Autopilot leaves after it acts: what, since when, why, and the way back. */
export function AutopilotToast({
  kind,
  title,
  when,
  detail,
  onUndo,
  onChange,
  t,
}: {
  kind: "start" | "switch" | "stop";
  title: string;
  when: string;
  detail: string;
  onUndo: (() => void) | null;
  onChange: (() => void) | null;
  t: Translator<"activity">;
}): React.JSX.Element {
  return (
    <div
      className="flex w-full items-start gap-3 rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-lg"
      data-testid="autopilot-toast"
      data-kind={kind}
    >
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-brand/10 text-brand" aria-hidden>
        <Sparkles className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("autopilot.name")}</p>
        <p className="truncate text-sm font-medium" data-testid="autopilot-toast-title">
          {title}
        </p>
        <p className="text-sm text-muted-foreground">
          <span className="tabular-nums">{when}</span>
          {" · "}
          {detail}
        </p>
        {onUndo !== null || onChange !== null ? (
          <div className="flex gap-2 pt-1">
            {onUndo !== null ? (
              <Button type="button" size="sm" variant="outline" onClick={onUndo} data-testid="autopilot-toast-undo">
                {t("autopilot.toast.undo")}
              </Button>
            ) : null}
            {onChange !== null ? (
              <Button type="button" size="sm" variant="ghost" onClick={onChange} data-testid="autopilot-toast-change">
                {t("autopilot.toast.change")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
