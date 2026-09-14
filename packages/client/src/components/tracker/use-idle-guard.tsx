"use client";

import * as React from "react";
import {
  resolveIdleSettings,
  type IdleAnswer,
  type IdlePlan,
  type IdleSignal,
  type IdleTimerRef,
} from "@starter/core";

import { IdlePrompt } from "@/components/tracker/idle-prompt";
import { useEntryMutations } from "@/components/tracker/use-entry-mutations";
import { toast } from "@/components/ui/sonner";
import { useIdleSignal, type IdleReading } from "@/hooks/use-idle-signal";
import { useRunningEntry } from "@/hooks/use-sync";
import { useFormatSettings } from "@/lib/format";
import { idleWatcher } from "@/lib/idle-watcher";
import { trpc } from "@/lib/trpc";

/** Toast id, so a second reading replaces the prompt instead of stacking one. */
const IDLE_TOAST_ID = "trackyourtime-idle";

const timerRefOf = (
  entry: {
    id: string;
    start: string;
    description: string;
    projectId: string | null;
    taskId: string | null;
    billable: boolean;
  } | null
): IdleTimerRef | null =>
  entry === null
    ? null
    : {
        id: entry.id,
        start: entry.start,
        description: entry.description,
        projectId: entry.projectId,
        taskId: entry.taskId,
        billable: entry.billable,
      };

/**
 * Watches this device for idleness and applies the user's idle setting to the
 * running timer. Mount once, in the tracker bar.
 *
 * The decision itself is `@starter/core/idle` — including the rule that keeps
 * this device out of a timer it did not start. Everything here is the parts a
 * pure decision cannot be: the detector, the react-query mutations, and the
 * prompt.
 */
export const useIdleGuard = (): void => {
  const { entry: running } = useRunningEntry();
  const format = useFormatSettings();
  const mutations = useEntryMutations();
  const projects = trpc.projects.list.useQuery({});

  // Everything the reading handler reads, behind a ref so the handler's
  // identity never changes — the detector installs its listeners once.
  const contextRef = React.useRef({
    running,
    mutations,
    format,
    projects: projects.data,
  });
  contextRef.current = { running, mutations, format, projects: projects.data };

  /** Executing a plan can produce the next one, so this is reached by ref. */
  const runPlanRef = React.useRef<(plan: IdlePlan) => void>(() => undefined);

  const answerIdle = React.useCallback((answer: IdleAnswer): void => {
    toast.dismiss(IDLE_TOAST_ID);
    runPlanRef.current(idleWatcher.answer(answer, Date.now()));
  }, []);

  const runPlan = React.useCallback(
    (plan: IdlePlan): void => {
      const { mutations: apply, format: fmt } = contextRef.current;

      switch (plan.kind) {
        case "none":
          return;

        case "prompt":
          toast.custom(
            () => (
              <IdlePrompt
                pending={plan.pending}
                since={fmt.clock(plan.pending.idleStartedAt)}
                onAnswer={answerIdle}
              />
            ),
            {
              id: IDLE_TOAST_ID,
              // Never auto-dismisses: the person it is addressed to is, by
              // definition, not at the machine yet. A prompt that expired
              // while they were away would leave the idle minutes on the entry
              // with no record that anything had ever been offered.
              duration: Number.POSITIVE_INFINITY,
            }
          );
          return;

        case "truncate":
          apply.splitAtIdle({
            end: plan.endAt,
            resume: plan.resume === "now" ? { ...plan.seed } : null,
          });
          return;

        case "resume":
          apply.startTimer({ ...plan.seed, start: plan.startAt });
          return;
      }
    },
    [answerIdle]
  );

  runPlanRef.current = runPlan;

  const onReading = React.useCallback((reading: IdleReading): void => {
    const context = contextRef.current;
    const entry = context.running;

    // A project may legitimately produce no input — meetings, reading, calls —
    // so its own behaviour wins over the workspace's.
    const project =
      entry?.projectId == null
        ? undefined
        : context.projects?.find(
            (candidate) => candidate.id === entry.projectId
          );

    runPlanRef.current(
      idleWatcher.observe({
        signal: reading.signal satisfies IdleSignal,
        atMs: reading.atMs,
        idleSinceMs: reading.idleSinceMs,
        timer: timerRefOf(entry),
        settings: resolveIdleSettings(
          context.format.settings.idle,
          project?.idleBehavior
        ),
      })
    );
  }, []);

  // The detector only runs when the feature is on, so a workspace with idle
  // detection disabled installs no listeners and no interval at all.
  useIdleSignal(onReading, format.settings.idle.enabled && format.isLoaded);
};
