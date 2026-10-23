import {
  Icon,
  Keyboard,
  LaunchType,
  MenuBarExtra,
  Toast,
  getPreferenceValues,
  launchCommand,
  open,
  showToast,
} from "@raycast/api";
import {
  entryDurationSec,
  isTempId,
  quickStartHint,
  quickStartLabel,
  repairQuickStart,
  toQuickStart,
} from "./vendor/index.js";
import { getTrackYourTime, type ProjectWithStats } from "./lib/api.js";
import { CompatibilityMenuBarSection } from "./components/compatibility-banner.js";
import { BRAND_MARK } from "./lib/brand.js";
import { refreshTimerSearch } from "./lib/timer-search.js";
import { useRef, useState } from "react";
import { formatClock, formatDurationShort, formatMenuBarClock, projectIcon } from "./lib/format.js";
import { useApi, useNow, usePoll, useReconciledRunning, useWatchRunning } from "./lib/hooks.js";
import { heldCopy } from "./lib/offline.js";
import { webLink } from "./lib/preferences.js";
import {
  entryHint,
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

/** Native menus grow to fit their text, so keep each label to one short line. */
const menuText = (text: string): string => {
  const line = text.trim().split(/\r?\n/, 1)[0].trim();
  const chars = Array.from(line);
  return chars.length > 48 ? `${chars.slice(0, 47).join("").trimEnd()}…` : line;
};

/** Full snapshot fallback while the menu is open; the manifest refreshes unloaded commands. */
const POLL_MS = 10_000;

/**
 * How often a ticking item checks that its entry is still the running one.
 *
 * Tighter than the snapshot poll because this is the number on screen. A
 * timer stopped from a hotkey, the web app or another machine leaves this
 * item counting up on an entry that ended, and a clock that is confidently
 * wrong is worse than one that is a few seconds behind.
 */
const WATCH_MS = 4_000;

/** The live command, where the clock ticks and forms can be pushed. */
const openTimer = (editRunningId?: string): Promise<void> => {
  return launchCommand({
    name: "entries",
    type: LaunchType.UserInitiated,
    context: { showTimer: true, ...(editRunningId ? { editRunningId } : {}) },
  });
};

export default function MenuBar(): React.JSX.Element | null {
  const { showWhenIdle } = getPreferenceValues<Preferences.MenuBar>();
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

  // A menu-bar command is unloaded after a fetch or when its menu closes.
  // Only real requests keep isLoading true; a running timer is not a load.
  const ticking = running !== null;

  // These hooks keep an open menu current. The scheduled command is the
  // fallback once Raycast unloads it, including when the idle item is hidden.
  const now = useNow(ticking);
  usePoll(revalidate, POLL_MS);
  // While loaded, the socket hears changes from every client, including this install.
  const synced = useSyncRevalidate(revalidate, !signedOut);
  // The fallback for a socket that cannot connect at all — a proxy that drops
  // upgrades, a host with no global WebSocket. While one is open it carries
  // every stop already, so polling `entries.current` underneath it would ask
  // a question that has been answered.
  useWatchRunning(running?.id ?? null, ticking && !synced, revalidate, WATCH_MS);
  // The server-level refresh is throttled per origin.
  const { banner } = useServerLevel();

  if (signedOut) {
    return (
      <MenuBarExtra icon={BRAND_MARK} tooltip="Track Your Time — not signed in">
        <MenuBarExtra.Item title="Sign in to Track Your Time" icon={Icon.Key} onAction={() => openTimer()} />
      </MenuBarExtra>
    );
  }

  // A version problem is shown even when idle items are hidden: it is why
  // nothing else here will work.
  if (!running && !isLoading && !isActing && !showWhenIdle && !error && banner === null) return null;

  const elapsed = running ? entryDurationSec(running, now) : 0;
  const clock = formatMenuBarClock(elapsed);
  const label = running ? entryLabel(running) : "";
  const favorites = data?.favorites ?? [];
  const projects = data?.projects ?? [];
  const pinned = running ? favoriteFor(running, favorites) : undefined;
  const pending = data?.pending ?? 0;
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
      title={running ? clock : undefined}
      isLoading={isLoading || isActing}
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
        <MenuBarExtra.Section>
          {/* Section titles are dimmed by macOS. An actionable row keeps the
              timer's name at full contrast and opens the same entry editor. */}
          <MenuBarExtra.Item title={menuText(label)} icon={Icon.Stopwatch} onAction={() => openTimer(running.id)} />
          <MenuBarExtra.Item
            title={`Running for ${formatDurationShort(elapsed)}`}
            subtitle={`since ${formatClock(running.start)}`}
            icon={Icon.Dot}
            onAction={() => openTimer(running.id)}
          />
          {data?.runningWorkspaceName ? (
            <MenuBarExtra.Item
              title={`In ${data.runningWorkspaceName}`}
              icon={Icon.Building}
              onAction={() => openTimer()}
            />
          ) : null}
          {entryHint(running) ? (
            <MenuBarExtra.Item
              title={entryHint(running) ?? ""}
              icon={projectIcon(running.projectColor)}
              onAction={() => openTimer(running.id)}
            />
          ) : null}
          <MenuBarExtra.Item
            title="Stop Timer"
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
            title="Edit Timer…"
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
      ) : (
        <MenuBarExtra.Section title="No timer running">
          <MenuBarExtra.Item
            title="Start Timer"
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
