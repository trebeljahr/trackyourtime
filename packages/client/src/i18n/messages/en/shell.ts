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
    },
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
} as const;
