/**
 * English `marketing` messages — the SOURCE catalog for the public pages (landing, privacy, support, extension, raycast, mobile) and their metadata. Rendered at BUILD time in both locales — see i18n/marketing.ts.
 *
 * Add keys here first (grouped by component or screen, camelCase), then the
 * same keys in ../de/marketing.ts: `tsc` fails until both agree. ICU syntax:
 * `{name}`, `{count, plural, one {# entry} other {# entries}}`, `<b>…</b>`
 * with `t.rich`. Words every screen uses are already in `common`.
 */
export const marketing = {
  languageSwitch: {
    /** Link to the other language, written in THAT language. */
    toEn: "English",
    toDe: "Deutsch",
    label: "Language",
  },
} as const;
