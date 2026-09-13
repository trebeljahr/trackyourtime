/**
 * English `settings` messages — the SOURCE catalog for Settings (every tab), profile, devices, API tokens, webhooks, import/export panels, account deletion.
 *
 * Add keys here first (grouped by component or screen, camelCase), then the
 * same keys in ../de/settings.ts: `tsc` fails until both agree. ICU syntax:
 * `{name}`, `{count, plural, one {# entry} other {# entries}}`, `<b>…</b>`
 * with `t.rich`. Words every screen uses are already in `common`.
 */
export const settings = {
  language: {
    title: "Language",
    description: "Saved to your account. “System” follows the language of each device.",
    /** Each option is written in its own language, so it can be found by someone who cannot read the current one. */
    system: "System",
    en: "English",
    de: "Deutsch",
    pseudo: "Pseudo (dev only)",
  },
} as const;
