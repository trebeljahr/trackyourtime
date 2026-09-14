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
  },
} as const;
