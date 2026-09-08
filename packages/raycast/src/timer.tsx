import {
  Action,
  ActionPanel,
  Alert,
  Color,
  Icon,
  List,
  Toast,
  confirmAlert,
  showToast,
} from "@raycast/api";
import {
  entryDurationSec,
  formatDuration,
  quickStartHint,
  quickStartLabel,
  repairQuickStart,
  toQuickStart,
  type DetailedEntry,
  type DetailedFavorite,
} from "@starter/core";
import { EditEntry } from "./components/edit-entry.js";
import { LogTime } from "./components/log-time.js";
import { SignedOutView } from "./components/signed-out.js";
import { SignIn } from "./components/sign-in.js";
import { StartTimer } from "./components/start-timer.js";
import { getTracktime, type ProjectWithStats } from "./lib/api.js";
import { discardForeign, listForeign } from "./lib/offline.js";
import { isLocalEntry } from "./lib/overlay.js";
import {
  formatClock,
  formatDayHeading,
  formatDurationShort,
  projectIcon,
} from "./lib/format.js";
import { useApi, useNow, useReconciledRunning } from "./lib/hooks.js";
import { webLink } from "./lib/preferences.js";
import {
  RECENT_DAYS,
  entryHint,
  entryLabel,
  favoriteFor,
  loadTimerSnapshot,
} from "./lib/timer-data.js";
import { useSyncRevalidate } from "./lib/sync.js";
import { noteTimerEcho } from "./lib/storage.js";
import {
  isAlreadyStopped,
  refreshMenuBar,
  showFailureToast,
} from "./lib/ui.js";

/** Long enough to cover a normal week of work without a scroll marathon. */
const RECENT_LIMIT = 8;

/**
 * How many of another account's queued rows the discard dialog names.
 *
 * Enough to recognise the work; past that the list stops being read and the
 * dialog stops being a decision. The rest are counted.
 */
const MAX_NAMED_FOREIGN = 5;

/**
 * The live timer surface: what is running, ticking by the second, with
 * everything that changes it one keystroke away.
 *
 * The menu bar is the glanceable version of this and only re-renders on its
 * interval; this one is open in front of the user, so it counts properly.
 */
export default function Timer(): React.JSX.Element {
  const { data, isLoading, signedOut, revalidate } = useApi("timer", (api) =>
    loadTimerSnapshot(api, { recentLimit: RECENT_LIMIT }),
  );

  // Reconciled against this Mac's timer echo, so a stop made from the menu
  // bar a moment ago is gone from this list before any refetch lands.
  const running = useReconciledRunning(data, revalidate);
  // Only a running timer moves; a stopped one would re-render the same string
  // forever. Today's total is live for the same reason — it contains it.
  const now = useNow(running !== null);
  // Open in front of the user, so it is the surface where a change made
  // elsewhere is most obviously wrong to miss.
  useSyncRevalidate(revalidate, !signedOut);

  const run = async (
    action: () => Promise<string>,
    failureTitle: string,
  ): Promise<void> => {
    try {
      const message = await action();
      await refreshMenuBar();
      revalidate();
      await showToast({ style: Toast.Style.Success, title: message });
    } catch (error) {
      // Already stopped somewhere else — the outcome the user asked for.
      if (isAlreadyStopped(error)) {
        await noteTimerEcho(null);
        await refreshMenuBar();
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

  const stop = (entry: DetailedEntry): Promise<void> =>
    run(async () => {
      const api = await getTracktime();
      const stopped = await api.stop(entry.id);
      return `Stopped — ${formatDurationShort(stopped.durationSec)}`;
    }, "Could not stop the timer");

  const discard = async (entry: DetailedEntry): Promise<void> => {
    const confirmed = await confirmAlert({
      title: "Discard this timer?",
      message: `${entryLabel(entry)} — ${formatDurationShort(
        entryDurationSec(entry, Date.now()),
      )} will not be kept.`,
      icon: Icon.Trash,
      primaryAction: { title: "Discard", style: Alert.ActionStyle.Destructive },
    });
    if (!confirmed) return;

    await run(async () => {
      const api = await getTracktime();
      await api.discard(entry.id);
      return "Timer discarded";
    }, "Could not discard the timer");
  };

  /**
   * File the running timer without leaving the list. Changing or dropping the
   * project orphans whatever task was set, so the task goes with it — a task
   * only exists inside one project.
   */
  const fileUnder = (
    entry: DetailedEntry,
    project: ProjectWithStats | null,
  ): Promise<void> =>
    run(async () => {
      const api = await getTracktime();
      // The task is left alone: moving an entry to another project does not
      // revise what the work was.
      await api.update({ id: entry.id, projectId: project?.id ?? null });
      return project ? `Moved to ${project.name}` : "Project cleared";
    }, "Could not change the project");

  const togglePin = (
    entry: DetailedEntry,
    pinned: DetailedFavorite | undefined,
  ): Promise<void> =>
    run(async () => {
      const api = await getTracktime();
      if (pinned) {
        await api.removeFavorite(pinned.id);
        return "Favorite removed";
      }
      await api.addFavorite(toQuickStart(entry));
      return "Pinned as a favorite";
    }, "Could not update favorites");

  if (signedOut) return <SignedOutView />;

  const elapsed = running ? entryDurationSec(running, now) : 0;
  const todaySec = data?.todaySec ?? 0;
  const pending = data?.pending ?? 0;
  const foreign = data?.foreign ?? 0;
  const favorites = data?.favorites ?? [];
  const projects = data?.projects ?? [];
  const recent = data?.recent ?? [];

  /**
   * The only way to delete unsynced time from here, and it names what is
   * going before it goes.
   *
   * Rows another account queued are kept and never replayed, both on purpose —
   * which together makes them immortal, and a count nobody can act on is worse
   * than saying nothing. The confirmation lists the work rather than counting
   * it, because "discard 3 changes" is not a decision anybody can make.
   */
  const discardForeignWork = (): void => {
    void (async () => {
      const rows = await listForeign();
      if (rows.length === 0) {
        revalidate();
        return;
      }

      const named = rows
        .slice(0, MAX_NAMED_FOREIGN)
        .map(
          (row) =>
            `${row.description?.trim() || "No description"} — ${formatDayHeading(row.at)}`,
        );
      const rest = rows.length - named.length;

      const confirmed = await confirmAlert({
        title: `Discard ${rows.length} change${rows.length === 1 ? "" : "s"}?`,
        message: [
          ...named,
          ...(rest > 0 ? [`…and ${rest} more`] : []),
          "",
          "This work was tracked on this Mac and has never reached a server. It cannot be recovered.",
        ].join("\n"),
        icon: Icon.Trash,
        primaryAction: {
          title: "Discard",
          style: Alert.ActionStyle.Destructive,
        },
      });
      if (!confirmed) return;

      const dropped = await discardForeign();
      revalidate();
      await showToast({
        style: Toast.Style.Success,
        title: `Discarded ${dropped} change${dropped === 1 ? "" : "s"}`,
      });
    })();
  };

  const onSaved = (): void => {
    revalidate();
    void refreshMenuBar();
  };

  /** Shared tail of every row's panel — never the primary action. */
  const commonActions = (
    <ActionPanel.Section>
      <Action.OpenInBrowser
        title="Open Web App"
        url={webLink("/track")}
        shortcut={{ modifiers: ["cmd"], key: "o" }}
      />
      <Action
        title="Refresh"
        icon={Icon.ArrowClockwise}
        shortcut={{ modifiers: ["cmd"], key: "r" }}
        onAction={revalidate}
      />
      {/* The only way to see or drop this Mac's session now that pairing has
          no command of its own. Signed in, `SignIn` opens on its paired
          screen and pairs nothing. */}
      <Action.Push
        title="Account and Session…"
        icon={Icon.Person}
        shortcut={{ modifiers: ["cmd", "shift"], key: "a" }}
        target={<SignIn />}
      />
    </ActionPanel.Section>
  );

  const startForm = (
    <Action.Push
      title="Start New Timer…"
      icon={Icon.Plus}
      shortcut={{ modifiers: ["cmd"], key: "n" }}
      target={<StartTimer />}
    />
  );

  /* Work that was never timed. Alongside Start rather than hidden behind the
     web app, because remembering a meeting you forgot to time is exactly the
     errand a launcher is open for. */
  const logForm = (
    <Action.Push
      title="Log Past Time…"
      icon={Icon.Clock}
      shortcut={{ modifiers: ["cmd", "shift"], key: "n" }}
      target={<LogTime onSaved={onSaved} />}
    />
  );

  const runningAccessories = (
    entry: DetailedEntry,
  ): List.Item.Accessory[] => {
    const accessories: List.Item.Accessory[] = [];

    // A timer started with no signal has no server id yet. Saying so is what
    // keeps "the clock is running" from being read as "the server has it".
    if (isLocalEntry(entry)) {
      accessories.push({
        icon: { source: Icon.Cloud, tintColor: Color.Orange },
        tooltip: "Not synced yet — kept on this Mac",
      });
    }

    if (entry.billable) {
      accessories.push({
        icon: { source: Icon.BankNote, tintColor: Color.Green },
        tooltip: "Billable",
      });
    }

    accessories.push({ text: `since ${formatClock(entry.start)}` });
    // Seconds, not "1h 3m": this row is the reason the command exists, and a
    // clock that visibly moves is what proves the timer is really running.
    accessories.push({
      tag: { value: formatDuration(elapsed, "hms"), color: Color.Green },
    });

    return accessories;
  };

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Filter favorites and recent work…"
      actions={
        <ActionPanel>
          {startForm}
          {logForm}
          {commonActions}
        </ActionPanel>
      }
    >
      <List.EmptyView
        icon={Icon.Clock}
        title="Nothing tracked yet"
        description={`No timer running, and nothing in the last ${RECENT_DAYS} days.`}
        actions={
          <ActionPanel>
            {startForm}
            {logForm}
            {commonActions}
          </ActionPanel>
        }
      />

      {/* Stated rather than hidden: what is queued is time the user tracked,
          and a client holding it quietly looks like one that lost it. */}
      {pending > 0 || foreign > 0 ? (
        <List.Section title="Not synced">
          {pending > 0 ? (
            <List.Item
              icon={{ source: Icon.Cloud, tintColor: Color.Orange }}
              title={`${pending} change${pending === 1 ? "" : "s"} waiting to sync`}
              subtitle="Kept on this Mac until the server answers"
              actions={
                <ActionPanel>
                  <Action
                    title="Try Again"
                    icon={Icon.ArrowClockwise}
                    onAction={revalidate}
                  />
                  {commonActions}
                </ActionPanel>
              }
            />
          ) : null}
          {foreign > 0 ? (
            <List.Item
              icon={{ source: Icon.Person, tintColor: Color.SecondaryText }}
              title={`${foreign} queued by another account`}
              subtitle="Sign in as that account to send them, or discard them"
              actions={
                <ActionPanel>
                  <Action.Push
                    title="Account and Session…"
                    icon={Icon.Person}
                    target={<SignIn />}
                  />
                  <Action
                    title="Discard Them…"
                    icon={Icon.Trash}
                    style={Action.Style.Destructive}
                    onAction={discardForeignWork}
                  />
                  {commonActions}
                </ActionPanel>
              }
            />
          ) : null}
        </List.Section>
      ) : null}

      {running ? (
        <List.Section
          title="Running"
          subtitle={`today ${formatDurationShort(todaySec)}`}
        >
          <List.Item
            icon={projectIcon(running.projectColor)}
            title={entryLabel(running)}
            subtitle={entryHint(running)}
            accessories={runningAccessories(running)}
            actions={
              <ActionPanel>
                <ActionPanel.Section>
                  <Action
                    title="Stop Timer"
                    icon={Icon.Stop}
                    onAction={() => stop(running)}
                  />
                  <Action.Push
                    title="Edit Timer…"
                    icon={Icon.Pencil}
                    shortcut={{ modifiers: ["cmd"], key: "e" }}
                    target={<EditEntry entry={running} onSaved={onSaved} />}
                  />
                  <ActionPanel.Submenu
                    title="Move to Project…"
                    icon={Icon.Folder}
                    shortcut={{ modifiers: ["cmd"], key: "p" }}
                  >
                    {projects.map((project) => (
                      <Action
                        key={project.id}
                        title={
                          project.clientName
                            ? `${project.name} — ${project.clientName}`
                            : project.name
                        }
                        icon={projectIcon(project.color)}
                        onAction={() => fileUnder(running, project)}
                      />
                    ))}
                    <Action
                      title="No Project"
                      icon={Icon.Circle}
                      onAction={() => fileUnder(running, null)}
                    />
                  </ActionPanel.Submenu>
                  <Action
                    title={
                      favoriteFor(running, favorites)
                        ? "Remove Favorite"
                        : "Pin as Favorite"
                    }
                    icon={Icon.Star}
                    shortcut={{ modifiers: ["cmd"], key: "f" }}
                    onAction={() =>
                      togglePin(running, favoriteFor(running, favorites))
                    }
                  />
                </ActionPanel.Section>

                <ActionPanel.Section>
                  {startForm}
                  {logForm}
                  <Action.CopyToClipboard
                    title="Copy Description"
                    content={entryLabel(running)}
                    shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
                  />
                </ActionPanel.Section>

                {commonActions}

                <ActionPanel.Section>
                  <Action
                    title="Discard Timer"
                    icon={Icon.Trash}
                    style={Action.Style.Destructive}
                    shortcut={{ modifiers: ["cmd", "shift"], key: "backspace" }}
                    onAction={() => discard(running)}
                  />
                </ActionPanel.Section>
              </ActionPanel>
            }
          />
        </List.Section>
      ) : (
        <List.Section
          title="No timer running"
          subtitle={`today ${formatDurationShort(todaySec)}`}
        >
          <List.Item
            icon={Icon.Play}
            title="Start a New Timer…"
            subtitle="Describe it, file it, and go"
            actions={
              <ActionPanel>
                {startForm}
                {logForm}
                {commonActions}
              </ActionPanel>
            }
          />
        </List.Section>
      )}

      {favorites.length > 0 ? (
        <List.Section title="Favorites">
          {favorites.map((favorite) => (
            <List.Item
              key={favorite.id}
              icon={{ source: Icon.Star, tintColor: Color.Yellow }}
              title={quickStartLabel(favorite)}
              subtitle={quickStartHint(favorite) ?? undefined}
              actions={
                <ActionPanel>
                  <ActionPanel.Section>
                    <Action
                      title="Start Timer"
                      icon={Icon.Play}
                      onAction={() =>
                        run(async () => {
                          const api = await getTracktime();
                          await api.startQuick(repairQuickStart(favorite));
                          return `Started — ${quickStartLabel(favorite)}`;
                        }, "Could not start the timer")
                      }
                    />
                    <Action
                      title="Remove Favorite"
                      icon={Icon.StarDisabled}
                      shortcut={{ modifiers: ["cmd"], key: "f" }}
                      onAction={() =>
                        run(async () => {
                          const api = await getTracktime();
                          await api.removeFavorite(favorite.id);
                          return "Favorite removed";
                        }, "Could not remove the favorite")
                      }
                    />
                  </ActionPanel.Section>
                  {commonActions}
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      ) : null}

      {recent.length > 0 ? (
        <List.Section title="Continue">
          {recent.map((entry) => (
            <List.Item
              key={entry.id}
              icon={projectIcon(entry.projectColor)}
              title={entryLabel(entry)}
              subtitle={entryHint(entry)}
              accessories={[
                { text: formatClock(entry.start) },
                {
                  tag: {
                    value: formatDurationShort(entryDurationSec(entry, now)),
                    color: Color.SecondaryText,
                  },
                },
              ]}
              actions={
                <ActionPanel>
                  <ActionPanel.Section>
                    <Action
                      title="Continue Entry"
                      icon={Icon.Play}
                      onAction={() =>
                        run(async () => {
                          const api = await getTracktime();
                          await api.continue(entry.id, toQuickStart(entry));
                          return `Started — ${entryLabel(entry)}`;
                        }, "Could not start the timer")
                      }
                    />
                    <Action.Push
                      title="Edit Entry…"
                      icon={Icon.Pencil}
                      shortcut={{ modifiers: ["cmd"], key: "e" }}
                      target={<EditEntry entry={entry} onSaved={onSaved} />}
                    />
                    <Action
                      title={
                        favoriteFor(entry, favorites)
                          ? "Remove Favorite"
                          : "Pin as Favorite"
                      }
                      icon={Icon.Star}
                      shortcut={{ modifiers: ["cmd"], key: "f" }}
                      onAction={() =>
                        togglePin(entry, favoriteFor(entry, favorites))
                      }
                    />
                  </ActionPanel.Section>
                  {commonActions}
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      ) : null}
    </List>
  );
}
