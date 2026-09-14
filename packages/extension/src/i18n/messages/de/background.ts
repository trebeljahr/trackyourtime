import type { Translation } from "@starter/shared";

import type { background as source } from "../en/background";

/** German `background`. Terms follow packages/client/src/i18n/GLOSSARY.de.md; voice is „du“. */
export const background: Translation<typeof source> = {
  badge: {
    // "m" and "h" are the shortest units a German reader recognises on a
    // timer badge; "min" would push a two-digit value past four characters.
    minutes: "{minutes, number}m",
    hours: "{hours, number}h",
  },
};
