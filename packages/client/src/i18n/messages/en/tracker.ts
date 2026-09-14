/**
 * English `tracker` messages — the SOURCE catalog for the tracker: /track, the timer bar, entry list, entry dialogs, idle/runaway prompts, favorites and recents, offline queue notices, the timesheet grid.
 *
 * Add keys here first (grouped by component or screen, camelCase), then the
 * same keys in ../de/tracker.ts: `tsc` fails until both agree. ICU syntax:
 * `{name}`, `{count, plural, one {# entry} other {# entries}}`, `<b>…</b>`
 * with `t.rich`. Words every screen uses are already in `common`.
 */
export const tracker = {
  workspace: {
    replaced: "Stopped your timer in {name}",
    runningElsewhere: "Running in {name}",
    runningElsewhereHint: "This timer runs in another workspace. Switch to {name} to edit it, or stop it here.",
  },
  queue: {
    held: "{count, plural, one {# change} other {# changes}} not sent",
    heldHint: "Queued by another account, for another server, or in a workspace you left. They are kept, and never sent from here.",
  },
  description: {
    label: "Description",
    placeholder: "What are you working on?",
    suggestions: "Past descriptions",
    fill: "Use “{description}” with its project, task, tags and billable setting",
    legend: "Tab completes · {shortcut} brings its project, task and tags",
    ctrlEnter: "Ctrl+Enter",
  },
  /** Field labels the bar, the rows and both entry dialogs share. */
  fields: {
    startTime: "Start time",
    endTime: "End time",
    startDate: "Start date",
    endDate: "End date",
    notBillable: "Not billable",
  },
  bar: {
    descriptionPlaceholder: "What are you working on?",
    addEntry: "Add time entry",
    authBlocked: "Signed out — sign in to sync",
    clockSkewed: "Device clock looks wrong",
    pending: "{count, plural, one {# change pending} other {# changes pending}}",
  },
  list: {
    loadError: "Could not load your entries",
    retry: "Try again",
    emptyTitle: "No time tracked yet",
    emptyDescription:
      "Type what you are working on above and hit Start — or press + to log time you already spent.",
    importHistory: "Import your history",
    loadingMore: "Loading earlier days…",
    loadMore: "Load earlier days",
    end: "That is everything you have tracked.",
  },
  row: {
    running: "Running",
    addDescription: "Add description",
    /** Where a running entry's end time would be. */
    now: "now",
    /** Badge on an entry that ends on the day after it started. */
    nextDay: "+1d",
    nextDayTitle: "Ends on the next day",
    recordedIn: "Recorded in {zone}",
    stop: "Stop this entry",
    continue: "Continue this entry",
    actions: "Entry actions",
    pin: "Add to favorites",
    unpin: "Remove from favorites",
  },
  editDialog: {
    title: "Edit entry",
    description: "Change what was tracked, where it was tracked, and when.",
    zoneNote:
      "Recorded in {zoneLabel} ({zone}). Times below are shown and saved in that zone, so they stay as they were written.",
  },
  manualDialog: {
    title: "Add time entry",
    description: "Log a block of work that was not timed.",
  },
  entryFields: {
    descriptionPlaceholder: "What did you work on?",
    clientTitle: "Client: {name}",
  },
  projectPicker: {
    searchPlaceholder: "Search projects...",
    empty: "No projects found.",
    createProject: "Create project \"{project}\"",
    createProjectForClient: "Create project \"{project}\" for client \"{client}\"",
    createHint: "Tip: type \"Client / Project\" to create both at once",
    newProject: "New project…",
    created: "Project \"{name}\" created",
  },
  taskPicker: {
    searchPlaceholder: "Search or create a task...",
    empty: "No tasks yet.",
    createTask: "Create task \"{name}\"",
    newTask: "New task…",
    created: "Task \"{name}\" created",
  },
  quickStart: {
    trigger: "Quick start",
    triggerTitle: "Start something you tracked before",
    favorites: "Favorites",
    recents: "Recently tracked",
    moveUp: "Move {label} up",
    moveDown: "Move {label} down",
    unpin: "Unpin",
    unpinLabel: "Unpin {label}",
    pinLabel: "Pin {label}",
    pinTitle: "Pin to the top of this menu",
    noDescription: "No description",
    projectDeleted: "Project deleted",
    projectArchived: "{project} (archived)",
    clientProject: "{client} · {project}",
  },
  idle: {
    screenLocked: "Screen locked for {span}",
    noInput: "No input for {span}",
    body: "The timer has been running since {since}. Keep that time if you were reading, in a meeting or on a call.",
    keep: "I was working",
    discard: "Discard {span}",
    discardAndResume: "Discard and resume",
  },
  runaway: {
    title: "This timer ran for {ran}",
    actionFlagged: "The timer is still running.",
    actionCapped: "The entry was cut back to the maximum.",
    actionStopped: "The timer was stopped and the whole span kept.",
    body: "{action} Your maximum is {limit}. Keep it if you really did work that long.",
    realEnd: "Real end time",
    keepCap: "Keep the cap",
    keepLong: "I worked that long",
    restore: "Put back {ran}",
    cap: "Cap at {limit}",
    cutBack: "Cut back to {limit}",
    setEnd: "Set the end…",
  },
  mutations: {
    startFailed: "Could not start the timer",
    stopFailed: "Could not stop the timer",
    addFailed: "Could not add the entry",
    saveFailed: "Could not save the entry",
    deleteFailed: "Could not delete the entry",
    updateFailed: "Could not update that entry",
    stoppedAfter: "Stopped after {duration}",
    shortEntryKept: "Short entries are kept unless you discard them.",
    stillSyncing: "Still syncing — try again in a moment.",
  },
  favorites: {
    pinned: "Pinned to favorites",
    pinFailed: "Could not pin this",
    unpinFailed: "Could not unpin this",
    reorderFailed: "Could not reorder your favorites",
  },
  offlineQueue: {
    rejected:
      "{count, plural, one {One offline change could not be saved} other {# offline changes could not be saved}}",
    rejectedDescription: "The server refused them, so they were discarded.",
    stale:
      "{count, plural, one {An old entry could not be closed} other {# old entries could not be closed}}",
    staleDescription:
      "A stop queued more than a day ago no longer names an entry we can safely end. Check the timer and stop it by hand.",
  },
} as const;
