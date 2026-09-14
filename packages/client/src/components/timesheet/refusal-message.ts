import type { TimesheetRefusal } from "@starter/shared";

/** The key under `calendar.timesheet.refusal` for a refusal code. */
export type RefusalMessageKey = "running" | "multiple" | "spansDays" | "tooLong";

/**
 * Maps a `TimesheetRefusal` code to its message key. The code stays the
 * shared, locale-free identifier; the words are looked up where they are shown.
 */
export const refusalMessageKey = (reason: TimesheetRefusal): RefusalMessageKey => {
  switch (reason) {
    case "running":
      return "running";
    case "multiple":
      return "multiple";
    case "spans-days":
      return "spansDays";
    case "too-long":
      return "tooLong";
  }
};
