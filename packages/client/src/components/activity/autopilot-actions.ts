import type { DesktopActivity, DesktopAutopilot, TimeEntry } from "@starter/shared";

import { TRACKER_LIST_INPUT, type EntryMutations } from "@/components/tracker/use-entry-mutations";
import { timerStore } from "@/hooks/use-sync";
import { decorateEntry } from "@/lib/entry-shape";
import { nudgeAutopilot } from "@/lib/autopilot-nudge";
import type { trpc } from "@/lib/trpc";

type Utils = ReturnType<typeof trpc.useUtils>;

/** Two starts this close are one start; the server may round. */
const SAME_START_MS = 1_000;

/** The running entry: the cache first, the timer store when the query never answered (offline launch). */
export const currentRunning = (utils: Utils): TimeEntry | null => {
  const cached = utils.entries.current.getData();
  return cached !== undefined ? cached : timerStore.getState().running;
};

/**
 * Undo an Autopilot start: delete the entry it opened (only while that entry
 * is still the one running from the same instant), then tell main to hold the
 * filing until the next break and to treat the span as accounted for, so it
 * is neither started again nor offered as a suggestion.
 *
 * The delete goes through `removeEntry`, so an entry opened offline (a temp
 * id) is dropped from the queue rather than sent and deleted.
 */
export const undoAutopilotStart = async (input: {
  utils: Utils;
  mutations: Pick<EntryMutations, "removeEntry">;
  activity: Pick<DesktopActivity, "snapshot">;
  autopilot: Pick<DesktopAutopilot, "hold">;
  at: number;
  filingKey: string;
  logId?: string;
  now?: number;
}): Promise<void> => {
  const { utils } = input;
  const running = currentRunning(utils);
  if (running !== null && Math.abs(Date.parse(running.start) - input.at) < SAME_START_MS) {
    const listed = utils.entries.list
      .getInfiniteData(TRACKER_LIST_INPUT)
      ?.pages.flatMap((page) => page.entries)
      .find((entry) => entry.id === running.id);
    input.mutations.removeEntry(
      listed ??
        decorateEntry(
          {
            projects: utils.projects.list.getData({}) ?? [],
            clients: utils.clients.list.getData({}) ?? [],
            settings: utils.settings.get.getData() ?? null,
          },
          running,
        ),
    );
  }
  const logId = input.logId ?? (await input.activity.snapshot()).autopilot?.owned?.logId;
  const now = input.now ?? Date.now();
  await input.autopilot.hold({
    filingKey: input.filingKey,
    dismiss: { start: input.at, end: Math.max(input.at + 1, now) },
    ...(logId !== undefined ? { logId } : {}),
  });
  nudgeAutopilot();
};
