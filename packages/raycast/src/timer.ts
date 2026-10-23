import { LaunchType, environment, launchCommand, showHUD, updateCommandMetadata } from "@raycast/api";
import { decideTimerToggle, entryDurationSec, toQuickStart, type TimeEntry } from "./vendor/index.js";
import { getTrackYourTime } from "./lib/api.js";
import { pendingCounts } from "./lib/offline.js";
import { formatDurationShort, isoDaysAgo } from "./lib/format.js";
import { noteTimerEcho } from "./lib/storage.js";
import { entryLabel, RECENT_DAYS } from "./lib/timer-data.js";
import { isAlreadyStopped, refreshMenuBar, replacedNotice, showFailureToast } from "./lib/ui.js";
import { ownOnly, resolveUserId } from "./lib/timer-data.js";
import { loadCache } from "./lib/local-cache.js";
import { activeWorkspaceId } from "./lib/workspace.js";
import { isLocalEntry } from "./lib/overlay.js";
import { markTimerAction, timerActionBusy } from "./lib/timer-search.js";

/**
 * The single timer command. User launches toggle tracking; background launches
 * only publish the action and work name in search. Browsing and editing live
 * inside the existing history view, never in a second root timer command.
 */
/**
 * " · queued" when this Mac is holding work no server has seen.
 *
 * The HUD is the only feedback a `no-view` command gets, so the difference
 * between "stopped" and "stopped, and the server does not know yet" has to fit
 * in it. Read after the action rather than inferred from it: a stop can also
 * be queued behind an older row that has nothing to do with this press.
 */
const queuedSuffix = async (): Promise<string> => {
  const { mine } = await pendingCounts();
  return mine > 0 ? ` · ${mine} queued` : "";
};

/** Search metadata is helpful, but a failed update must never block tracking. */
const setSubtitle = async (subtitle: string): Promise<void> => {
  try {
    await updateCommandMetadata({ subtitle });
  } catch {
    // The next background refresh can retry.
  }
};

const showState = async (running: TimeEntry | null): Promise<void> => {
  if (!running) return setSubtitle("Start Timer · No timer running");
  // Catalog ids only name work inside their own workspace. Cached names are
  // optional context, so a cache failure cannot block the actual timer action.
  const cache = await loadCache().catch(() => null);
  const sameWorkspace = (await activeWorkspaceId().catch(() => null)) === running.workspaceId;
  const task = sameWorkspace ? cache?.tasks?.find((row) => row.id === running.taskId)?.name : undefined;
  const project = sameWorkspace ? cache?.projects?.find((row) => row.id === running.projectId)?.name : undefined;
  const name = task?.trim() || running.description.trim().split(/\r?\n/, 1)[0] || project || "Untitled work";
  const chars = Array.from(name);
  const short = chars.length > 48 ? `${chars.slice(0, 47).join("").trimEnd()}…` : name;
  const context = project && project !== name ? ` · ${Array.from(project).slice(0, 32).join("")}` : "";
  await setSubtitle(`Stop Timer · ${short}${context} · ${formatDurationShort(entryDurationSec(running, Date.now()))}`);
};

export default async function Timer(): Promise<void> {
  const background = environment.launchType === LaunchType.Background;
  if (background && (await timerActionBusy())) return;
  if (!background) await markTimerAction(true);
  try {
    const api = await getTrackYourTime();
    const running = await api.current();
    // Scheduled runs only publish status. They must never toggle a timer or open UI.
    if (background) {
      await showState(running);
      return;
    }

    if (running) {
      await noteTimerEcho(null);
      void showHUD("⏹ Stopping timer…");
      try {
        const stopped = await api.stop(running.id);
        await showState(null);
        await showHUD(
          `⏹ Stopped — ${formatDurationShort(stopped.durationSec)}${
            stopped.description ? ` · ${stopped.description}` : ""
          }${await queuedSuffix()}`,
        );
      } catch (error) {
        if (!isAlreadyStopped(error)) {
          await noteTimerEcho(running.id);
          await showState(running);
          throw error;
        }
        // Stopped elsewhere between the read above and the write. The user got
        // the state they pressed for, so say so rather than reporting a
        // failure. `api.stop` threw before it could record the echo, so this
        // clears it — the same repair the Timer view and the menu bar make.
        await noteTimerEcho(null);
        await showState(null);
        await showHUD("⏹ Timer already stopped");
      }
      return;
    }

    // The same window the Timer view and the menu bar call "recent", so the
    // entry a hotkey resumes is the one those surfaces show at the top. The
    // decision is core's `decideTimerToggle`, which the desktop app's global
    // shortcut uses too.
    //
    // Several rows rather than one, and only this person's: in a shared
    // workspace the newest entry can be a colleague's, and the hotkey resumes
    // the work of whoever is pressing it.
    const { entries } = await api.list({
      from: isoDaysAgo(RECENT_DAYS),
      to: new Date().toISOString(),
      limit: 20,
    });
    const decision = decideTimerToggle({
      running: false,
      candidates: ownOnly(entries, await resolveUserId()),
      startOf: (entry) => entry.start,
      isFinished: (entry) => entry.end !== null,
      nowMs: Date.now(),
      days: RECENT_DAYS,
    });

    if (decision.kind !== "continue") {
      const entry = await api.start({ description: "" });
      await showState(entry);
      if (!isLocalEntry(entry)) {
        await launchCommand({
          name: "entries",
          type: LaunchType.UserInitiated,
          context: { showTimer: true, editRunningId: entry.id },
        });
      } else {
        await showHUD(`▶ Timer started${await queuedSuffix()}`);
      }
      return;
    }
    const last = decision.candidate;

    void showHUD(`▶ Starting — ${entryLabel(last)}…`);
    const started = await api.continue(last.id, toQuickStart(last));
    await showState(started);
    // Labelled from the entry that was continued, not from the one that came
    // back: the list rows are joined with their project and client names, so
    // an entry with no description still reads as something.
    const replaced = replacedNotice(started);
    await showHUD(`▶ Started — ${entryLabel(last)}${replaced ? ` · ${replaced}` : ""}${await queuedSuffix()}`);
  } catch (error) {
    if (background) {
      await setSubtitle("Timer status unavailable · Open Timer to check");
      return;
    }
    await showFailureToast(error, "Could not toggle the timer");
  } finally {
    if (!background) {
      await markTimerAction(false);
      await refreshMenuBar(false);
    }
  }
}
