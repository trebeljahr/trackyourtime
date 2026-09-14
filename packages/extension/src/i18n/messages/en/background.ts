/**
 * English `background` — the SOURCE catalog for the browser extension's service worker (badge text, notifications, error messages sent to the popup).
 *
 * Add keys here, then in ../de/background.ts (`tsc` enforces parity). ICU syntax as
 * in the web client. Reuse the web client's German terms
 * (packages/client/src/i18n/GLOSSARY.de.md) so the two surfaces agree.
 *
 * Error messages are NOT here: the popup translates them from their stable
 * `code` in its own catalog (`popup.errors`), because the popup always knows
 * the reader's language synchronously and a worker that MV3 evicts every 30
 * seconds does not. The worker's own English `message` stays a developer
 * fallback for codes the popup does not know.
 */
export const background = {
  badge: {
    /**
     * The toolbar badge fits about four characters, so the unit is a single
     * letter with no space. Translate to the shortest unit a reader recognises.
     */
    minutes: "{minutes, number}m",
    hours: "{hours, number}h",
  },
} as const;
