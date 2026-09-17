/**
 * English `shell` messages — the SOURCE catalog for the app shell: navigation, header, mobile tab bar, theme toggle, sync status, auth screens (login, signup, password reset, device approval), 404.
 *
 * Add keys here first (grouped by component or screen, camelCase), then the
 * same keys in ../de/shell.ts: `tsc` fails until both agree. ICU syntax:
 * `{name}`, `{count, plural, one {# entry} other {# entries}}`, `<b>…</b>`
 * with `t.rich`. Words every screen uses are already in `common`.
 */
export const shell = {
  workspace: {
    open: "Switch workspace",
    current: "Workspace: {name}",
    title: "Workspaces",
    description: "Choose the workspace this device tracks time into. The browser extension and Raycast keep their own choice.",
    active: "Current",
    members: "{count, plural, one {# member} other {# members}}",
    roles: {
      owner: "Owner",
      admin: "Admin",
      member: "Member",
    },
    switched: "Switched to {name}",
    lost: "You no longer have access to {name}",
    runningIn: "Running in {name}",
  },
  theme: {
    change: "Change theme",
    light: "Light",
    dark: "Dark",
    system: "System",
  },
  palette: {
    title: "Command palette",
    description: "Search for an action, a page, a project, a client, a task or a tag.",
    placeholder: "Type a command or search…",
    empty: "Nothing matches.",
    open: "Search",
    openHint: "Open the command palette",
    /** The shortcut off macOS, where ⌘K is shown instead. */
    ctrlK: "Ctrl+K",
    groups: {
      timer: "Timer",
      navigate: "Go to",
      projects: "Projects",
      clients: "Clients",
      tasks: "Tasks",
      tags: "Tags",
      discard: "Discard running timer?",
    },
    actions: {
      startTimer: "Start timer",
      stopTimer: "Stop timer",
      discardRunning: "Discard running timer",
      startFavorite: "Start favorite: {label}",
      continueRecent: "Continue: {label}",
      startOn: "Start timer on {name}",
      openReport: "Open report filtered by {name}",
      keepRunning: "Keep it running",
      confirmDiscard: "Discard {elapsed} of {label}",
      confirmDiscardHint: "Deletes the entry. This cannot be undone.",
      noDescription: "No description",
    },
    // Extra search words, comma-separated. Translated rather than kept in
    // English: a German reader searches in German.
    keywords: {
      start: "new, begin",
      stop: "end, finish",
      discard: "delete, cancel",
      favorite: "favorite",
      recent: "recent",
      navigate: "go to, open",
      keep: "no, back, cancel",
      confirmDiscard: "yes, delete, discard",
    },
  },
  nav: {
    open: "Open navigation",
    close: "Close navigation",
    sections: {
      manage: "Manage",
    },
    items: {
      track: "Track",
      timesheet: "Timesheet",
      calendar: "Calendar",
      reports: "Reports",
      clients: "Clients",
      projects: "Projects",
      tasks: "Tasks",
      tags: "Tags",
      invoices: "Invoices",
      members: "Members",
      settings: "Settings",
    },
  },
  tabBar: {
    label: "Primary",
    track: "Track",
    reports: "Reports",
    more: "More",
  },
  sync: {
    open: "Live — changes sync across your devices",
    connecting: "Connecting…",
    closed: "Offline — reconnecting",
  },
  userMenu: {
    label: "Account menu",
    signedIn: "Signed in",
    profile: "Profile",
    settings: "Settings",
  },
  auth: {
    confirmPassword: "Confirm password",
    newPassword: "New password",
    passwordsDoNotMatch: "Passwords do not match",
    errors: {
      invalidCredentials: "Invalid email or password.",
      invalidEmail: "Enter a valid email address.",
      userExists: "An account with this email already exists.",
      passwordTooShort: "The password is too short.",
      passwordTooLong: "The password is too long.",
      tooManyRequests: "Too many attempts. Wait a minute and try again.",
      loginFailed: "Could not log in. Try again.",
      signupFailed: "Could not create the account. Try again.",
    },
    login: {
      title: "Log in",
      subtitle: "Enter your credentials to access your account",
      submit: "Log in",
      submitting: "Logging in…",
      forgotPassword: "Forgot your password?",
      noAccount: "Don't have an account? <link>Sign up</link>",
      /** The two-factor challenge ran out; the password step starts over. */
      challengeExpired: "The sign-in took too long. Enter your password again.",
      emailNotVerified: "Verify your email address first. We sent a new verification link to your inbox.",
    },
    twoFactor: {
      title: "Two-factor authentication",
      signingInAs: "Signing in as {email}",
      nativeUnsupported:
        "This account uses two-factor authentication, which the app does not support yet. Sign in on the web app instead.",
      /** The desktop app can: through the browser, below the form. */
      desktopUseBrowser:
        "This account uses two-factor authentication. Use Sign in with your browser to sign in to the desktop app.",
      totpLabel: "Authentication code",
      backupLabel: "Backup code",
      totpHint: "Enter the 6-digit code from your authenticator app.",
      backupHint:
        "Enter one of the backup codes you saved when you turned on two-factor authentication. Each code works once.",
      invalidTotp: "That code is not valid. Check the time on your device and try the next code.",
      invalidBackup: "That backup code is not valid or has already been used.",
      unexpected: "An unexpected error occurred",
      verify: "Verify",
      verifying: "Verifying...",
      useBackup: "Use a backup code",
      useTotp: "Use an authenticator code",
    },
    google: {
      continue: "Continue with Google",
      shellNote: "Google sign-in works on the web app only. Use your email and password here.",
      desktopNote:
        "Google sign-in does not work inside the desktop app. Use Sign in with your browser, then choose Google there.",
      unconfiguredNote: "Google sign-in is not set up on this server.",
      couldNotStart: "Google sign-in could not start",
    },
    /** The desktop app's device-flow sign-in (the browser approves the app). */
    browserSignIn: {
      start: "Sign in with your browser",
      hint: "For accounts with two-factor authentication or Google sign-in.",
      starting: "Starting…",
      waitingTitle: "Approve this app in your browser",
      waiting:
        "Your browser opened a page that asks you to approve this device. Check that the page shows this code:",
      reopen: "Open the page again",
      cancel: "Cancel",
      denied:
        "The sign-in was declined in the browser. Try again, or sign in with your email and password.",
      expired: "The code expired before it was approved. Start again.",
      failed: "The browser sign-in could not start. Check your connection and try again.",
    },
    revoked: {
      title: "You were signed out",
      pending:
        "{count, plural, one {This device's access was revoked from another device. # unsent change is still saved here and will be sent when you sign in again.} other {This device's access was revoked from another device. # unsent changes are still saved here and will be sent when you sign in again.}}",
      none: "This device's access was revoked from another device. Sign in again to continue.",
    },
    signup: {
      title: "Create an account",
      subtitle: "Enter your details to get started",
      submit: "Sign up",
      submitting: "Creating account…",
      haveAccount: "Already have an account? <link>Log in</link>",
      verifyTitle: "Check your inbox",
      verifySubtitle: "We sent a verification link to {email}. Open it, then log in.",
      goToLogin: "Go to log in",
    },
    forgot: {
      title: "Forgot password",
      subtitle: "Enter your email and we will send you a reset link",
      submit: "Send reset link",
      submitting: "Sending…",
      sent: "If an account exists for {email}, you will receive a password reset link shortly.",
      backToLogin: "Back to login",
    },
    reset: {
      title: "Reset password",
      subtitle: "Enter your new password",
      submit: "Reset password",
      submitting: "Resetting…",
      failed: "Failed to reset password. The link may have expired.",
      /** better-auth's INVALID_TOKEN: the link expired or was already used. */
      expired: "This reset link has expired or was already used. Request a new one.",
      requestNew: "Request a new link",
    },
  },
  /** The phone app's server choice on /login and /signup. */
  serverPicker: {
    current: "Server: <current>{label}</current>",
    groupLabel: "Server",
    /** The build's own server when it is not the cloud. */
    defaultServer: "Default ({host})",
    ownServer: "My own server",
    address: "Server address",
    pending:
      "{count, plural, one {# unsent change stays on this device for {server}. It is sent when you switch back, never to another server.} other {# unsent changes stay on this device for {server}. They are sent when you switch back, never to another server.}}",
    found: "Found {version} at {host}.",
    checking: "Checking…",
    use: "Use this server",
    untrusted:
      "{host} is a Track Your Time server, but it does not accept sign-ins from this app yet. Its administrator needs to set TRUST_STORE_APPS=true, or add {origins} to TRUSTED_ORIGINS.",
    creatingOn: "Creating an account on <server>{label}</server>.",
    change: "Change server",
    serverTooOld:
      "{host} runs an API level ({level}) this app cannot use. This app needs level {min} or higher. Ask the server's administrator to update it.",
    appTooOld: "{host} needs a newer version of this app. Update the app, then try again.",
  },
  /**
   * The persistent banner when this app and its server cannot work together
   * (docs/versioning.md). Shown after mount only.
   */
  versionBanner: {
    serverTooOld:
      "This server runs v{release} (API level {level}). This app needs level {min} or higher. Ask your server admin to update.",
    serverTooOldUnknownRelease:
      "This server runs an older version (API level {level}). This app needs level {min} or higher. Ask your server admin to update.",
    howToUpdate: "How to update a server",
    clientTooOld: "This app is too old for this server. Update the app.",
  },
  /**
   * Why a typed server address or the server behind it cannot be used. Keyed by
   * the `problem` @starter/core reports; its own English `message` is for
   * Raycast and logs.
   */
  serverProblems: {
    empty: "Enter your server's address.",
    invalidUrl: "“{input}” is not a web address. It looks like https://track.example.com.",
    insecure:
      "Use https:// for {host}. Plain http:// sends your password unencrypted, so it is only accepted for localhost.",
    unreachable: "Could not reach {host}. Check the address, and that the server is running.",
    notTrackYourTime:
      "{host} answered, but it is not a Track Your Time server. Enter the address you open Track Your Time at.",
    unhealthy:
      "{host} is a Track Your Time server, but it cannot reach its database right now. Try again in a minute.",
  },
  notFound: {
    metaTitle: "Page not found",
    homeLabel: "Track Your Time home",
    title: "This page does not exist",
    body: "The address may be mistyped, or the page moved. Your tracked time is not affected.",
    openTracker: "Open the tracker",
    home: "Go to the home page",
    report: "Followed a link from Track Your Time itself? <link>Tell us</link> so we can fix it.",
  },
  /** The notice a web tab shows after a newer build was deployed. */
  update: {
    available: "A new version of Track Your Time is available.",
    reload: "Reload",
  },
  /** app/global-error.tsx and app/app/error.tsx. */
  errorPage: {
    title: "This page stopped working",
    body: "Something went wrong while showing this page. Reload to try again.",
    chunkBody: "Track Your Time was updated while this page was open. Reload to get the new version.",
    reload: "Reload",
    retry: "Try again",
  },
  ui: {
    combobox: {
      placeholder: "Select…",
      search: "Search…",
      clear: "Clear selection",
      create: "Create \"{query}\"",
    },
    command: {
      title: "Command palette",
      description: "Search for a command to run.",
    },
  },
  /** The desktop app's tray menu and quit notice, drawn by the main process. */
  desktop: {
    tray: {
      stop: "Stop timer",
      startTimer: "Start timer…",
      recentHeading: "Continue",
      open: "Open Track Your Time",
      settings: "Settings…",
      quit: "Quit Track Your Time",
      noDescription: "(no description)",
      idleTooltip: "Track Your Time: no timer running",
      unsent: "{count, plural, one {# change not sent yet} other {# changes not sent yet}}",
      runningBadge: "Timer running",
      restartToUpdate: "Restart to update",
    },
    quitUnsent: {
      title: "{count, plural, one {# change is not sent yet} other {# changes are not sent yet}}",
      body: "They stay on this computer. Track Your Time sends them the next time it starts and reaches the server.",
      button: "Quit",
    },
  },
} as const;
