import { LaunchType, environment, launchCommand, showHUD, updateCommandMetadata } from "@raycast/api";
import { decideTimerToggle, entryDurationSec, toQuickStart, type TimeEntry } from "./vendor/index.js";
import { getTrackYourTime } from "./lib/api.js";
import { pendingCounts } from "./lib/offline.js";
import { formatDurationShort, isoDaysAgo } from "./lib/format.js";
import { noteTimerEcho } from "./lib/storage.js";
import { entryLabel, RECENT_DAYS } from "./lib/timer-data.js";
import { isAlreadyStopped, refreshMenuBar, replacedNotice, showFailureToast } from "./lib/ui.js";
import { ownOnly, resolveUserId } from "./lib/timer-data.js";

/**
 * One hotkey for the whole loop: stop what is running, or pick the last thing
 * up again. With nothing to resume it starts immediately, then opens the running
 * entry so details can be added without delaying the clock.
 *
 * This is `no-view` deliberately, and it is why it earns a command of its own
 * rather than living inside `timer`. Raycast can only launch `no-view` and
 * menu bar commands in the background, so this is the only mode a global
 * hotkey can drive without opening a window: press it, see a HUD, keep
 * working. The `timer` view is the surface for choosing *what* to start;
 * this one is for the case where there is nothing to choose.
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
  const name = running.description.trim().split(/\r?\n/, 1)[0] || "Untitled work";
  const chars = Array.from(name);
  const short = chars.length > 48 ? `${chars.slice(0, 47).join("").trimEnd()}…` : name;
  await setSubtitle(`Stop Timer · ${short} · ${formatDurationShort(entryDurationSec(running, Date.now()))}`);
};

export default async function ToggleTimer(): Promise<void> {
  const background = environment.launchType === LaunchType.Background;
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
      void refreshMenuBar(false);
      void showHUD("⏹ Stopping timer…");
      try {
        const stopped = await api.stop(running.id);
        await showState(null);
        await refreshMenuBar(false);
        await showHUD(
          `⏹ Stopped — ${formatDurationShort(stopped.durationSec)}${
            stopped.description ? ` · ${stopped.description}` : ""
          }${await queuedSuffix()}`,
        );
      } catch (error) {
        if (!isAlreadyStopped(error)) {
          await noteTimerEcho(running.id);
          await showState(running);
          await refreshMenuBar(false);
          throw error;
        }
        // Stopped elsewhere between the read above and the write. The user got
        // the state they pressed for, so say so rather than reporting a
        // failure. `api.stop` threw before it could record the echo, so this
        // clears it — the same repair the Timer view and the menu bar make.
        await noteTimerEcho(null);
        await showState(null);
        await refreshMenuBar(false);
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
      await refreshMenuBar(false);
      await launchCommand({
        name: "timer",
        type: LaunchType.UserInitiated,
        context: { editRunningId: entry.id },
      });
      return;
    }
    const last = decision.candidate;

    void showHUD(`▶ Starting — ${entryLabel(last)}…`);
    const started = await api.continue(last.id, toQuickStart(last));
    await showState(started);
    await refreshMenuBar(false);
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
  }
}
