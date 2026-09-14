/**
 * English `tracker` messages — the SOURCE catalog for the tracker: /track, the timer bar, entry list, entry dialogs, idle/runaway prompts, favorites and recents, offline queue notices, the timesheet grid.
 *
 * Add keys here first (grouped by component or screen, camelCase), then the
 * same keys in ../de/tracker.ts: `tsc` fails until both agree. ICU syntax:
 * `{name}`, `{count, plural, one {# entry} other {# entries}}`, `<b>…</b>`
 * with `t.rich`. Words every screen uses are already in `common`.
 */
export const tracker = {
  description: {
    label: "Description",
    placeholder: "What are you working on?",
    suggestions: "Past descriptions",
    fill: "Use “{description}” with its project, task, tags and billable setting",
    legend: "Tab completes · {shortcut} brings its project, task and tags",
  },
} as const;
