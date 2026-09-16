import {
  Icon,
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
  quickStartHint,
  quickStartLabel,
  repairQuickStart,
  toQuickStart,
  type DetailedEntry,
} from "./vendor/index.js";
import { getTrackYourTime, type ProjectWithStats } from "./lib/api.js";
import { CompatibilityMenuBarSection } from "./components/compatibility-banner.js";
import { BRAND_MARK } from "./lib/brand.js";
import { formatClock, formatDurationShort, formatMenuBarClock, formatMenuBarTotal } from "./lib/format.js";
import { useApi, useNow, usePoll, useReconciledRunning, useWatchRunning } from "./lib/hooks.js";
import { heldCopy } from "./lib/offline.js";
import { webLink } from "./lib/preferences.js";
import { entryHint, entryLabel, favoriteFor, loadTimerSnapshot } from "./lib/timer-data.js";
import { useServerLevel } from "./lib/server-level.js";
import { useSyncRevalidate } from "./lib/sync.js";
import { noteTimerEcho } from "./lib/storage.js";
import { describeFailure, isAlreadyStopped, replacedNotice, showFailureToast } from "./lib/ui.js";

/** A dropdown is a glance, not a browser — six rows is already a lot. */
const RECENT_LIMIT = 6;

/**
 * How often the item re-reads the whole snapshot.
 *
 * The clock itself does not need this — it counts up locally from the running
 * entry's start. This is about the rest of the dropdown: favorites, recents,
 * today's total. Well below the `interval` in the manifest, which exists for
 * the case where this process is no longer alive at all.
 */
const POLL_MS = 20_000;

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
const openTimer = (): void => {
  void launchCommand({ name: "timer", type: LaunchType.UserInitiated });
};

export default function MenuBar(): React.JSX.Element | null {
  const { titleMode, idleTitle, hideWhenIdle, tickSeconds } = getPreferenceValues<Preferences.MenuBar>();
  const { data, isLoading, error, signedOut, revalidate } = useApi("menu-bar", (api) =>
    loadTimerSnapshot(api, { recentLimit: RECENT_LIMIT }),
  );

  /**
   * What is running, after this Mac's own timer echo is applied.
   *
   * `data` can be a cached snapshot from before the last stop — Raycast paints
   * the cache first, and a still-loaded menu bar command is not remounted by
   * `refreshMenuBar()`. Reconciling against the echo is what stops the item
   * ticking a timer the user ended a second ago in another command.
   */
  const running = useReconciledRunning(data, revalidate);

  /**
   * Whether this item is currently a clock rather than a label.
   *
   * Raycast unloads a menu bar command the moment its first render settles,
   * and an unloaded command's `setInterval` never fires again — which is why
   * the title used to be minutes, honest at a one-minute refresh and wrong in
   * between. The one thing that keeps the process alive is an unfinished
   * load, so an item that ticks says it is loading for as long as it ticks,
   * and stops claiming that the second the timer stops.
   */
  const ticking = tickSeconds && running !== null;

  // Both hooks run on every render, before any of the early returns below:
  // React requires it, and the poll has to keep running precisely in the
  // states where the item shows nothing — a hidden idle item is how a timer
  // started in the web app would otherwise go unnoticed.
  const now = useNow(ticking);
  usePoll(revalidate, POLL_MS);
  // While the item ticks it is a live process, so it can hold the sync socket
  // and hear a stop made in the web app or on another machine at once.
  const synced = useSyncRevalidate(revalidate, !signedOut);
  // The fallback for a socket that cannot connect at all — a proxy that drops
  // upgrades, a host with no global WebSocket. While one is open it carries
  // every stop already, so polling `entries.current` underneath it would ask
  // a question that has been answered.
  useWatchRunning(running?.id ?? null, ticking && !synced, revalidate, WATCH_MS);
  // The command runs every minute; the refresh inside is throttled per origin.
  const { banner } = useServerLevel();

  if (signedOut) {
    return (
      <MenuBarExtra icon={BRAND_MARK} tooltip="Track Your Time — not signed in">
        <MenuBarExtra.Item title="Sign In to Track Your Time" icon={Icon.Key} onAction={openTimer} />
      </MenuBarExtra>
    );
  }

  // A version problem is shown even when idle items are hidden: it is why
  // nothing else here will work.
  if (!running && !isLoading && hideWhenIdle && banner === null) return null;

  const elapsed = running ? entryDurationSec(running, now) : 0;
  const clock = formatMenuBarClock(elapsed);
  const label = running ? entryLabel(running) : "";
  const favorites = data?.favorites ?? [];
  const projects = data?.projects ?? [];
  const pinned = running ? favoriteFor(running, favorites) : undefined;
  const pending = data?.pending ?? 0;
  const foreign = data?.foreign ?? 0;

  const title = ((): string | undefined => {
    // Idle and running are separate settings because they answer separate
    // questions. `titleMode` is about how much of a running timer to show;
    // this is about whether an idle menu bar should carry a number at all.
    // Default is the bare mark: the total sat there looking like a running
    // clock, and a tracker that is not tracking has nothing urgent to say.
    // "Start timer" is for anyone who wants the item to read as a button,
    // and the total stays available for anyone who was using it.
    if (!running) {
      if (idleTitle === "prompt") return "Start timer";
      if (idleTitle === "total") return formatMenuBarTotal(data?.todaySec ?? 0);
      return undefined;
    }

    if (titleMode === "icon") return undefined;
    if (titleMode === "duration") return clock;
    if (titleMode === "description") return label;
    return `${label} · ${clock}`;
  })();

  const act = async (run: () => Promise<void>, failureTitle: string): Promise<void> => {
    try {
      await run();
      revalidate();
    } catch (error) {
      // Somebody stopped it elsewhere between this item's last read and the
      // click. The user got what they wanted; record it and move on rather
      // than reporting a failure for a state that is already correct.
      if (isAlreadyStopped(error)) {
        await noteTimerEcho(null);
        revalidate();
        await showToast({
          style: Toast.Style.Success,
          title: "Timer already stopped",
        });
        return;
      }
      await showFailureToast(error, failureTitle);
    }
  };

  /**
   * File the running timer from the menu bar. The task is cleared with the
   * project because a task only exists inside one — keeping it would leave
   * the entry pointing at a task from a project it is no longer in.
   */
  const fileUnder = (entry: DetailedEntry, project: ProjectWithStats | null): void => {
    void act(async () => {
      const api = await getTrackYourTime();
      // The task is left alone: moving an entry to another project does not
      // revise what the work was.
      await api.update({ id: entry.id, projectId: project?.id ?? null });
      await showToast({
        style: Toast.Style.Success,
        title: project ? `Moved to ${project.name}` : "Project cleared",
      });
    }, "Could not change the project");
  };

  return (
    <MenuBarExtra
      icon={BRAND_MARK}
      title={title}
      isLoading={ticking || isLoading}
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
        <MenuBarExtra.Section title={label}>
          {/* Same clock as the title, spelled out rather than abbreviated. */}
          <MenuBarExtra.Item
            title={`Running for ${formatDurationShort(elapsed)}`}
            subtitle={`since ${formatClock(running.start)}`}
            icon={Icon.Dot}
            onAction={openTimer}
          />
          {data?.runningWorkspaceName ? (
            <MenuBarExtra.Item title={`In ${data.runningWorkspaceName}`} icon={Icon.Building} onAction={openTimer} />
          ) : null}
          {entryHint(running) ? (
            <MenuBarExtra.Item title={entryHint(running) ?? ""} icon={Icon.Folder} onAction={openTimer} />
          ) : null}
          <MenuBarExtra.Item
            title="Stop Timer"
            icon={Icon.Stop}
            shortcut={{ modifiers: ["cmd"], key: "s" }}
            onAction={() => {
              void act(async () => {
                const api = await getTrackYourTime();
                const stopped = await api.stop();
                await showToast({
                  style: Toast.Style.Success,
                  title: "Timer stopped",
                  message: formatDurationShort(stopped.durationSec),
                });
              }, "Could not stop the timer");
            }}
          />
          {/* A menu bar item cannot host a form, so editing hands off to the
              Timer command, which opens on the running entry. */}
          <MenuBarExtra.Item
            title="Edit Timer…"
            icon={Icon.Pencil}
            shortcut={{ modifiers: ["cmd"], key: "e" }}
            onAction={openTimer}
          />
          <MenuBarExtra.Submenu title="Move to Project" icon={Icon.Folder}>
            {projects.map((project) => (
              <MenuBarExtra.Item
                key={project.id}
                title={project.name}
                subtitle={project.clientName ?? undefined}
                icon={{ source: Icon.CircleFilled, tintColor: project.color }}
                onAction={() => fileUnder(running, project)}
              />
            ))}
            <MenuBarExtra.Item title="No Project" icon={Icon.Circle} onAction={() => fileUnder(running, null)} />
          </MenuBarExtra.Submenu>
          <MenuBarExtra.Item
            title={pinned ? "Remove Favorite" : "Pin as Favorite"}
            icon={pinned ? Icon.StarDisabled : Icon.Star}
            shortcut={{ modifiers: ["cmd"], key: "f" }}
            onAction={() => {
              void act(async () => {
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
              void act(async () => {
                const api = await getTrackYourTime();
                await api.discard();
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
            title="Start Timer…"
            icon={Icon.Play}
            shortcut={{ modifiers: ["cmd"], key: "n" }}
            onAction={openTimer}
          />
        </MenuBarExtra.Section>
      )}

      {/* Pins first, and above Continue: they are the whole point of pinning.
          Started through `startQuick`, which is `entries.start` with the
          favorite's own fields — the same path every other client uses. */}
      {favorites.length > 0 ? (
        <MenuBarExtra.Section title="Favorites">
          {favorites.map((favorite) => (
            <MenuBarExtra.Item
              key={favorite.id}
              title={quickStartLabel(favorite)}
              subtitle={quickStartHint(favorite) ?? undefined}
              icon={Icon.Star}
              onAction={() => {
                void act(async () => {
                  const api = await getTrackYourTime();
                  const started = await api.startQuick(repairQuickStart(favorite));
                  await showToast({
                    style: Toast.Style.Success,
                    title: "Timer started",
                    message: [quickStartLabel(favorite), replacedNotice(started)].filter(Boolean).join(" · "),
                  });
                }, "Could not start the timer");
              }}
            />
          ))}
        </MenuBarExtra.Section>
      ) : null}

      {data && data.recent.length > 0 ? (
        <MenuBarExtra.Section title="Continue">
          {data.recent.map((entry) => (
            <MenuBarExtra.Item
              key={entry.id}
              title={entryLabel(entry)}
              subtitle={entry.projectName ?? undefined}
              icon={Icon.ArrowClockwise}
              onAction={() => {
                void act(async () => {
                  const api = await getTrackYourTime();
                  const started = await api.continue(entry.id, toQuickStart(entry));
                  await showToast({
                    style: Toast.Style.Success,
                    title: "Timer started",
                    message: [entryLabel(entry), replacedNotice(started)].filter(Boolean).join(" · "),
                  });
                }, "Could not start the timer");
              }}
            />
          ))}
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
              onAction={openTimer}
            />
          ) : null}
          {(data?.held ?? 0) > 0 ? (
            <MenuBarExtra.Item
              title={heldCopy(data?.held ?? 0, data?.heldReason ?? null).title}
              subtitle="Kept — open the Timer to review"
              icon={Icon.Hourglass}
              onAction={openTimer}
            />
          ) : null}
        </MenuBarExtra.Section>
      ) : null}

      <MenuBarExtra.Section title={`Today · ${formatDurationShort(data?.todaySec ?? 0)}`}>
        <MenuBarExtra.Item
          title="Timer…"
          icon={Icon.Stopwatch}
          shortcut={{ modifiers: ["cmd"], key: "t" }}
          onAction={openTimer}
        />
        <MenuBarExtra.Item
          title="Show All Time…"
          icon={Icon.List}
          onAction={() => {
            void launchCommand({
              name: "entries",
              type: LaunchType.UserInitiated,
            });
          }}
        />
        <MenuBarExtra.Item
          title="Open Dashboard"
          icon={Icon.Globe}
          onAction={() => {
            void open(webLink("/app/track"));
          }}
        />
        <MenuBarExtra.Item
          title="Refresh"
          icon={Icon.ArrowClockwise}
          shortcut={{ modifiers: ["cmd"], key: "r" }}
          onAction={revalidate}
        />
      </MenuBarExtra.Section>
    </MenuBarExtra>
  );
}
