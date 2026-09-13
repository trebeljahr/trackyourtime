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
} as const;
