/**
 * English `activity` messages — the SOURCE catalog for the desktop app's
 * activity suggestions (`/app/activity`).
 *
 * Add keys here first, then the same keys in ../de/activity.ts: `tsc` fails
 * until both agree. Words every screen uses are already in `common`.
 */
export const activity = {
  page: {
    title: "Activity",
    description:
      "Time this computer saw you working that no entry covers yet. Nothing leaves this computer until you add an entry.",
  },
  web: {
    title: "Activity suggestions are in the desktop app",
    body: "The desktop app can remember which app is in front and suggest entries for the time you did not track. In the browser, the extension does the same for websites.",
    download: "Get the desktop app",
    extension: "Get the browser extension",
  },
  day: {
    previous: "Previous day",
    next: "Next day",
    today: "Today",
  },
  status: {
    off: "Activity capture is off. Turn it on in Settings, under Desktop.",
    openSettings: "Open desktop settings",
    unavailable: "Activity capture does not work on this computer.",
    noScope: "Activity is recorded once your account and workspace have loaded.",
    locked: "A newer version of the app wrote the activity on this computer. Update the app to see suggestions.",
  },
  empty: "No untracked activity on this day.",
  loading: "Loading suggestions …",
  refreshFailed: "The suggestions could not be refreshed. What you see may be out of date.",
  card: {
    filesUnder: "Files under {project}",
    filedByRule: "Filed by a rule, without a project",
    noProject: "No project",
    appShare: "{app} {share}",
  },
  actions: {
    add: "Add",
    editAndAdd: "Edit and add",
    dismiss: "Dismiss",
    alwaysFile: "Always file {app} under …",
  },
  rule: {
    title: "Always file {app} under",
    description:
      "New suggestions where {app} is the busiest app are proposed with these details. The rule stays on this computer.",
    save: "Save rule",
  },
  rules: {
    heading: "Rules on this computer",
    empty: "No rules yet.",
    remove: "Remove rule for {app}",
  },
  toasts: {
    added: "Entry added",
    alreadyTracked: "That time is already tracked or dismissed.",
    workspaceChanged: "You switched workspaces, so no entry was added.",
    addFailed: "The entry could not be added.",
    dismissFailed: "The suggestion could not be dismissed.",
    ruleFailed: "The rule could not be saved.",
  },
} as const;
