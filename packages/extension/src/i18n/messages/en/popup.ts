/**
 * English `popup` — the SOURCE catalog for the browser extension's popup (every screen under src/popup).
 *
 * Add keys here, then in ../de/popup.ts (`tsc` enforces parity). ICU syntax as
 * in the web client. Reuse the web client's German terms
 * (packages/client/src/i18n/GLOSSARY.de.md) so the two surfaces agree.
 *
 * Grouped by component. `fields` and `actions` hold the words several screens
 * share, so "Project" is one message and cannot drift between the tracker and
 * the entry editor.
 */
export const popup = {
  workspace: {
    label: "Workspace",
    heldTitle: "{count, plural, one {# change} other {# changes}} not sent",
    heldHint: "Queued in a workspace your account no longer belongs to. They are not sent to any other workspace. Ask an owner to add you back to sync them, or discard them here.",
    /** Held rows that are not a left workspace's, by `HoldReason`. */
    waitingNewer: {
      title: "{count, plural, one {# change} other {# changes}} waiting for a newer version",
      hint: "A newer version of the extension made these changes. This version cannot read them, so they are not sent. Update the extension to sync them, or discard them here.",
    },
    waitingServer: {
      title: "{count, plural, one {# change} other {# changes}} your server doesn’t support yet",
      hint: "Your server doesn’t support these changes yet. Ask your admin to update it — they are sent after that. Or discard them here.",
    },
    waitingServerUpdate: {
      title: "{count, plural, one {# change} other {# changes}} waiting for a server update",
      hint: "Your server is older than this app; these changes will send once it's updated",
    },
    /** Rows another account queued in this browser, held for that account. */
    otherAccount: {
      title: "{count, plural, one {# change} other {# changes}} from another account",
      hint: "Another account queued these in this browser before it signed out. They are sent only when that account signs in here again. Or discard them here.",
      workspace: "another account’s workspace",
    },
    discardHintWaiting: "This deletes work that no server has received. It cannot be recovered.",
    leftWorkspace: "a workspace you left",
    untitled: "(no description)",
    discard: "Discard",
    discardHint: "This deletes work tracked in {workspace} that no server has received. It cannot be recovered.",
    ops: {
      start: "Start “{description}” in {workspace}",
      stop: "Stop in {workspace}",
      create: "Add “{description}” in {workspace}",
      update: "Edit “{description}” in {workspace}",
      remove: "Delete an entry in {workspace}",
      other: "A change in {workspace}",
    },
  },
  /** The banner above every screen when this app and the server do not fit. */
  version: {
    serverTooOld:
      "This server runs v{release} (API level {level}). This app needs level {min} or higher. Ask your server admin to update.",
    serverTooOldNoRelease:
      "This server runs an older version (API level {level}). This app needs level {min} or higher. Ask your server admin to update.",
    howToUpdate: "How to update",
    clientTooOld: "This app is too old for this server. Update the app.",
  },
  actions: {
    cancel: "Cancel",
    create: "Create",
    creating: "Creating…",
    delete: "Delete",
    signOut: "Sign out",
    openApp: "Open Track Your Time",
    openAppExternal: "Open Track Your Time ↗",
  },
  fields: {
    description: "Description",
    project: "Project",
    noProject: "No project",
    searchProjects: "Search projects…",
    createProject: "Create project “{name}”",
    task: "Task",
    noTask: "No task",
    searchTasks: "Search tasks…",
    createTask: "Create task “{name}”",
    client: "Client",
    noClient: "No client",
    searchClients: "Search clients…",
    createClient: "Create client “{name}”",
    tags: "Tags",
    billable: "Billable",
    notBillable: "Not billable",
    start: "Start",
    end: "End",
    duration: "Duration",
    day: "Day",
  },
  app: {
    loading: "Loading…",
    retry: "Try again",
    signedIn: "Signed in",
    notes: {
      entryDeleted: "Entry deleted.",
      entryAdded: "Entry added.",
      entryGone: "That entry is gone.",
      activityWiped: "All captured activity was deleted from this device.",
    },
  },
  errors: {
    credentials: "That email and password did not match an account.",
    noSessionToken:
      "The server accepted the password but returned no session token, so there is nothing for the extension to keep. Its better-auth bearer plugin needs to be enabled — signing in again will not help.",
    worker: "The extension’s background worker did not answer. Close and reopen the popup.",
    unreachable:
      "Could not reach {server}. Check the server address and that the server is running.",
    serverFailed: "The server failed with {status}. Try again in a moment.",
    invalidEmail: "That does not look like an email address.",
    emailNotVerified: "Verify your email address before signing in.",
    twoFactorUnsupported:
      "This account uses two-factor authentication. Use Sign in with the web app.",
    noFetch: "This browser could not make the request.",
    notSignedIn: "Sign in first.",
    stillSyncing: "That entry has not reached the server yet. Try again in a moment.",
    badTimeRange: "The end has to be after the start.",
    revokeSelf:
      "That is this browser. Use Sign out instead, so the extension forgets its own session too.",
    notRunning: "No timer is running, so there is nothing to edit.",
    invalidApiUrl: "That is not a valid URL.",
    badMessage: "The extension received a message it does not understand.",
    forbidden: "You do not have permission to do this.",
    notFound: "This could not be found. It may have been deleted.",
    tooManyRequests: "Too many requests. Wait a moment and try again.",
    generic: "Something went wrong. Try again.",
    activityPermission: "Chrome did not grant access to tabs, so activity capture stays off.",
    activityPermissionFailed: "Could not ask Chrome for access to tabs.",
    activityUnavailable: "Activity capture has no account to file under yet. Try again in a moment.",
    suggestionTracked: "That time is already tracked or dismissed.",
    /**
     * `server` is the host the extension was trying to reach; `origin` is this
     * extension's `chrome-extension://…` origin, for the admin to copy.
     */
    originNotTrusted:
      "{server} does not accept requests from this extension. Ask its admin to set TRUST_STORE_APPS=true, or to add {origin} to TRUSTED_ORIGINS.",
    deviceUrlInvalid:
      "The server sent an approval page the extension will not open. The server’s web address has to use https://.",
    deviceDenied: "The sign-in was declined in the web app.",
    deviceExpired: "The code expired before anyone approved it. Start again.",
    deviceFailed: "The sign-in did not finish. Start again.",
    serverUnreachable: "Could not reach {server}. Check the address, and that the server is running.",
    notTrackYourTime:
      "{server} answered, but it is not a Track Your Time server. Enter the address you open Track Your Time at.",
    serverUnhealthy:
      "{server} is a Track Your Time server, but it cannot reach its database right now. Try again in a minute.",
    unsentChanges:
      "Some changes have not reached the server in use yet. Switching servers signs you out, and the extension discards them.",
    serverTooOld:
      "{server} runs API level {level}. This app needs level {min} or higher. Ask the server admin to update it.",
    serverTooOldUnknown:
      "{server} runs an older version than this app needs. Ask the server admin to update it.",
    serverEmpty: "Enter your server's address.",
    serverInvalid: "“{input}” is not a web address. It looks like https://track.example.com.",
    serverInsecure:
      "Use https:// for {host}. Plain http:// sends your password unencrypted, so it is only accepted for localhost.",
  },
  sync: {
    offline: "Offline",
    offlineQueued: "Offline · {count, number} queued",
    offlineTitle:
      "The server is not answering. Timers still start and stop, and are sent when it comes back.",
    offlineQueuedTitle:
      "The server is not answering. {count, plural, one {# change} other {# changes}} will be sent when it does.",
    queued: "{count, number} queued",
    queuedTitle: "{count, plural, one {# change} other {# changes}} still to send.",
    synced: "Synced",
    syncedTitle: "Live updates from your other devices are connected.",
    connecting: "Connecting…",
    connectingTitle: "Connecting to live updates.",
    polling: "Polling",
    pollingTitle:
      "Live updates are unavailable, so changes made elsewhere show up on a short delay. Everything you do here is saved normally.",
  },
  header: {
    back: "Back",
    newEntry: "New entry",
    entries: "Entries",
    settings: "Settings",
    suggestions: "Suggestions",
    suggestionsTitle: "Suggestions from activity",
  },
  /** The server choice, on the sign-in screen and in Settings → Account. */
  server: {
    label: "Server",
    defaultServer: "Default ({host})",
    ownServer: "My own server",
    address: "Server address",
    checking: "Checking server…",
    use: "Use this server",
    switchTitle: "Switch to {server}?",
    discardAndSwitch: "Discard and switch",
    unsentHint:
      "{count, plural, one {# change has not reached {server} yet. Switching servers signs you out, and the extension discards it.} other {# changes have not reached {server} yet. Switching servers signs you out, and the extension discards them.}}",
  },
  suggestions: {
    title: "Suggestions",
    filesUnder: "Files under {project}",
    filedByRule: "Filed by a rule, no project",
    accept: "Accept",
    edit: "Edit",
    dismiss: "Dismiss",
    alwaysFile: "Always file {site} under",
    alwaysFileOpen: "Always file {site} under…",
    saveRule: "Save rule",
    rules: "Rules on this device",
    remove: "Remove",
    off: "Activity capture is off. When it is on, this browser records which sites you spend time on — on this device only — and suggests entries for time you did not track.",
    openSettings: "Open activity settings",
    empty: "No untracked activity on this day.",
    acceptTitle: "Accept suggestion",
    acceptSubmit: "Accept as entry",
    accepting: "Accepting…",
  },
  activity: {
    storageNewerVersion:
      "Activity data was created by a newer version of the extension. Capture is off until that version is installed again. Nothing was deleted.",
    enabledNote:
      "Records the site in front of you, on this device only. Nothing is sent until you accept a suggestion.",
    on: "Capturing activity",
    off: "Activity capture off",
    titlesNote: "Page titles say more about you than site names. Off keeps only the hostname.",
    storingTitles: "Storing page titles",
    hostnamesOnly: "Hostnames only",
    exclude: "Never record",
    excludeNote:
      "Sites on this list are never stored. Use *.example.com for a whole domain. Incognito tabs are never recorded.",
    add: "Add",
    remove: "Remove",
    retention: "Keep activity for",
    retentionNote: "Older activity is deleted every day. Rules are kept.",
    retentionSuffix: "days",
    retentionLabel: "Activity retention in days",
    wipeNote: "Removes captured activity, rules and dismissed suggestions from this device.",
    wipeNoteCount:
      "{count, plural, one {# stored stretch of activity. Removes it, your rules and dismissed suggestions from this device.} other {# stored stretches of activity. Removes them, your rules and dismissed suggestions from this device.}}",
    wipe: "Delete all activity now",
    wipeTitle: "Delete all captured activity?",
    wipeHint: "Entries you already accepted are not touched. This cannot be undone.",
  },
  menu: {
    more: "More",
    reports: "Reports",
  },
  idle: {
    alert: "Away for {span} — resolve",
    lockedTitle: "Screen was locked for {span}",
    inputTitle: "No input for {span}",
    hint: "The timer is still running. Keep that time if you were reading, in a meeting or on a call.",
    keep: "I was working",
    discard: "Discard {span}",
    discardAndResume: "Discard and resume",
  },
  dayStepper: {
    previous: "Previous day",
    next: "Next day",
    today: "Today",
  },
  entry: {
    today: "Today",
    yesterday: "Yesterday",
    noDescription: "No description",
    running: "Running",
    pendingTitle: "Not sent yet — editable once it syncs",
    projectDeleted: "Project deleted",
    projectArchived: "{project} (archived)",
    clientAndProject: "{client} · {project}",
  },
  tagPicker: {
    remove: "Remove {name}",
    search: "Search or add tags…",
    addAnother: "Add another tag…",
    create: "Create tag “{name}”",
  },
  signIn: {
    title: "Sign in to Track Your Time",
    email: "Email",
    password: "Password",
    submitting: "Signing in…",
    submit: "Sign in",
    signingInTo: "Signing in to",
    changeServer: "Change server",
    keepServer: "Cancel",
    or: "or",
    withWebApp: "Sign in with the web app",
    withWebAppHint: "Opens Track Your Time in a new tab. Works with two-factor authentication.",
    deviceTitle: "Approve this browser",
    deviceWaiting: "Approve the sign-in in the tab that opened. It shows this code:",
    deviceCancel: "Cancel",
    openWebApp: "Open Track Your Time",
    openWebAppHint: "Already signed in there? The extension signs in when the page opens.",
  },
  section: {
    saved: "Saved",
  },
  quickStart: {
    title: "Quick start",
    rowTitle: "{label} — {hint}",
    pin: "Pin {label}",
    unpin: "Unpin {label}",
  },
  timeField: {
    rejected: "Not a time — try 9:30, 930 or 9:30 pm.",
  },
  combobox: {
    create: "Create “{name}”",
    notAvailable: "Not available",
    search: "Search…",
    noMatches: "No matches",
  },
  description: {
    fillTitle: "Use “{description}” with its project, task, tags and billable setting",
    fillLabel: "Use {description} with its fields",
    legend: "⇥ completes",
    legendWithFill: "⇥ completes · ＋ or ⌘⏎ brings its project and tags",
  },
  projectPicker: {
    newTitle: "New project “{name}”",
  },
  entryForm: {
    descriptionPlaceholder: "What was this?",
    onInvoice: "On an invoice",
    notSent: "Not sent yet",
    zoneNote: "Recorded in {zone}, and edited in that clock.",
  },
  tracker: {
    descriptionPlaceholder: "What are you working on?",
    /** The button. The start TIME of an entry is `fields.start`. */
    start: "Start",
    stop: "Stop",
    today: "Today",
  },
  entries: {
    title: "Entries",
    empty:
      "{days, plural, one {Nothing tracked today.} other {Nothing tracked in the last # days.}}",
    newEntry: "New entry",
    loadOlder: "Load older",
    end: "{days, plural, one {That is all of today.} other {That is the last # days.}} Older entries are in the web app.",
  },
  entryNew: {
    title: "New entry",
    duration: "That is {duration}.",
    adding: "Adding…",
    add: "Add entry",
  },
  entryDetail: {
    title: "Entry",
    queued: "Not sent yet — try again in a moment.",
    invoiced:
      "On an invoice — times, project and billable are locked. The description and tags can still be changed.",
    deleteTitle: "Delete this entry?",
    deleteHint: "{duration} · {day} · {subtitle}",
    cannotDelete: "An invoiced entry cannot be deleted.",
    deleteEntry: "Delete entry",
  },
  settings: {
    title: "Settings",
    loading: "Loading settings…",
    on: "On",
    off: "Off",
    sections: {
      general: "General",
      idle: "Idle",
      limits: "Limits",
      devices: "Devices",
      activity: "Activity",
      account: "Account",
    },
  },
  general: {
    hint: "{clock} · {duration} · {currency}",
    workspaceNote: "Applies to the whole workspace",
    language: "Language",
    languageNote: "Shared with the web app and your other devices.",
    languages: {
      system: "Match the system",
      en: "English",
      de: "Deutsch",
    },
    theme: "Theme",
    themeNote: "Shared with the web app and your other machines.",
    themes: {
      system: "Match the system",
      light: "Light",
      dark: "Dark",
    },
    timeFormat: "Time format",
    timeFormats: {
      "24h": "24-hour",
      "12h": "12-hour",
    },
    durationFormat: "Duration format",
    durationFormatNote: "Decimal hours are what most invoices expect.",
    weekStart: "Week starts on",
    currency: "Currency",
    currencyOption: "{code} — {name}",
    defaultRate: "Default hourly rate",
    defaultRateNote:
      "Used when a billable entry’s project has no rate of its own. Applies to the whole workspace.",
  },
  idleSettings: {
    hint: "{behavior, select, ask {Ask} pause {Pause} keep {Keep} other {Stop}} after {minutes, number} min",
    enabledNote:
      "Each device watches its own input. A device that did not start the timer never touches it.",
    on: "Detecting idle time",
    off: "Idle detection off",
    threshold: "Away after",
    thresholdNote: "How long with no input before you count as away.",
    thresholdLabel: "Idle threshold in minutes",
    minutesSuffix: "min",
    behavior: "When away",
    lockNote: "Locking is deliberate, so it does not have to wait out the threshold first.",
    lockImmediate: "Locking counts immediately",
    lockWaits: "Locking waits for the threshold",
    behaviors: {
      ask: {
        label: "Ask me",
        description:
          "Keep running and offer the choice when you get back. Nothing is discarded unless you say so.",
      },
      pause: {
        label: "Pause and resume",
        description:
          "End the entry where the idle time started, then reopen an identical one as soon as you come back.",
      },
      keep: {
        label: "Keep running",
        description:
          "Never act on idle time. For reading, meetings and calls, where no input is normal.",
      },
      stop: {
        label: "Stop the timer",
        description: "End the entry where the idle time started and leave the timer stopped.",
      },
    },
  },
  limits: {
    hint: "{hours, number} h, then {behavior, select, ask {ask} cap {cap it} other {stop it}}",
    enabledNote:
      "Worked out on the server, not on your devices — the whole point is the case where none of them were running.",
    on: "Stopping runaway timers",
    off: "Runaway guard off",
    after: "After",
    afterNote: "Pick something above any believable single sitting and below an overnight.",
    hoursLabel: "Maximum entry length in hours",
    hoursSuffix: "h",
    then: "Then",
    behaviors: {
      ask: {
        label: "Ask me",
        description:
          "Leave the timer running and ask the next time you look. Nothing is shortened unless you say so.",
      },
      cap: {
        label: "Cap it",
        description:
          "End the entry at the maximum and discard the overrun. The original span is kept on the entry so you can put it back.",
      },
      stop: {
        label: "Stop it",
        description:
          "End the entry where it had got to. Every second is kept — the timer just stops growing.",
      },
    },
  },
  devices: {
    hint: "{count, plural, one {# signed in} other {# signed in}}",
    loading: "Loading devices…",
    thisBrowser: "This browser",
    lastActive: "{client} · Last active {when}",
    justNow: "just now",
    unknown: "unknown",
    clients: {
      web: "Web",
      desktop: "Desktop",
      mobile: "Mobile",
      raycast: "Raycast",
      extension: "Browser extension",
      cli: "CLI",
      unknown: "Unknown",
    },
    signOutBrowserTitle: "Sign this browser out?",
    signOutDeviceTitle: "Sign this device out?",
    sharedSessionHint:
      "Signed in through the web app. Signing out here also signs you out of Track Your Time in this browser the next time you open it.",
    signOutBrowserHint: "The extension forgets its session and you sign in again.",
    signOutDeviceHint:
      "{name} stops syncing immediately and has to sign in again. Nothing it already tracked is lost.",
    signOutOthers: "Sign out other devices",
    signOutOthersTitle: "Sign every other device out?",
    signOutOthersHint: "This browser stays signed in. Everything else has to sign in again.",
    /** The extension is linked to the web app, whose own session in this browser is one of the others. */
    signOutOthersSharedHint:
      "Every other device has to sign in again, and so does Track Your Time in this browser. The extension is signed in through it, so the extension signs out too.",
    signOutOthersConfirm: "Sign them out",
  },
  account: {
    signedInAs: "Signed in as",
    /** This extension's own release, from the root package.json. */
    appVersion: "Track Your Time extension {version}",
    sharedSession:
      "Signed in through the web app in this browser. Signing out of the web app signs the extension out too.",
    changeServer: "Change server…",
    keepServer: "Keep this server",
    signOutTitle: "Sign out?",
    signOutSharedHint:
      "Signing out here also signs you out of Track Your Time in this browser the next time you open it.",
    signOutHint: "Anything already tracked is kept. You sign in again to keep tracking.",
  },
} as const;
