/**
 * English `shell` messages — the SOURCE catalog for the app shell: navigation, header, mobile tab bar, theme toggle, sync status, auth screens (login, signup, password reset, device approval), 404.
 *
 * Add keys here first (grouped by component or screen, camelCase), then the
 * same keys in ../de/shell.ts: `tsc` fails until both agree. ICU syntax:
 * `{name}`, `{count, plural, one {# entry} other {# entries}}`, `<b>…</b>`
 * with `t.rich`. Words every screen uses are already in `common`.
 */
export const shell = {
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
} as const;
