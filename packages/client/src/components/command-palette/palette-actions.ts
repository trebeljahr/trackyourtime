import type { DetailedEntry, TimeEntry } from "@starter/shared";

import type { EntryMutations } from "@/components/tracker/use-entry-mutations";
import type { PaletteAction } from "@/components/command-palette/palette-model";

/** The palette's two pages: everything, and the discard confirmation. */
export type PalettePage = "root" | "discard";

export type PaletteRunner = {
  /**
   * The tracker's own hooks, never a tRPC call of the palette's own: they
   * carry the optimistic cache writes, the offline queue and
   * OFFLINE_QUEUED_MUTATION, so a stop from here offline is the same queued
   * row a stop from the bar would be.
   */
  mutations: Pick<
    EntryMutations,
    "startTimer" | "startQuickStart" | "stopTimer" | "removeEntry"
  >;
  navigate: (href: string) => void;
  running: TimeEntry | null;
  close: () => void;
  setPage: (page: PalettePage) => void;
};

/**
 * `removeEntry` takes the list's row shape; it reads only the id (to drop a
 * temp row locally or delete a real one), so the running entry is widened
 * with empty labels rather than looked up in a cache that may not hold it.
 */
const asDetailed = (entry: TimeEntry): DetailedEntry => ({
  ...entry,
  projectName: null,
  projectColor: null,
  clientName: null,
  taskName: null,
  amount: 0,
});

/** Carries out one chosen row. Pure routing, so it is tested without cmdk. */
export const runPaletteAction = (
  action: PaletteAction,
  runner: PaletteRunner,
): void => {
  switch (action.kind) {
    case "stop":
      runner.mutations.stopTimer();
      runner.close();
      return;
    case "discard-confirm":
      runner.setPage("discard");
      return;
    case "back":
      runner.setPage("root");
      return;
    case "discard":
      // The timer may have been stopped elsewhere while the page was open;
      // with nothing running there is nothing this confirmation was about.
      if (runner.running !== null) {
        runner.mutations.removeEntry(asDetailed(runner.running));
      }
      runner.close();
      return;
    case "start":
      runner.mutations.startTimer(action.fields);
      runner.close();
      return;
    case "quick-start":
      runner.mutations.startQuickStart(action.quick);
      runner.close();
      return;
    case "navigate":
      runner.close();
      runner.navigate(action.href);
      return;
  }
};
