import { Icon, Keyboard, LaunchType, MenuBarExtra, Toast, launchCommand, open, showToast } from "@raycast/api";
import {
  isTempId,
  quickStartHint,
  quickStartLabel,
  repairQuickStart,
  toQuickStart,
  timerMenuSections,
} from "./vendor/index.js";
import { getTrackYourTime, type ProjectWithStats } from "./lib/api.js";
import { CompatibilityMenuBarSection } from "./components/compatibility-banner.js";
import { useMenuPresence } from "./lib/menu-presence.js";
import { BRAND_MARK } from "./lib/brand.js";
import { refreshTimerSearch } from "./lib/timer-search.js";
import { useEffect, useRef, useState } from "react";
import { formatClock, formatDurationShort, formatMenuBarClock } from "./lib/format.js";
import { useApi, useMinuteClock, useReconciledRunning, useWatchRunning } from "./lib/hooks.js";
import { lastRunningStart, rememberRunningStart } from "./lib/menu-frame.js";
import { heldCopy } from "./lib/offline.js";
import { webLink } from "./lib/preferences.js";
import {
  entryLabel,
  favoriteFor,
  loadTimerSnapshot,
  previewStarted,
  previewStopped,
  type TimerSnapshot,
} from "./lib/timer-data.js";
import { useServerLevel } from "./lib/server-level.js";
import { useSyncRevalidate } from "./lib/sync.js";
import { noteTimerEcho } from "./lib/storage.js";
import { describeFailure, isAlreadyStopped, refreshMenuBar, replacedNotice, showFailureToast } from "./lib/ui.js";

/** History contributes today’s total, but has no separate section in this menu. */
const RECENT_LIMIT = 6;

/**
 * The fallback for a running clock whose socket cannot connect: a proxy that
 * drops upgrades, or no network at all. With the socket open nothing polls.
 */
const WATCH_MS = 60_000;

/** The live command, where the clock ticks and forms can be pushed. */
const openTimer = (editRunningId?: string): Promise<void> => {
  return launchCommand({
    name: "entries",
    type: LaunchType.UserInitiated,
    context: { showTimer: true, ...(editRunningId ? { editRunningId } : {}) },
  });
};

/**
 * The native item stays for the life of the command and this never returns null,
 * since null removes the status item from the menu bar.
 *
 * Idle: `isLoading` turns false after the read, Raycast unloads the process, and
 * nothing recurs. No manifest `interval` exists, so nothing launches it again
 * until someone opens the menu or another command changes the timer. Raycast has
 * no way to hold a socket for an unloaded command, so a timer started on another
 * device appears when the menu is opened.
 *
 * Running: `isLoading` stays true, the one way to keep a process loaded. That
 * process wakes once per elapsed minute and holds the sync socket.
 */
export default function MenuBar(): React.JSX.Element {
  const starting = useRef(false);
  const [isActing, setIsActing] = useState(false);
  const { data, isLoading, error, signedOut, revalidate, refresh, optimistic } = useApi("menu-bar", async (api) => {
    const snapshot = await loadTimerSnapshot(api, { recentLimit: RECENT_LIMIT });
    await refreshTimerSearch();
    return snapshot;
  });

  /**
   * What is running, after this Mac's own timer echo is applied.
   *
   * `data` can be a cached snapshot from before the last stop — Raycast paints
   * the cache first, and a still-loaded menu bar command is not remounted by
   * `refreshMenuBar()`. Reconciling against the echo is what stops the item
   * ticking a timer the user ended a second ago in another command.
   */
  const running = useReconciledRunning(data, revalidate);

  const pending = data?.pending ?? 0;
  // Queued work needs the socket's "the network is back" too, or it would wait
  // for someone to open the menu.
  const live = running !== null || pending > 0;

  // Before the snapshot is usable, keep the clock the item already shows.
  const heldStart = data === undefined && isLoading && !signedOut ? lastRunningStart() : null;
  const clockStart = running?.start ?? heldStart;
  const now = useMinuteClock(clockStart === null ? null : Date.parse(clockStart));
  const knownStart = signedOut ? null : data === undefined ? undefined : (running?.start ?? null);
  useEffect(() => {
    if (knownStart !== undefined) rememberRunningStart(knownStart);
  }, [knownStart]);

  const synced = useSyncRevalidate(revalidate, !signedOut && live);
  useWatchRunning(running?.id ?? null, running !== null && !synced, revalidate, WATCH_MS);
  // The server-level refresh is throttled per origin.
  const { banner } = useServerLevel();
  const desktopYielded = useMenuPresence();

  if (signedOut) {
    return (
      <MenuBarExtra icon={BRAND_MARK} tooltip="Track Your Time — not signed in">
        <MenuBarExtra.Item title="Sign in to Track Your Time" icon={Icon.Key} onAction={() => openTimer()} />
      </MenuBarExtra>
    );
  }

  const elapsed = clockStart === null ? 0 : Math.max(0, Math.floor((now - Date.parse(clockStart)) / 1000));
  const clock = formatMenuBarClock(elapsed);
  const label = running ? entryLabel(running) : "";
  const sections = timerMenuSections(running ? { label, elapsedSec: elapsed } : null);
  const [summary, controls] = sections;
  const favorites = data?.favorites ?? [];
  const projects = data?.projects ?? [];
  const pinned = running ? favoriteFor(running, favorites) : undefined;
  const foreign = data?.foreign ?? 0;

  const act = async (
    run: () => Promise<void>,
    failureTitle: string,
    preview?: (snapshot: TimerSnapshot) => TimerSnapshot,
  ): Promise<void> => {
    setIsActing(true);
    try {
      await (preview ? optimistic(run(), preview) : run());
      // Finish the read before Raycast closes this action's process. A void
      // revalidation can leave the native item holding its pre-click snapshot.
      // Optimistic mutations already await this refresh in menu-bar commands.
      if (!preview) await refresh();
      await refreshMenuBar();
    } catch (error) {
      // Somebody stopped it elsewhere between this item's last read and the
      // click. The user got what they wanted; record it and move on rather
      // than reporting a failure for a state that is already correct.
      if (isAlreadyStopped(error)) {
        await noteTimerEcho(null);
        await refresh();
        await refreshMenuBar();
        await showToast({
          style: Toast.Style.Success,
          title: "Timer already stopped",
        });
        return;
      }
      await showFailureToast(error, failureTitle);
    } finally {
      setIsActing(false);
    }
  };

  // Start first. The view can then edit this already-running entry.
  const startNow = async (project?: ProjectWithStats): Promise<void> => {
    if (starting.current) return;
    starting.current = true;
    let editId: string | undefined;
    try {
      await act(async () => {
        const api = await getTrackYourTime();
        const entry = await api.start(
          project ? { projectId: project.id, billable: project.billableDefault } : { description: "" },
        );
        if (!isTempId(entry.id)) editId = entry.id;
        const replaced = replacedNotice(entry);
        if (replaced) await showToast({ style: Toast.Style.Success, title: "Timer started", message: replaced });
      }, "Could not start the timer");
      // Hand off only after the native item has read and refreshed its timer.
      if (editId) await openTimer(editId);
    } finally {
      starting.current = false;
    }
  };

  return (
    <MenuBarExtra
      icon={BRAND_MARK}
      title={clockStart === null ? undefined : clock}
      isLoading={isLoading || isActing || live || !desktopYielded}
      tooltip={
        // A failed refresh leaves the previous snapshot on screen, which is
        // the right call for a glanceable item — but it must not pass for a
        // fresh reading, so say so where the number is.
        error
          ? `Track Your Time — could not refresh · ${describeFailure(error)}`
          : pending > 0
            ? `${pending} change${pending === 1 ? "" : "s"} waiting to sync${running ? ` · ${label} — ${clock}` : ""}`
            : running
              ? `${label} — ${clock}`
              : `Track Your Time — no timer running · today ${formatDurationShort(data?.todaySec ?? 0)}`
      }
    >
      {/* First: while one side is too old nothing below works as it should. */}
      <CompatibilityMenuBarSection banner={banner} />

      {running ? (
        <>
          <MenuBarExtra.Section>
            {/* Native menu fonts are fixed. Keep the name at full contrast,
              with passive timing below and controls in a separate section. */}
            {summary.rows.map((row) => (
              <MenuBarExtra.Item
                key={row.kind}
                title={row.title}
                tooltip={row.kind === "name" ? row.tooltip : undefined}
                icon={row.kind === "name" ? Icon.Stopwatch : undefined}
                subtitle={row.kind === "timing" ? `since ${formatClock(running.start)}` : undefined}
                onAction={row.kind === "name" ? () => openTimer(running.id) : undefined}
              />
            ))}
            {data?.runningWorkspaceName ? (
              <MenuBarExtra.Item
                title={`In ${data.runningWorkspaceName}`}
                icon={Icon.Building}
                onAction={() => openTimer()}
              />
            ) : null}
          </MenuBarExtra.Section>
          <MenuBarExtra.Section>
            <MenuBarExtra.Item
              title={controls.rows[0].title}
              icon={Icon.Stop}
              shortcut={Keyboard.Shortcut.Common.Save}
              onAction={() => {
                return act(
                  async () => {
                    const api = await getTrackYourTime();
                    const stopped = await api.stop(running.id);
                    await showToast({
                      style: Toast.Style.Success,
                      title: "Timer stopped",
                      message: formatDurationShort(stopped.durationSec),
                    });
                  },
                  "Could not stop the timer",
                  (snapshot) => ({
                    ...snapshot,
                    fetchedAt: Date.now(),
                    running: null,
                    recent:
                      running?.workspaceId === snapshot.activeWorkspaceId
                        ? [previewStopped(running), ...snapshot.recent.filter((row) => row.id !== running.id)]
                        : snapshot.recent,
                  }),
                );
              }}
            />
            {/* A menu bar item cannot host a form, so editing hands off to the
              Timer command, which opens on the running entry. */}
            <MenuBarExtra.Item
              title={controls.rows[1].title}
              icon={Icon.Pencil}
              shortcut={Keyboard.Shortcut.Common.Edit}
              onAction={() => openTimer(running.id)}
            />
            <MenuBarExtra.Item
              title={pinned ? "Remove Favorite" : "Pin as Favorite"}
              icon={pinned ? Icon.StarDisabled : Icon.Star}
              shortcut={{ modifiers: ["cmd"], key: "f" }}
              onAction={() => {
                return act(async () => {
                  const api = await getTrackYourTime();
                  if (pinned) {
                    await api.removeFavorite(pinned.id);
                    await showToast({
                      style: Toast.Style.Success,
                      title: "Favorite removed",
                    });
                    return;
                  }
                  await api.addFavorite(toQuickStart(running));
                  await showToast({
                    style: Toast.Style.Success,
                    title: "Pinned as a favorite",
                  });
                }, "Could not update favorites");
              }}
            />
            <MenuBarExtra.Item
              title="Discard Timer"
              icon={Icon.Trash}
              shortcut={{ modifiers: ["cmd", "shift"], key: "backspace" }}
              onAction={() => {
                return act(async () => {
                  const api = await getTrackYourTime();
                  await api.discard(running.id);
                  await showToast({
                    style: Toast.Style.Success,
                    title: "Timer discarded",
                  });
                }, "Could not discard the timer");
              }}
            />
          </MenuBarExtra.Section>
        </>
      ) : (
        <MenuBarExtra.Section title={summary.title}>
          <MenuBarExtra.Item
            title={summary.rows[0].title}
            icon={Icon.Play}
            shortcut={Keyboard.Shortcut.Common.New}
            onAction={() => startNow()}
          />
        </MenuBarExtra.Section>
      )}

      {/* Starting other work belongs to the idle menu. */}
      {!running && favorites.length > 0 ? (
        <MenuBarExtra.Section title="Favorites">
          {favorites.map((favorite) => (
            <MenuBarExtra.Item
              key={favorite.id}
              title={quickStartLabel(favorite)}
              subtitle={quickStartHint(favorite) ?? undefined}
              icon={Icon.Star}
              onAction={() => {
                return act(
                  async () => {
                    const api = await getTrackYourTime();
                    const started = await api.startQuick(repairQuickStart(favorite));
                    await showToast({
                      style: Toast.Style.Success,
                      title: "Timer started",
                      message: [quickStartLabel(favorite), replacedNotice(started)].filter(Boolean).join(" · "),
                    });
                  },
                  "Could not start the timer",
                  (snapshot) => ({
                    ...snapshot,
                    fetchedAt: Date.now(),
                    running: previewStarted(repairQuickStart(favorite), favorite, snapshot.activeWorkspaceId),
                  }),
                );
              }}
            />
          ))}
        </MenuBarExtra.Section>
      ) : null}

      {!running && projects.length > 0 ? (
        <MenuBarExtra.Section title="Quick Start">
          <MenuBarExtra.Submenu title="Start in Project" icon={Icon.Folder}>
            {projects.slice(0, 8).map((project) => (
              <MenuBarExtra.Item
                key={project.id}
                title={project.name}
                subtitle={project.clientName ?? undefined}
                icon={{ source: Icon.CircleFilled, tintColor: project.color }}
                onAction={() => startNow(project)}
              />
            ))}
          </MenuBarExtra.Submenu>
        </MenuBarExtra.Section>
      ) : null}

      {/* Unsynced work is stated rather than hidden: what is queued is time
          the user tracked, and a client holding it quietly looks exactly like
          one that lost it. Retrying is what every other read here already
          does, so the row simply refreshes. */}
      {pending > 0 || foreign > 0 || (data?.held ?? 0) > 0 ? (
        <MenuBarExtra.Section title="Not synced">
          {pending > 0 ? (
            <MenuBarExtra.Item
              title={`${pending} change${pending === 1 ? "" : "s"} waiting`}
              subtitle="Kept on this Mac until the server answers"
              icon={Icon.Cloud}
              onAction={revalidate}
            />
          ) : null}
          {foreign > 0 ? (
            <MenuBarExtra.Item
              title={
                (data?.left ?? 0) === foreign
                  ? `${foreign} from a workspace you left`
                  : `${foreign} for another account, server or workspace`
              }
              subtitle="Kept, never sent from here — open the Timer to review"
              icon={Icon.Person}
              onAction={() => openTimer()}
            />
          ) : null}
          {(data?.held ?? 0) > 0 ? (
            <MenuBarExtra.Item
              title={heldCopy(data?.held ?? 0, data?.heldReason ?? null).title}
              subtitle="Kept — open the Timer to review"
              icon={Icon.Hourglass}
              onAction={() => openTimer()}
            />
          ) : null}
        </MenuBarExtra.Section>
      ) : null}

      <MenuBarExtra.Section title={`Today · ${formatDurationShort(data?.todaySec ?? 0)}`}>
        {!running ? (
          <MenuBarExtra.Item
            title="Timer Details…"
            icon={Icon.Stopwatch}
            shortcut={{ modifiers: ["cmd"], key: "t" }}
            onAction={() => openTimer()}
          />
        ) : null}
        <MenuBarExtra.Item
          title="Show All Time…"
          icon={Icon.List}
          onAction={() => {
            return launchCommand({
              name: "entries",
              type: LaunchType.UserInitiated,
            });
          }}
        />
        <MenuBarExtra.Item
          title="Open Dashboard"
          icon={Icon.Globe}
          onAction={() => {
            return open(webLink("/app/track"));
          }}
        />
        <MenuBarExtra.Item
          title="Refresh"
          icon={Icon.ArrowClockwise}
          shortcut={Keyboard.Shortcut.Common.Refresh}
          onAction={revalidate}
        />
      </MenuBarExtra.Section>
    </MenuBarExtra>
  );
}
