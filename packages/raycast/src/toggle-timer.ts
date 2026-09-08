import { LaunchType, launchCommand, showHUD } from "@raycast/api";
import { toQuickStart } from "@starter/core";
import { getTracktime } from "./lib/api.js";
import { pendingCounts } from "./lib/offline.js";
import { formatDurationShort, isoDaysAgo } from "./lib/format.js";
import { noteTimerEcho } from "./lib/storage.js";
import { entryLabel, RECENT_DAYS } from "./lib/timer-data.js";
import {
  isAlreadyStopped,
  refreshMenuBar,
  showFailureToast,
} from "./lib/ui.js";

/**
 * One hotkey for the whole loop: stop what is running, or pick the last thing
 * up again. With nothing to resume it falls through to the Timer view rather
 * than starting a nameless timer the user then has to fix.
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

export default async function ToggleTimer(): Promise<void> {
  try {
    const api = await getTracktime();
    const running = await api.current();

    if (running) {
      try {
        const stopped = await api.stop(running.id);
        await refreshMenuBar();
        await showHUD(
          `⏹ Stopped — ${formatDurationShort(stopped.durationSec)}${
            stopped.description ? ` · ${stopped.description}` : ""
          }${await queuedSuffix()}`,
        );
      } catch (error) {
        if (!isAlreadyStopped(error)) throw error;
        // Stopped elsewhere between the read above and the write. The user got
        // the state they pressed for, so say so rather than reporting a
        // failure. `api.stop` threw before it could record the echo, so this
        // clears it — the same repair the Timer view and the menu bar make.
        await noteTimerEcho(null);
        await refreshMenuBar();
        await showHUD("⏹ Timer already stopped");
      }
      return;
    }

    // The same window the Timer view and the menu bar call "recent", so the
    // entry a hotkey resumes is the one those surfaces show at the top.
    const { entries } = await api.list({
      from: isoDaysAgo(RECENT_DAYS),
      to: new Date().toISOString(),
      limit: 1,
    });
    const last = entries[0];

    if (!last) {
      await launchCommand({ name: "timer", type: LaunchType.UserInitiated });
      return;
    }

    await api.continue(last.id, toQuickStart(last));
    await refreshMenuBar();
    // Labelled from the entry that was continued, not from the one that came
    // back: the list rows are joined with their project and client names, so
    // an entry with no description still reads as something.
    await showHUD(`▶ Started — ${entryLabel(last)}${await queuedSuffix()}`);
  } catch (error) {
    await showFailureToast(error, "Could not toggle the timer");
  }
}
