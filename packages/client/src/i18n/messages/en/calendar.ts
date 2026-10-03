/**
 * English `calendar` messages — the SOURCE catalog for the calendar screen and its time grid.
 *
 * Add keys here first (grouped by component or screen, camelCase), then the
 * same keys in ../de/calendar.ts: `tsc` fails until both agree. ICU syntax:
 * `{name}`, `{count, plural, one {# entry} other {# entries}}`, `<b>…</b>`
 * with `t.rich`. Words every screen uses are already in `common`.
 */
export const calendar = {
  toolbar: {
    visibleHours: "Visible hours",
    zoom: "Zoom",
    zoomIn: "Zoom in",
    zoomOut: "Zoom out",
    resetZoom: "Reset zoom",
    resetZoomHint: "Reset zoom (0)",
    undo: "Undo",
    undoChange: "Undo {change}",
    undoHint: "Undo (Ctrl/⌘ + Z)",
    undoChangeHint: "Undo {change} (Ctrl/⌘ + Z)",
    redo: "Redo",
    redoChange: "Redo {change}",
    redoHint: "Redo (Ctrl/⌘ + Shift + Z)",
    redoChangeHint: "Redo {change} (Ctrl/⌘ + Shift + Z)",
    addEntry: "Add entry",
  },
  history: {
    /** Named in "Undo {change}" and in the toast after undo or redo. */
    changes: {
      move: "move",
      timeChange: "time change",
      descriptionChange: "description change",
      projectChange: "project change",
      tagChange: "tag change",
      billableChange: "billable change",
      edit: "edit",
      create: "create",
      delete: "delete",
    },
    undid: "Undid {change}",
    redid: "Redid {change}",
    blocked: {
      stillSaving: "That change is still saving — try again in a moment",
      stopsRunningTimer:
        "Stopping a running timer cannot be undone — only one entry can run at a time",
      deletesRunningTimer:
        "Deleting a running timer cannot be undone — only one entry can run at a time",
    },
  },
  grid: {
    /** End of a running entry's time range: "9:00 – now". */
    now: "now",
  },
  cluster: {
    count: "{count, plural, one {# short entry} other {# short entries}}",
    ariaLabel: "{count, plural, one {# short entry} other {# short entries}}, {time}",
    title: "{count, plural, one {# short entry} other {# short entries}} · {time} · {duration}",
    /** Follows the bold count on the chip. */
    chipSuffix: "{count, plural, one {short entry} other {short entries}} · {duration}",
  },
  create: {
    title: "New time entry",
    /** The label on the draft block a click on the grid puts down. */
    newEntry: "New entry",
    descriptionPlaceholder: "What are you working on?",
    submit: "Create entry",
    invalidTimes: "Enter times like 9:15 or 14:00",
    endBeforeStart: "End must be after start",
  },
  edit: {
    invalidTime: "“{value}” is not a time we understand",
    endStopsTimer: "End (stops timer)",
  },
  year: {
    trackedThisYear: "Tracked this year",
    daysTracked: "Days tracked",
    averagePerDay: "Average per tracked day",
    busiestDay: "Busiest day",
    projectsThisYear: "Projects this year",
    nothingTracked: "nothing tracked",
  },
  timesheet: {
    title: "Timesheet",
    previousWeek: "Previous week",
    nextWeek: "Next week",
    truncated:
      "This week has more entries than the grid can total accurately, so editing is off. Narrow it down in Reports → Entries instead.",
    emptyTitle: "Nothing on this timesheet yet",
    emptyDescription:
      "Add a row for a project below, then type hours straight into the day you worked them.",
    addRow: "Add row",
    weekTotal: "Week total",
    projectTask: "Project / Task",
    removeRow: "Remove row {label}",
    running: "running",
    openEntries: "Open these entries",
    blocks: {
      show: "Show blocks for {label}",
      hint: "Edit one block or add another. The cell total is the sum of its blocks.",
      add: "Add block",
      edit: "Edit block {label}",
      empty: "No blocks on this day. Add a block to log time.",
      untitled: "No description",
      dayContribution: "The duration shown is this block’s contribution to this day. Editing opens the whole block.",
      refreshBeforeRetry: "The save succeeded, but the saved block is unavailable here. Refresh the timesheet before trying again.",
      scopeChanged: "Your account or workspace changed. Close this draft and open it again.",
      unavailable: "Editing is unavailable while this timesheet is loading or incomplete. Try again after it refreshes.",
      protection: {
        missing: "This entry is no longer available. Refresh the timesheet.",
        foreign: "Only your own entries in this workspace can be edited.",
        running: "Stop this timer before editing its block.",
        invoiced: "This block is invoiced and cannot be edited here.",
        syncing: "This block is still syncing. Edit it after it syncs.",
      },
    },
    stillSyncing: "Still syncing — try again in a moment.",
    entryRemoved: "Entry removed",
    failed: {
      add: "Could not add the time",
      save: "Could not save the change",
      remove: "Could not remove the time",
    },
    /** Why a cell cannot be written, keyed by `TimesheetRefusal`. */
    refusal: {
      running: "This cell holds the running timer — stop it before editing.",
      multiple:
        "This day has several blocks. Edit each block below; the total cannot be edited directly.",
      spansDays:
        "This block crosses midnight. Edit the whole block below; this day’s total cannot be edited directly.",
      tooLong: "A day cannot hold more than 24 hours.",
    },
  },
} as const;
