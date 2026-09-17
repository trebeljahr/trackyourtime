/**
 * English `settings` messages — the SOURCE catalog for Settings (every tab), profile, devices, API tokens, webhooks, import/export panels, account deletion.
 *
 * Add keys here first (grouped by component or screen, camelCase), then the
 * same keys in ../de/settings.ts: `tsc` fails until both agree. ICU syntax:
 * `{name}`, `{count, plural, one {# entry} other {# entries}}`, `<b>…</b>`
 * with `t.rich`. Words every screen uses are already in `common`.
 */
export const settings = {
  about: {
    /** The release of the app on this screen, from the root package.json. */
    appVersion: "Track Your Time {version}",
    /** Shown when a build carries no version, which only a dev build does. */
    appVersionUnknown: "Track Your Time (development build)",
    apiLevel: "API level {level}",
    server: "Server: {version}, API level {level}",
    serverUnknown: "Server: version unknown",
    /** Owners and admins, when the server's opt-in update check found a newer release. */
    updateAvailable: "v{version} is available.",
    releaseNotes: "Release notes",
    upgrading: "How to upgrade",
  },
  page: {
    title: "Settings",
    description:
      "Preferences apply to every Track Your Time client signed in as you. Changes save as you make them.",
    tabs: {
      general: "General",
      workspace: "Workspace",
      billing: "Billing",
      idle: "Idle",
      limits: "Limits",
      data: "Data",
      devices: "Devices",
      integrations: "Integrations",
      account: "Account",
    },
  },
  toasts: {
    saveFailed: "Could not save your settings",
  },
  profile: {
    title: "Profile",
    description: "Manage your profile information",
    loading: "Loading profile…",
    bio: "Bio",
    noBio: "No bio set",
    edit: "Edit profile",
  },
  general: {
    title: "General",
    description: "How Track Your Time looks and how it prints dates and durations.",
    theme: {
      title: "Theme",
      description:
        "Saved to your account, so the browser extension and your other machines follow it.",
      light: "Light",
      dark: "Dark",
      system: "System",
    },
    weekStart: {
      title: "Week starts on",
      description: "Sets the first column of the weekly timesheet and the “This week” range.",
    },
    timeFormat: {
      title: "Time format",
      /** `sample` is 14:05 already formatted in the chosen style. */
      description: "Clock times render as {sample}.",
      hour24: "24-hour",
      hour12: "12-hour",
    },
    durationFormat: {
      title: "Duration format",
      /** `sample` is 1.5 hours already formatted in the chosen style. */
      description: "Durations render as {sample}. Decimal hours are what most invoices expect.",
    },
  },
  billing: {
    title: "Billing",
    description: "The rate applied to billable time when a project has no rate of its own.",
    defaultRate: {
      title: "Default hourly rate",
      description: "Used whenever a billable entry belongs to a project without its own rate.",
    },
    currency: {
      title: "Currency",
      /** `sample` is 1234.5 already formatted in the currency. */
      description: "Amounts render as {sample}.",
      placeholder: "Select a currency",
    },
    snapshotNote:
      "Changing the rate or currency only affects time you track from now on — each entry stores the rate and currency that applied when it was stopped, so past reports and invoices never move.",
  },
  idle: {
    title: "Idle detection",
    description:
      "Notice when you have stopped working and decide what the running timer should do about it.",
    enabled: {
      title: "Detect idle time",
      description:
        "Each device watches its own input. A device that did not start the timer never touches it, so a sleeping laptop cannot pause work you are doing somewhere else.",
    },
    threshold: {
      title: "Idle after",
      description: "How long with no input before you count as away.",
      ariaLabel: "Idle threshold in minutes",
    },
    behavior: {
      title: "When you go idle",
    },
    behaviors: {
      ask: {
        label: "Ask me",
        description:
          "Keep running and offer the choice when you get back. Nothing is discarded unless you say so.",
      },
      "pause-and-resume": {
        label: "Pause and resume",
        description:
          "End the entry where the idle time started, then reopen an identical one as soon as you come back.",
      },
      "keep-running": {
        label: "Keep running",
        description:
          "Never act on idle time. For reading, meetings and calls, where no input is normal.",
      },
      stop: {
        label: "Stop the timer",
        description: "End the entry where the idle time started and leave the timer stopped.",
      },
    },
    lock: {
      title: "Treat a locked screen as away",
      description: "Locking is deliberate, so it does not have to wait out the threshold first.",
    },
    projects: {
      title: "Per-project override",
      description:
        "Projects can pick their own behaviour in the project dialog — set “Keep running” on the ones where no typing is normal, like meetings or reading.",
      location: "Catalog → Projects",
    },
  },
  maxDuration: {
    title: "Maximum entry length",
    description:
      "Catch the timer you started on Friday evening and found still running on Monday morning.",
    enabled: {
      title: "Guard against runaway timers",
      description:
        "Worked out on the server, not on your devices — the whole point is the case where none of them were running.",
    },
    hours: {
      title: "Longer than",
      description: "Pick something above any believable single sitting and below an overnight.",
      ariaLabel: "Maximum entry length in hours",
    },
    behavior: {
      title: "When one runs that long",
    },
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
    undo: {
      title: "Nothing is deleted for good",
      description:
        "A capped entry keeps the span it actually ran, so “put it back” is always one click away in the prompt.",
      always: "Always",
    },
  },
  account: {
    title: "Account",
    description: "The identity every client, project and time entry is scoped to.",
    signedInAs: "Signed in as",
    notifications: {
      title: "Email notifications",
      description: "Product and account emails. Timer reminders are separate.",
    },
    signOut: {
      description: "Ends this session on this device only.",
    },
    subscription: {
      title: "Subscription",
      description: "Manage your subscription and payment methods.",
      manage: "Manage billing",
      manageUnavailable: "Manage billing (unavailable)",
      unconfigured: "Stripe is not fully configured.",
      unconfiguredWithMode: "Stripe is not fully configured (mode: {mode}).",
      unconfiguredDetail:
        "Billing endpoints (checkout, billing portal, webhooks) will return errors until every Stripe secret has a real value. The rest of the app is unaffected.",
      missingKeys: "Missing env vars:",
    },
    toasts: {
      profileFailed: "Could not update your profile",
      signOutFailed: "Could not sign out. Try again.",
    },
  },
  deleteAccount: {
    title: "Delete account",
    description:
      "Deletes your account, signs out every device, and deletes the data you own. This cannot be undone.",
    dialog: {
      title: "Delete your account?",
      descriptionWithEmail:
        "This permanently deletes {email} and signs out every device, including the browser extension, Raycast and the mobile app. It cannot be undone.",
      description:
        "This permanently deletes your account and signs out every device, including the browser extension, Raycast and the mobile app. It cannot be undone.",
      soloTitle: "In workspaces only you use, everything is deleted:",
      soloDetail:
        "time entries, clients, projects, tasks, tags, pinned quick starts, invoices, import history, API tokens, webhooks and workspace settings.",
      sharedTitle: "In workspaces you share, only your own data is deleted:",
      sharedDetail:
        "your time entries, pins, API tokens, webhooks and imports. The workspace, its clients, projects, tasks, tags and invoices stay, and so do entries already on an invoice. If you are its last owner, ownership passes to an admin, or else to the longest-standing member.",
      exportHint: "Want a copy first? <link>Export your data as JSON</link> before you continue.",
      exportHintPlain:
        "Want a copy first? Export your data as JSON from Settings → Data before you continue.",
      unsynced:
        "{count, plural, one {# change on this device has not synced yet and will be discarded.} other {# changes on this device have not synced yet and will be discarded.}}",
      checking: "Checking how to confirm…",
      password: "Your password",
      typeEmail: "Type <mono>{email}</mono> to confirm",
      confirm: "Delete account permanently",
    },
    refusals: {
      passwordRequired: "Enter your password to delete your account.",
      invalidPassword: "That password is not correct. Nothing was deleted.",
      sessionExpired:
        "For an account without a password, deleting needs a recent sign-in. Sign out, sign in again, then delete within 24 hours.",
      failed: "Your account could not be deleted, and it still exists. Try again.",
    },
    toasts: {
      deleted: "Your account has been deleted",
    },
  },
  devices: {
    title: "Devices & apps",
    description:
      "Everything signed in as you. Sign in from the desktop app, the mobile app, Raycast or a browser extension and it appears here — there is nothing to copy or paste.",
    revokeOthers: "Sign out others",
    empty: {
      title: "No other devices",
      description: "Sign in from another app and it will show up here.",
    },
    columns: {
      device: "Device",
      signedIn: "Signed in",
      lastActive: "Last active",
      actions: "Actions",
    },
    current: "This device",
    /** Beside a device's name: the app release it last used this session with. */
    clientVersion: "· {version}",
    justNow: "Just now",
    revoke: {
      title: "Sign out {name}?",
      titleThisDevice: "Sign out this device?",
      description:
        "That client stops syncing immediately and has to sign in again. Nothing it already tracked is lost.",
    },
    connectHint: {
      title: "Connecting Raycast or a CLI",
      body: "Apps that cannot show a sign-in form give you a short code instead. Open <link>/app/device</link> while signed in here and enter it — the app is then signed in as you and appears in the list above.",
    },
    toasts: {
      revoked: "Device signed out.",
      revokeFailed: "Could not sign that device out",
      revokedOthers:
        "{count, plural, one {# device signed out.} other {# devices signed out.}}",
      revokeOthersFailed: "Could not sign the other devices out",
    },
  },
  foreignQueue: {
    /** This account's rows that cannot be sent yet, by `HoldReason`. */
    held: {
      unknownOp: {
        title: "Waiting for a newer app version",
        description:
          "{count, plural, one {# change on this device was made by a newer version of Track Your Time.} other {# changes on this device were made by a newer version of Track Your Time.}} This version cannot read them, so they are not sent. Update the app to sync them, or discard them here.",
      },
      unknownProcedure: {
        title: "Your server doesn’t support this yet",
        description:
          "{count, plural, one {# change on this device needs a feature your server does not have.} other {# changes on this device need a feature your server does not have.}} Ask your admin to update the server — they are sent after that. Or discard them here.",
      },
      serverTooOld: {
        title: "Your server is older than this app",
        description:
          "Your server is older than this app; {count, plural, one {this change} other {these # changes}} will send once it's updated. Ask your admin to update the server, or discard them here.",
      },
      confirm:
        "This deletes work that no server has ever received. It cannot be recovered. Update the app or the server instead if it should be kept.",
    },
    leftTitle: "Unsynced data for {workspace}",
    leftWorkspace: "a workspace you left",
    leftDescription: "{count, plural, one {# change} other {# changes}} queued on this device in {workspace}, which your account no longer belongs to. They are not sent to any other workspace. Ask an owner to add you back to sync them, or discard them here.",
    inWorkspace: "in {workspace}",
    confirmLeft: "This deletes work tracked in {workspace} that no server has ever received. It cannot be recovered. Ask an owner to add you back instead if it should be kept.",
    /** While the count is known and the rows have not been read yet. */
    titleDevice: "Unsynced data on this device",
    pendingRows:
      "{count, plural, one {# change queued on this device cannot be sent from here.} other {# changes queued on this device cannot be sent from here.}}",
    title: "Unsynced data from another account",
    /** `{server}` is a server's host name. */
    titleServer: "Unsynced data for {server}",
    serverSummary:
      "{count, plural, one {# change queued on this device while it used {server}.} other {# changes queued on this device while it used {server}.}}",
    serverSummaryWithRange:
      "{count, plural, one {# change queued on this device while it used {server}, from {range}.} other {# changes queued on this device while it used {server}, from {range}.}}",
    /** `{here}` is the server this device uses now. */
    serverExplanation:
      "They were never sent, and they are not sent to {here} — that would file them on a server they were not made for. Switch this device back to {server} on the sign-in screen to sync them, or discard them here.",
    summary:
      "{count, plural, one {# change queued on this device by an account that is not signed in.} other {# changes queued on this device by an account that is not signed in.}}",
    summaryWithRange:
      "{count, plural, one {# change queued on this device by an account that is not signed in, from {range}.} other {# changes queued on this device by an account that is not signed in, from {range}.}}",
    explanation:
      "They were never sent to a server, and they are not replayed under your account — that would file somebody else’s work into your workspace. Sign in as that account on this device to sync them, or discard them here.",
    ops: {
      start: "Started a timer",
      stop: "Stopped a timer",
      create: "Logged time",
      update: "Edited an entry",
      remove: "Deleted an entry",
      discard: "Discarded a timer",
      unknown: "Unrecognised change",
    },
    unknownTime: "Unknown time",
    discard: "{count, plural, one {Discard # change} other {Discard # changes}}",
    confirm: {
      title:
        "{count, plural, one {Discard # unsynced change?} other {Discard # unsynced changes?}}",
      description:
        "This deletes work that no server has ever received. It cannot be recovered — not by that account signing in here, and not from a backup. Sign in as that account on this device instead if it should be kept.",
      descriptionWithRange:
        "This deletes work tracked on {range} that no server has ever received. It cannot be recovered — not by that account signing in here, and not from a backup. Sign in as that account on this device instead if it should be kept.",
      serverDescription:
        "This deletes work that no server has ever received. It cannot be recovered — not by switching back to {server}, and not from a backup. Switch this device back to {server} instead if it should be kept.",
      serverDescriptionWithRange:
        "This deletes work tracked on {range} that no server has ever received. It cannot be recovered — not by switching back to {server}, and not from a backup. Switch this device back to {server} instead if it should be kept.",
      delete: "Delete permanently",
    },
    toasts: {
      discarded:
        "{count, plural, one {Discarded # unsynced change} other {Discarded # unsynced changes}}",
      discardFailed: "Could not discard those changes",
    },
  },
  secret: {
    warning: "Copy it now — this is the only time it is shown.",
    stored: "I have stored it",
    toasts: {
      copyUnavailable: "Copying is unavailable here — select the value by hand.",
      copied: "Copied to the clipboard.",
      copyFailed: "Could not copy — select the value and copy it by hand.",
    },
  },
  apiTokens: {
    title: "API tokens",
    description:
      "Keys for scripts, CI jobs and other tools that talk to the REST API instead of signing in. Each one is bound to this workspace and can never see more than you can. This list is yours alone — colleagues neither see nor can revoke the tokens you create here.",
    create: "New token",
    empty: {
      title: "No API tokens",
      description:
        "Create one when something needs to read or write your time without a browser.",
    },
    columns: {
      token: "Token",
      scopes: "Can do",
      created: "Created",
      lastUsed: "Last used",
      expires: "Expires",
      actions: "Actions",
    },
    states: {
      revoked: "Revoked",
      expired: "Expired",
    },
    noScopes: "Nothing",
    never: "Never",
    revoke: {
      title: "Revoke {name}?",
      titleThisToken: "Revoke this token?",
      description:
        "Anything still using it starts getting refused on its next request. Nothing it already recorded is lost, and the row stays here so you can see it was turned off.",
      action: "Revoke",
    },
    hint: {
      title: "Using a token",
      /** `header` is the literal HTTP header, inserted untranslated. */
      body: "Send it as <code>{header}</code> on requests to the REST API. Keep it in a secret store — anything holding it can act with the permissions ticked above.",
    },
    scopes: {
      entriesRead: {
        title: "Read time entries",
        description: "List entries, read one, and see the running timer.",
      },
      entriesWrite: {
        title: "Write time entries",
        description: "Create, edit and delete entries, and start or stop the timer.",
      },
      catalogRead: {
        title: "Read the catalog",
        description: "List clients, projects, tasks and tags.",
      },
      catalogWrite: {
        title: "Write the catalog",
        description: "Create, edit, archive and delete clients, projects, tasks and tags.",
      },
      reportsRead: {
        title: "Read reports",
        description: "Run the summary, detailed and weekly reports.",
      },
    },
    form: {
      title: "New API token",
      description:
        "A token authenticates scripts and integrations against the REST API. It belongs to this workspace and can never see more than you can.",
      namePlaceholder: "Invoicing script",
      nameRequired: "Name is required",
      nameHint: "Shown in the list below. Name it after the thing that will use it.",
      scopes: "What it may do",
      noScopes:
        "<b>This token can do nothing.</b> Nothing is ticked, so every request it makes is refused. Tick at least one capability.",
      expiry: "Expires (optional)",
      expiryInvalid: "That is not a date",
      expiryPast: "Pick a date in the future",
      expiryHint: "Leave empty and it works until you revoke it.",
      submit: "Create token",
    },
    reveal: {
      title: "Token created",
      /** `header` is the literal HTTP header, inserted untranslated. */
      description: "Send it as <code>{header}</code> on every REST request.",
      hint: "Only a hash of it is stored, so nothing here or in the database can show it again. If you lose it, revoke this token and create another.",
    },
    toasts: {
      created: "Token “{name}” created.",
      createFailed: "Could not create that token",
      revoked: "Token revoked.",
      revokeFailed: "Could not revoke that token",
    },
  },
  webhooks: {
    title: "Webhooks",
    description:
      "Push events to your own endpoint as they happen, instead of polling the API for them. Payloads are signed, and only carry what you are allowed to see. Webhooks you create are yours — nobody else in the workspace can see their URLs or change where they point.",
    create: "New webhook",
    empty: {
      title: "No webhooks",
      description: "Add an endpoint to be told when a timer starts or an entry changes.",
    },
    columns: {
      endpoint: "Endpoint",
      events: "Events",
      state: "State",
      lastDelivery: "Last delivery",
      actions: "Actions",
    },
    never: "Never",
    deliveriesAction: "Deliveries",
    toggle: {
      pause: "Pause this webhook",
      enable: "Switch this webhook on",
    },
    health: {
      active: "Active",
      paused: "Paused",
      failing: "Failing",
      failingDetail:
        "{count, plural, one {# failed delivery in a row. It is still retrying.} other {# failed deliveries in a row. It is still retrying.}}",
      turnedOff: "Turned off",
      turnedOffDetail:
        "{count, plural, one {Stopped after # failed delivery in a row. Switch it back on once the endpoint answers again.} other {Stopped after # failed deliveries in a row. Switch it back on once the endpoint answers again.}}",
    },
    deliveryStatus: {
      pending: "Queued",
      delivered: "Delivered",
      failed: "Failed",
      skippedVisibility: "Not sent",
    },
    deliveries: {
      title: "Recent deliveries",
      description:
        "The last attempts to reach <mono>{url}</mono>. Each failed delivery is retried on a widening schedule.",
      empty: {
        title: "Nothing delivered yet",
        description: "Attempts appear here as soon as one of the chosen events happens.",
      },
      columns: {
        when: "When",
        event: "Event",
        status: "Status",
        attempt: "Attempt",
        detail: "Detail",
      },
      skippedDetail: "You cannot see the entry this was about.",
      httpStatus: "HTTP {status}",
      /** `when` is an already formatted date and time. */
      nextTry: "Next try {when}",
    },
    delete: {
      title: "Delete this webhook?",
      description:
        "We stop calling <mono>{url}</mono> immediately, and its delivery log goes with it. The signing secret cannot be recovered — a new webhook gets a new one.",
    },
    hint: {
      title: "Verifying a delivery",
      /** The three arguments are literal header names and a payload shape, inserted untranslated. */
      body: "Each request carries <code>{timestampHeader}</code> and <code>{signatureHeader}</code>. Recompute the HMAC-SHA256 of <code>{signedPayload}</code> with your signing secret and compare — anything that does not match did not come from us.",
    },
    events: {
      entryStarted: "A timer started",
      entryStopped: "A running timer stopped",
      entryCreated: "An entry was added",
      entryUpdated: "An entry changed",
      entryDeleted: "An entry was deleted",
      invoiceCreated: "An invoice was created",
      invoiceStatusChanged: "An invoice changed status",
    },
    form: {
      title: "New webhook",
      description:
        "We POST a signed JSON payload to your endpoint whenever one of the events below happens in this workspace.",
      url: "Endpoint URL",
      urlRequired: "Endpoint URL is required",
      urlInvalid: "Enter a full URL, starting with https://",
      urlScheme: "Only http and https endpoints can be called",
      urlHint:
        "Must be reachable from the internet over https. Addresses inside the server’s own network are refused.",
      events: "When to call it",
      eventsRequired: "Pick at least one event",
      submit: "Create webhook",
    },
    reveal: {
      title: "Webhook created",
      /** `header` is the literal header name, inserted untranslated. */
      description:
        "Every delivery carries an <code>{header}</code> header. Verify it with this secret before trusting the payload.",
      label: "Signing secret",
      hint: "The server never reads it back out, so nothing can show it again. If you lose it, delete this webhook and create another.",
    },
    toasts: {
      created: "Webhook created.",
      createFailed: "Could not create that webhook",
      deleted: "Webhook deleted.",
      deleteFailed: "Could not delete that webhook",
      enabled: "Webhook switched on.",
      paused: "Webhook paused.",
      updateFailed: "Could not change that webhook",
    },
  },
  data: {
    roles: {
      ignored: "Don’t import",
      description: "Description",
      client: "Client",
      project: "Project",
      task: "Task",
      tags: "Tags",
      billable: "Billable",
      start: "Start (date and time)",
      end: "End (date and time)",
      date: "Date",
      startTime: "Start time",
      endDate: "End date",
      endTime: "End time",
      duration: "Duration",
      rate: "Hourly rate",
    },
    import: {
      title: "Import your history",
      description:
        "Bring in the time you tracked somewhere else. Export it from the other tool as CSV, drop the file here, and check what it would create before anything is written. A Track Your Time export (CSV or JSON) works too.",
      dropzone: "Drop a CSV or JSON export here",
      choose: "Choose a file",
      chooseDifferent: "Choose a different file",
      options: {
        skipDuplicates: {
          title: "Skip entries already here",
          description: "Lets you re-import an overlapping export without doubling anything.",
        },
        createMissing: {
          title: "Create missing projects, clients, tasks and tags",
          description: "Off, entries land with only the catalog you already have.",
        },
        defaultBillable: {
          title: "Treat unmarked entries as billable",
          description: "Only used for rows whose file says nothing either way.",
        },
        restoreSettings: {
          title: "Restore workspace settings",
          description: "Currency, rates and week start from the file replace this workspace’s.",
        },
        restoreFavorites: {
          title:
            "{count, plural, one {Restore # pinned quick start} other {Restore # pinned quick starts}}",
          description: "Pinned to your tracker, not to anyone else’s.",
        },
      },
      /** What else an import wrote, under the success toast. */
      receipt: {
        /** `{items}` is a comma-separated list of the counts below. */
        created: "Also created: {items}.",
        clients: "{count, plural, one {# client} other {# clients}}",
        projects: "{count, plural, one {# project} other {# projects}}",
        tasks: "{count, plural, one {# task} other {# tasks}}",
        tags: "{count, plural, one {# tag} other {# tags}}",
        favorites: "{count, plural, one {# pinned quick start} other {# pinned quick starts}}",
        settings: "workspace settings",
        skipped: "{count, plural, one {# entry was already here.} other {# entries were already here.}}",
      },
      commit: "{count, plural, one {Import # entry} other {Import # entries}}",
      /** `size` is an already formatted decimal number. */
      megabytes: "{size} MB",
      toasts: {
        readFailed: "Could not read that file",
        importFailed: "Could not import that file",
        /** `size` and `limit` are already formatted, e.g. "2.5 MB". */
        tooLarge:
          "That file is {size}; the limit is {limit}. Export it in date ranges and import the parts.",
        /** `duration` is an already formatted duration, e.g. "3h 20m". */
        imported:
          "{count, plural, one {Imported # entry — {duration} of tracked time.} other {Imported # entries — {duration} of tracked time.}}",
      },
    },
    preview: {
      stats: {
        ready: "{count, plural, one {entry to import} other {entries to import}}",
        duplicates: "already here",
        unreadable: "{count, plural, one {row not readable} other {rows not readable}}",
        trackedTime: "tracked time",
      },
      nothingNew: "Nothing new in this file.",
      /** `from` and `to` are already formatted dates; `timeZone` is an IANA name. */
      range: "{from} to {to}, read as {timeZone} time.",
      ambiguousDates:
        "Every date in this file could be read either way round — <strong>03/04</strong> is the 3rd of April or the 4th of March. Pick the one your file means before importing.",
      /** `version` is the export format number the file declares, e.g. 3. */
      newerVersion:
        "<strong>This file is from a newer version of Track Your Time</strong> (export format {version}). Entries and everything this version knows import as usual. Data this version does not know is skipped.",
      moneyRedacted:
        "<strong>This file’s money was blanked when it was exported.</strong> Entries, catalog and times import in full, but every rate in it is empty, so the imported history is priced by this workspace’s own rates rather than the ones it was tracked at.",
      invoicesDropped:
        "{count, plural, one {# invoice in this file is not imported — an issued invoice records something that happened, and re-creating it here would either bill nothing or bill the wrong hours twice.} other {# invoices in this file are not imported — an issued invoice records something that happened, and re-creating it here would either bill nothing or bill the wrong hours twice.}}",
      /** `time` is an already formatted clock time, e.g. "09:00". */
      dateDuration:
        "This file records a day and a length, but no clock time. Entries are laid out back-to-back from {time} in file order, so each day adds up correctly even though the times of day are invented.",
      columns: {
        title: "Columns",
        column: "Column",
        firstValue: "First value",
        importedAs: "Imported as",
        unnamed: "Column {number}",
        roleFor: "Role for {column}",
      },
      dateOrder: {
        label: "Dates",
        ariaLabel: "How dates are written",
        dmy: "Day first (31/12/2026)",
        mdy: "Month first (12/31/2026)",
        ymd: "Year first (2026-12-31)",
      },
      creates: {
        title: "This import will also create",
        clients: "Clients: {names}",
        projects: "Projects: {names}",
        tasks: "Tasks: {count, number}",
        tags: "Tags: {names}",
      },
      namesAndMore: "{names} and {count, plural, one {# more} other {# more}}",
      sample: {
        title: "{count, plural, one {First entry} other {First # entries}}",
        length: "Length",
        noDescription: "No description",
      },
      issues: {
        title: "{count, plural, one {# row needs attention} other {# rows need attention}}",
        /** `message` comes from the importer and is not translated. */
        row: "Row {row}: {message}",
      },
    },
    history: {
      title: "Past imports",
      description: "Each import can be rolled back as a unit, however long ago it ran.",
      columns: {
        file: "File",
        imported: "Imported",
      },
      unnamedFile: "Unnamed file",
      undone: "Undone",
      undo: {
        title: "Undo this import?",
        description:
          "{count, plural, one {# entry from {filename} will be deleted. Time you tracked by hand is never touched.} other {# entries from {filename} will be deleted. Time you tracked by hand is never touched.}}",
        descriptionUnnamed:
          "{count, plural, one {# entry from that file will be deleted. Time you tracked by hand is never touched.} other {# entries from that file will be deleted. Time you tracked by hand is never touched.}}",
        includeCatalog: "Also remove what it created",
        includeCatalogHint: "Projects, clients, tasks and tags go only if nothing else uses them.",
        keep: "Keep it",
        confirm: "Undo import",
      },
      toasts: {
        undone:
          "{count, plural, one {Removed # imported entry.} other {Removed # imported entries.}}",
        undoneWithProjects:
          "{count, plural, one {Removed # imported entry} other {Removed # imported entries}} {projects, plural, one {and # project.} other {and # projects.}}",
        undoFailed: "Could not undo that import",
      },
    },
    export: {
      title: "Export everything",
      description:
        "Your whole workspace, in a file you keep. The JSON holds entries, clients, projects, tasks, tags, workspace settings and your pinned quick starts, and imports back; issued invoices ride along as a record and are not re-created on import. The CSV holds the entries, in a shape any spreadsheet opens and this importer reads back.",
      from: "From",
      to: "To",
      count: "{count, plural, one {# entry in this range.} other {# entries in this range.}}",
      emptyRangeHint: "Leave both dates empty to export everything ever tracked.",
      /** `max` is an already formatted number. */
      tooLarge:
        "That is more than {max} entries — more than one file carries. Narrow the dates and export it in parts, so no part is quietly missing.",
      redacted:
        "Every rate is left out of your download — the rate on each entry as well as project rates, budgets and invoice amounts, because an entry’s rate is a copy of the project’s. Your role does not include other members’ money. Times, catalog and everything else are complete.",
      downloadJson: "Download JSON backup",
      downloadCsv: "Download CSV",
      toasts: {
        cannotSave: "This app can’t save files yet — open Track Your Time in a browser to export.",
        failed: "Could not export",
        exportedEntries:
          "{count, plural, one {Exported # entry.} other {Exported # entries.}}",
        exportedFile: "Exported {filename}",
      },
    },
  },
  device: {
    title: "Connect a device",
    description:
      "Enter the code shown by Raycast, the CLI or whichever app is waiting to connect. Approving signs it in as you.",
    code: "Code",
    codeHint: "Only approve a code you are looking at right now, on a device you control.",
    approve: "Approve",
    decline: "Decline",
    errors: {
      invalidRequest: "That code is not valid or has already been used.",
      expiredToken: "That code has expired. Start the connection again on your device.",
      accessDenied: "That code was already declined.",
      alreadyProcessed: "That code has already been used.",
      unauthorized: "Sign in again, then re-enter the code.",
      claimFailed: "That code is not valid or has expired.",
      approveFailed: "Could not approve that code.",
      denyFailed: "Could not decline that code.",
      network: "Could not reach the server. Check your connection.",
    },
    result: {
      approvedTitle: "Device connected",
      approvedDescription:
        "You can go back to that app — it is signed in and syncing. It now appears under Settings → Devices, where you can sign it out any time.",
      deniedTitle: "Code declined",
      deniedDescription: "Nothing was connected. If you did not start this, no action is needed.",
      openSettings: "Open settings",
      again: "Enter another code",
    },
  },
  language: {
    title: "Language",
    description: "Saved to your account. “System” follows the language of each device.",
    /** Each option is written in its own language, so it can be found by someone who cannot read the current one. */
    system: "System",
    en: "English",
    de: "Deutsch",
    pseudo: "Pseudo (dev only)",
  },
  businessProfile: {
    title: "Business profile",
    description: "Who issues your invoices. A new invoice copies these details; invoices you already created keep the details they were created with.",
    legalName: "Legal name",
    addressLine: "Address line {line}",
    postalCode: "Postal code",
    city: "City",
    country: "Country code",
    countryHint: "Two letters, for example DE or GB.",
    taxId: "Tax ID",
    email: "Email",
    phone: "Phone",
    website: "Website",
    paymentDetails: "Payment details",
    paymentDetailsHint: "Bank account or payment link. The invoice prints this text as you write it.",
    paymentTermsDays: "Payment terms in days",
    paymentTermsHint: "Sets the suggested due date of a new invoice. Leave empty for no terms.",
    invoiceFooter: "Invoice footer",
    save: "Save business profile",
    saved: "Business profile saved.",
    saveFailed: "Could not save the business profile.",
    forbidden: "Only an owner or admin can change the business profile.",
    hiddenByRole: "Your workspace role cannot see the business profile. Ask an owner or admin of this workspace.",
    loadFailed: "Could not load the business profile.",
    invalidTerms: "Enter a whole number of days from 0 to 365.",
    invalidCountry: "Enter a two-letter country code.",
    sections: {
      taxIdentity: "Tax identity",
      contact: "Contact",
      einvoiceAddress: "E-invoice address",
      bank: "Bank account",
      vat: "VAT",
    },
    vatId: "VAT ID",
    vatIdHint: "USt-IdNr, for example DE123456789.",
    taxNumber: "Tax number",
    taxNumberHint: "Steuernummer. Needed when you have no VAT ID.",
    legacyTaxId: "Tax ID printed so far",
    legacyTaxIdHint: "Invoices print this text until you enter a VAT ID or a tax number. Move it into the field it belongs to.",
    useAsVatId: "Use as VAT ID",
    useAsTaxNumber: "Use as tax number",
    registrationNumber: "Register number",
    registrationNumberHint: "Commercial register entry, for example HRB 12345, Amtsgericht Berlin.",
    sellerIdentifier: "Seller identifier",
    sellerIdentifierHint: "An e-invoice without a VAT ID needs a register number or a seller identifier.",
    contactName: "Contact person",
    contactNameHint: "XRechnung needs a contact person, a phone number and an email address.",
    electronicAddressHint: "Where customers send e-invoices to you. Leave it empty to use your email address.",
    iban: "IBAN",
    bic: "BIC",
    bankName: "Bank name",
    accountHolder: "Account holder",
    bankHint: "Printed on the invoice and written into the e-invoice. Do not repeat them in the payment details.",
    smallBusiness: "Small business under § 19 UStG",
    smallBusinessHint: "Your invoices show no VAT.",
    smallBusinessNote: "Exemption note",
    smallBusinessNoteHint: "Printed on each invoice as the reason for no VAT.",
    defaultTax: "Default VAT",
    defaultTaxHint: "Selected on every new invoice. A client can have its own default category.",
    invalidFields: "Correct the marked fields to save.",
    smallBusinessNeedsE: "A small business invoices without VAT: choose Exempt (E) as the default.",
    backToInvoice: "Back to the invoice",
  },
  /** Settings → Account → Two-factor authentication. */
  twoFactor: {
    title: "Two-factor authentication",
    googleAccount: "Your account signs in with Google, which has its own two-factor settings.",
    on: "On. Signing in needs a code from your authenticator app or a backup code.",
    off: "Off. Add a code from an authenticator app to every sign-in.",
    turnOn: "Turn on",
    turnOff: "Turn off",
    invalidPassword: "That password is not correct.",
    invalidCode: "That code is not valid. Check the time on your device and try the next code.",
    enabledToast: "Two-factor authentication is on",
    disabledToast: "Two-factor authentication is off",
    enable: {
      title: "Turn on two-factor authentication",
      description:
        "Every sign-in on the web will ask for a code from an authenticator app. Until the mobile app and the browser extension support it, they cannot sign in to this account; devices that are already signed in stay signed in.",
    },
    scan: {
      title: "Scan the QR code",
      description: "Scan it with your authenticator app, then enter the 6-digit code the app shows.",
      qrLabel: "QR code for your authenticator app",
      manualKey: "Cannot scan it? Enter this key:",
      code: "Code",
      verify: "Verify",
    },
    codes: {
      title: "Save your backup codes",
      description:
        "Each code signs you in once if you lose your authenticator app. Store them somewhere safe. They are not shown again.",
      copied: "Backup codes copied",
      copyFailed: "Could not copy. Select the codes instead.",
      saved: "I saved them",
    },
    disable: {
      title: "Turn off two-factor authentication?",
      description: "Signing in will need only your password. Your backup codes stop working.",
    },
  },
  /** Settings → Account → Password. */
  password: {
    title: "Password",
    googleAccount: "Your account signs in with Google, so it has no password to change.",
    description: "Change the password you sign in with.",
    change: "Change password",
    minLength: "Use at least {min, number} characters.",
    current: "Current password",
    new: "New password",
    confirm: "Confirm new password",
    revokeOthers: "Sign out every other device, including the mobile app, the browser extension and Raycast",
    problems: {
      currentMissing: "Enter your current password.",
      tooShort: "The new password needs at least {min, number} characters.",
      mismatch: "The new passwords do not match.",
      unchanged: "The new password is the same as the current one.",
      wrongCurrent: "That current password is not correct. Nothing changed.",
      tooLong: "The new password is too long.",
      failed: "Your password could not be changed. Try again.",
    },
    toasts: {
      othersStillSignedIn: "Password changed, but other devices are still signed in",
      othersStillSignedInHint: "Sign them out in Settings → Devices.",
      changedOthersSignedOut: "Password changed. Other devices are signed out.",
      changed: "Password changed",
    },
  },
  /** Settings → Account → Email address. */
  email: {
    title: "Email address",
    description: "Where sign-in links and account emails go.",
    change: "Change email",
    dialogTitle: "Change email address",
    current: "Currently {email}. The new address gets a link, and the change happens when you open it.",
    newAddress: "New email address",
    sendLink: "Send link",
    sentTitle: "Confirm the new address",
    sent: "We sent a link to {email}. Your email changes when you open it.",
    sentToLog:
      "This server sends no email, so the confirmation link for {email} was written to the server log. Your email changes when the link is opened.",
    invalid: "Enter a valid email address.",
    same: "That is already your email address.",
    failed: "Your email could not be changed. Try again.",
  },
  /** Settings → Data → Move to another server. */
  moveServer: {
    title: "Move to another server",
    description:
      "Copy this workspace from {here} to another Track Your Time server — your own, or {cloud}. Entries, clients, projects, tasks, tags, workspace settings and your pinned quick starts arrive; nothing here is changed or deleted.",
    open: "Move my data…",
    from: "From {here}.",
    fromTo: "From {here} to {there}.",
    targetLabel: "Move to",
    ownServer: "My own server",
    address: "Server address",
    check: "Check server",
    sameServer: "That is {here}, the server this workspace is already on.",
    untrustedApp:
      "{host} does not accept sign-ins from this app yet. Its administrator needs to set TRUST_STORE_APPS=true, or add capacitor://localhost and https://localhost to TRUSTED_ORIGINS.",
    signInHint: "Sign in to your account on {server}. The data is copied into that account's workspace.",
    signUpHint: "Create an account on {server} to copy the data into.",
    toSignUp: "No account there yet? Create one",
    toSignIn: "Already have an account there? Sign in",
    createAccount: "Create account",
    signInFailed: "Could not sign in to {host}.",
    counting: "Counting the entries to copy…",
    willCopy:
      "{count, plural, one {# finished entry will be copied from {here}.} other {# finished entries will be copied from {here}.}}",
    targetHasEntries:
      "{count, plural, one {The workspace on {server} already has # entry. Entries already there are skipped, and its workspace settings are left as they are.} other {The workspace on {server} already has # entries. Entries already there are skipped, and its workspace settings are left as they are.}}",
    settingsComeAlong: "Workspace settings — currency, rates, week start — come along too.",
    catalogComesAlong:
      "Clients, projects, tasks and tags arrive with the entries that use them. Issued invoices are not re-created.",
    running: "A timer is running. It is not copied until it is stopped.",
    redacted: "Your role does not include other members’ money, so every rate is left out of the copy.",
    copyTo: "Copy to {server}",
    stopped: "The move stopped.",
    preparing: "Getting ready…",
    exporting: "Exporting from {here} (part {done, number} of {total, number})…",
    importing: "Importing on {server} (part {done, number} of {total, number})…",
    fileUntrusted:
      "{server} does not accept requests from this page's address ({origin}), so the data goes across in a file.",
    fileBlocked:
      "Your browser could not sign in to {server} from this page, so the data goes across in a file.",
    download: "Download the move file",
    savedFiles:
      "{count, plural, one {Saved # file.} other {Saved # files — import all of them.}}",
    openTarget: "Open <target></target> and sign in, or create an account.",
    importStep:
      "In Settings → Data → Import your history, choose the file and import it. The preview shows the entries before anything is written.",
    trustHint: "To copy directly next time, add {origin} to that server's TRUSTED_ORIGINS.",
    cannotSaveFiles: "This app cannot save files. Open Track Your Time in a browser to move through a file.",
    exportFailed: "Could not export this workspace.",
    tooLargeDay: "The entries on {day} are too large for one import. Export that day separately.",
    nothingToMove: "There are no finished entries in this workspace to move.",
    found: "Found {version} at {host}.",
    done: {
      complete:
        "{count, plural, one {All # entry is on {server}.} other {All # entries are on {server}.}}",
      completeWithTime:
        "{count, plural, one {All # entry is on {server} — {time} of tracked time copied.} other {All # entries are on {server} — {time} of tracked time copied.}}",
      incomplete:
        "{missing, plural, one {# entry} other {# entries}} of {total, number} did not arrive. Run the move again — entries already there are skipped.",
      entries: "Entries copied",
      skipped: "Entries already there",
      clients: "Clients",
      projects: "Projects",
      tasks: "Tasks",
      tags: "Tags",
      favorites: "Pinned quick starts",
      settings: "Workspace settings",
      restored: "Restored",
      leftAsTheyWere: "Left as they were",
      nothingChanged: "Nothing on {here} was changed. Delete it there once you have checked the data on {there}.",
      stay: "Stay on {here}",
      switch: "Switch this device to {there}",
      openTarget: "Open {host}",
    },
  },
} as const;
