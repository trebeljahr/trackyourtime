"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { decideTimerToggle } from "@starter/core";
import type {
  DesktopCommand,
  DesktopRecent,
  DesktopTimerState,
  RecentEntry,
  TimeEntry,
} from "@starter/shared";

import { DesktopAttentionGuards } from "@/components/desktop/desktop-attention-guards";
import { useEntryMutations } from "@/components/tracker/use-entry-mutations";
import { RECENT_INPUT } from "@/hooks/use-favorites";
import { useIsElectron } from "@/hooks/use-shell";
import { timerStore } from "@/hooks/use-sync";
import { useT } from "@/i18n/use-t";
import type { Translator } from "@/i18n/translator";
import { desktopShell, focusTrackerDescription } from "@/lib/desktop-shell";
import { trpc } from "@/lib/trpc";
import { useOfflineQueueState } from "@/providers/offline-queue-provider";

/** How many recents the tray offers to continue. */
const TRAY_RECENTS = 5;

/** Settings listens for this when a tray click asks for its Desktop tab while it is already open. */
export const SETTINGS_TAB_EVENT = "trackyourtime:settings-tab";

/** The tracker screen, which mounts its own idle and runaway guards. */
const isTrackPath = (path: string | null): boolean => path === "/app/track" || path === "/app/track/";

const selectRunning = (): TimeEntry | null => timerStore.getState().running;

const recentLabel = (recent: RecentEntry): { label: string; hint: string | null } => {
  const description = recent.description.trim();
  const label = description !== "" ? description : (recent.projectName ?? recent.taskName ?? "");
  if (description === "") return { label, hint: recent.projectName ? recent.clientName : null };
  const project = recent.projectName;
  const hint = project ? (recent.clientName ? `${recent.clientName} · ${project}` : project) : recent.taskName;
  return { label, hint };
};

/** Everything the main process draws, from what the renderer already holds. */
export function buildDesktopTimerState(input: {
  running: TimeEntry | null;
  projects: readonly { id: string; name: string; color: string }[] | undefined;
  recents: readonly RecentEntry[] | undefined;
  unsent: number;
  t: Translator<"shell">;
}): DesktopTimerState {
  const { running, t } = input;
  const project = running?.projectId ? input.projects?.find((candidate) => candidate.id === running.projectId) : undefined;
  const recents: DesktopRecent[] = (input.recents ?? []).slice(0, TRAY_RECENTS).map((recent) => ({
    key: recent.key,
    ...recentLabel(recent),
  }));
  return {
    signedIn: true,
    running:
      running === null
        ? null
        : {
            description: running.description,
            startedAt: running.start,
            projectName: project?.name ?? null,
            projectColor: project?.color ?? null,
          },
    recents,
    unsent: input.unsent,
    labels: {
      stop: t("desktop.tray.stop"),
      startTimer: t("desktop.tray.startTimer"),
      recentHeading: t("desktop.tray.recentHeading"),
      open: t("desktop.tray.open"),
      settings: t("desktop.tray.settings"),
      quit: t("desktop.tray.quit"),
      noDescription: t("desktop.tray.noDescription"),
      idleTooltip: t("desktop.tray.idleTooltip"),
      unsent: input.unsent > 0 ? t("desktop.tray.unsent", { count: input.unsent }) : "",
      quitUnsentTitle: t("desktop.quitUnsent.title", { count: input.unsent }),
      quitUnsentBody: t("desktop.quitUnsent.body"),
      quitUnsentButton: t("desktop.quitUnsent.button"),
      runningBadge: t("desktop.tray.runningBadge"),
    },
  };
}

/**
 * The renderer half of the tray and the global shortcuts (Stage 4): publishes
 * `DesktopTimerState` whenever it changes and runs the commands the main
 * process sends back — through `useEntryMutations`, the same path the tracker
 * bar and the command palette take, so a stop from the tray while offline is
 * the same optimistic, queued row as a stop from the bar.
 *
 * Mounted once, in `AppShell`, beside the offline queue. On the web it does
 * nothing at all: every query is disabled, every effect returns before
 * touching a bridge that is not there, and it renders nothing. In the desktop
 * app it also keeps the idle and runaway guards running off /app/track
 * (`DesktopAttentionGuards`), since a hidden window can sit on any screen.
 */
export function DesktopBridgePublisher({
  onOpenPalette,
}: {
  onOpenPalette: () => void;
}): React.JSX.Element | null {
  const electron = useIsElectron();
  const t = useT("shell");
  const router = useRouter();
  const pathname = usePathname();
  const utils = trpc.useUtils();
  const mutations = useEntryMutations();
  const { pending } = useOfflineQueueState();

  // The running entry without the once-a-second tick `useRunningEntry` adds:
  // the tray computes its own clock from `startedAt`.
  const running = React.useSyncExternalStore(timerStore.subscribe, selectRunning, () => null);
  const projects = trpc.projects.list.useQuery({}, { enabled: electron, staleTime: 60_000 });
  const recents = trpc.entries.recent.useQuery(RECENT_INPUT, { enabled: electron, staleTime: 30_000 });

  const state = React.useMemo(
    () =>
      buildDesktopTimerState({
        running,
        projects: projects.data,
        recents: recents.data,
        unsent: pending,
        t,
      }),
    [running, projects.data, recents.data, pending, t],
  );

  // Published on change only; `JSON.stringify` because the object is rebuilt
  // whenever any input's identity changes, which is more often than its content.
  const lastPublished = React.useRef("");
  const latestState = React.useRef(state);
  React.useEffect(() => {
    latestState.current = state;
    const shell = desktopShell();
    if (shell === null) return;
    const serialized = JSON.stringify(state);
    if (serialized === lastPublished.current) return;
    lastPublished.current = serialized;
    void shell.publishTimerState(state).catch(() => undefined);
  }, [state]);

  // Leaving the signed-in app (sign-out, revocation): the tray falls back to
  // Open and Quit, keeping the labels and the count of what is still queued.
  React.useEffect(
    () => () => {
      const shell = desktopShell();
      if (shell === null) return;
      lastPublished.current = "";
      void shell
        .publishTimerState({ ...latestState.current, signedIn: false, running: null, recents: [] })
        .catch(() => undefined);
    },
    [],
  );

  const compose = React.useCallback((): void => {
    if (pathname !== "/app/track" && pathname !== "/app/track/") router.push("/app/track");
    focusTrackerDescription();
  }, [pathname, router]);

  const recentByKey = React.useCallback(
    (key: string): RecentEntry | undefined => recents.data?.find((recent) => recent.key === key),
    [recents.data],
  );

  const handle = React.useCallback(
    async (command: DesktopCommand): Promise<void> => {
      const shell = desktopShell();
      switch (command.kind) {
        case "stop":
          if (timerStore.getState().running !== null) mutations.stopTimer();
          return;

        case "toggle": {
          if (timerStore.getState().running !== null) {
            mutations.stopTimer();
            return;
          }
          // Fresh when the network answers, the cached list when it does not:
          // a hotkey pressed on a train still resumes the last job.
          let candidates: RecentEntry[] = recents.data ?? [];
          try {
            candidates = await utils.entries.recent.ensureData(RECENT_INPUT);
          } catch {
            candidates = utils.entries.recent.getData(RECENT_INPUT) ?? candidates;
          }
          // Re-read after the await: a start may have landed meanwhile.
          if (timerStore.getState().running !== null) return;
          const decision = decideTimerToggle({
            running: false,
            candidates,
            startOf: (recent) => recent.lastStart,
            nowMs: Date.now(),
          });
          if (decision.kind === "continue") {
            mutations.startQuickStart({
              description: decision.candidate.description,
              projectId: decision.candidate.projectId,
              taskId: decision.candidate.taskId,
              billable: decision.candidate.billable,
            });
            return;
          }
          await shell?.showWindow().catch(() => undefined);
          compose();
          return;
        }

        case "continue": {
          const recent = recentByKey(command.key);
          if (!recent) return;
          mutations.startQuickStart({
            description: recent.description,
            projectId: recent.projectId,
            taskId: recent.taskId,
            billable: recent.billable,
          });
          return;
        }

        case "compose":
          compose();
          return;

        case "open-palette":
          onOpenPalette();
          return;

        case "open-settings":
          if (pathname.startsWith("/app/settings")) {
            window.dispatchEvent(new CustomEvent(SETTINGS_TAB_EVENT, { detail: "desktop" }));
          } else {
            router.push("/app/settings?tab=desktop");
          }
          return;

        case "open-prompt":
          // Both prompts are raised by guards the tracker bar mounts, and
          // their toasts stay up across navigation.
          if (pathname !== "/app/track" && pathname !== "/app/track/") router.push("/app/track");
          return;
      }
    },
    [compose, mutations, onOpenPalette, pathname, recentByKey, recents.data, router, utils],
  );

  const handleRef = React.useRef(handle);
  React.useEffect(() => {
    handleRef.current = handle;
  }, [handle]);

  React.useEffect(() => {
    const shell = desktopShell();
    if (shell === null) return;
    return shell.onCommand((command) => {
      void handleRef.current(command);
    });
  }, [electron]);

  // `electron` is false during hydration, so the prerendered tree is the web's.
  return electron && !isTrackPath(pathname) ? <DesktopAttentionGuards /> : null;
}
