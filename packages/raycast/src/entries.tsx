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
  toQuickStart,
  type DetailedEntry,
} from "@starter/core";
import { getTrackYourTime } from "./lib/api.js";
import { isLocalEntry } from "./lib/overlay.js";
import {
  formatClock,
  formatDayHeading,
  formatDurationShort,
  isoDaysAgo,
  projectIcon,
} from "./lib/format.js";
import { useApi } from "./lib/hooks.js";
import { webLink } from "./lib/preferences.js";
import { refreshMenuBar, showFailureToast } from "./lib/ui.js";
import { EditEntry } from "./components/edit-entry.js";
import { LogTime } from "./components/log-time.js";
import { SignedOutView } from "./components/signed-out.js";

/** Window the list covers. Anything older belongs in the web app's reports. */
const HISTORY_DAYS = 14;

const label = (entry: DetailedEntry): string =>
  entry.description.trim() || entry.projectName || "No description";

/** Day heading → its entries, newest day first (the API already sorts). */
const byDay = (entries: DetailedEntry[]): [string, DetailedEntry[]][] => {
  const groups = new Map<string, DetailedEntry[]>();
  for (const entry of entries) {
    const heading = formatDayHeading(entry.start);
    const bucket = groups.get(heading);
    if (bucket) bucket.push(entry);
    else groups.set(heading, [entry]);
  }
  return [...groups.entries()];
};

const dayTotal = (entries: DetailedEntry[], nowMs: number): number =>
  entries.reduce((total, entry) => total + entryDurationSec(entry, nowMs), 0);

/**
 * Row accessories, right to left: duration tag, clock range, billable mark.
 *
 * Built conditionally rather than with placeholder objects — an empty
 * accessory still reserves a slot, which is what makes a Raycast list look
 * ragged instead of aligned.
 */
/** At most this many tag chips per row; the rest collapse into "+N". */
const MAX_TAG_ACCESSORIES = 2;

const accessoriesFor = (
  entry: DetailedEntry,
  nowMs: number,
  /** Tag names by id. Empty until `tags.list` settles, which only delays chips. */
  tagNames: ReadonlyMap<string, string>,
): List.Item.Accessory[] => {
  const running = entry.end === null;
  const accessories: List.Item.Accessory[] = [];

  // Tracked here and nowhere else yet. Worth a mark of its own: the row is
  // otherwise indistinguishable from one the server has, and the difference
  // decides whether this Mac is the only copy of it.
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

  // `DetailedEntry` carries only `tagIds`, so the names come from the tag
  // catalog this command already loads. An id it cannot name is skipped
  // rather than shown raw — an archived tag is absent from that list.
  const named = entry.tagIds
    .map((id) => tagNames.get(id))
    .filter((name): name is string => name !== undefined);

  // Capped: a Raycast row has a fixed width, and an entry with six tags would
  // push the clock range and the duration off the end of it.
  for (const name of named.slice(0, MAX_TAG_ACCESSORIES)) {
    accessories.push({ tag: { value: name, color: Color.SecondaryText } });
  }
  if (named.length > MAX_TAG_ACCESSORIES) {
    accessories.push({
      tag: {
        value: `+${named.length - MAX_TAG_ACCESSORIES}`,
        color: Color.SecondaryText,
      },
      tooltip: named.join(", "),
    });
  }

  accessories.push({
    text: running
      ? "running"
      : `${formatClock(entry.start)}–${formatClock(entry.end ?? entry.start)}`,
  });

  accessories.push({
    tag: {
      value: formatDurationShort(entryDurationSec(entry, nowMs)),
      color: running ? Color.Green : Color.SecondaryText,
    },
  });

  return accessories;
};

export default function Entries(): React.JSX.Element {
  const now = Date.now();
  const { data, isLoading, signedOut, revalidate } = useApi(
    "entries",
    async (api) => {
      const { entries } = await api.list({
        from: isoDaysAgo(HISTORY_DAYS),
        to: new Date(Date.now() + 60_000).toISOString(),
        limit: 200,
      });
      return entries;
    },
  );

  const tags = useApi("tags", (api) => api.tags());
  const tagNames = new Map(
    (tags.data ?? []).map((tag) => [tag.id, tag.name] as const),
  );

  if (signedOut) return <SignedOutView />;

  const entries = data ?? [];

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
      await showFailureToast(error, failureTitle);
    }
  };

  const remove = async (entry: DetailedEntry): Promise<void> => {
    const confirmed = await confirmAlert({
      title: "Delete this entry?",
      message: `${label(entry)} — ${formatDurationShort(
        entryDurationSec(entry, Date.now()),
      )}`,
      icon: Icon.Trash,
      primaryAction: {
        title: "Delete",
        style: Alert.ActionStyle.Destructive,
      },
    });
    if (!confirmed) return;

    await run(async () => {
      const api = await getTrackYourTime();
      await api.remove(entry.id);
      return "Entry deleted";
    }, "Could not delete the entry");
  };

  /* The one entry this list cannot otherwise produce: a block of work that
     was never timed. Same form the Timer command opens. */
  const logTime = (
    <Action.Push
      title="Log Past Time…"
      icon={Icon.Plus}
      shortcut={{ modifiers: ["cmd", "shift"], key: "n" }}
      target={<LogTime onSaved={revalidate} />}
    />
  );

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Search recent entries…"
      actions={
        <ActionPanel>
          {logTime}
          <Action.OpenInBrowser title="Open Web App" url={webLink("/track")} />
        </ActionPanel>
      }
    >
      <List.EmptyView
        icon={Icon.Clock}
        title="No entries yet"
        description={`Nothing tracked in the last ${HISTORY_DAYS} days.`}
      />

      {byDay(entries).map(([heading, group]) => (
        <List.Section
          key={heading}
          title={heading}
          subtitle={formatDurationShort(dayTotal(group, now))}
        >
          {group.map((entry) => {
            const running = entry.end === null;

            return (
              <List.Item
                key={entry.id}
                icon={projectIcon(entry.projectColor)}
                title={label(entry)}
                subtitle={
                  [entry.projectName, entry.taskName]
                    .filter(Boolean)
                    .join(" › ") || undefined
                }
                accessories={accessoriesFor(entry, now, tagNames)}
                actions={
                  <ActionPanel>
                    <ActionPanel.Section>
                      {running ? (
                        <Action
                          title="Stop Timer"
                          icon={Icon.Stop}
                          onAction={() =>
                            run(async () => {
                              const api = await getTrackYourTime();
                              await api.stop(entry.id);
                              return "Timer stopped";
                            }, "Could not stop the timer")
                          }
                        />
                      ) : (
                        <Action
                          title="Continue Entry"
                          icon={Icon.Play}
                          onAction={() =>
                            run(async () => {
                              const api = await getTrackYourTime();
                              await api.continue(entry.id, toQuickStart(entry));
                              return "Timer started";
                            }, "Could not start the timer")
                          }
                        />
                      )}
                      <Action.Push
                        title="Edit Entry"
                        icon={Icon.Pencil}
                        shortcut={{ modifiers: ["cmd"], key: "e" }}
                        target={
                          <EditEntry entry={entry} onSaved={revalidate} />
                        }
                      />
                    </ActionPanel.Section>

                    <ActionPanel.Section>
                      {logTime}
                      <Action.CopyToClipboard
                        title="Copy Description"
                        content={label(entry)}
                        shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
                      />
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
                    </ActionPanel.Section>

                    <ActionPanel.Section>
                      <Action
                        title="Delete Entry"
                        icon={Icon.Trash}
                        style={Action.Style.Destructive}
                        shortcut={{ modifiers: ["ctrl"], key: "x" }}
                        onAction={() => remove(entry)}
                      />
                    </ActionPanel.Section>
                  </ActionPanel>
                }
              />
            );
          })}
        </List.Section>
      ))}
    </List>
  );
}
