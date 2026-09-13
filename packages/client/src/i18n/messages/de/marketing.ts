import type { Translation } from "@starter/shared";

import type { marketing as source } from "../en/marketing";

/** German `marketing`. Terms follow i18n/GLOSSARY.de.md; voice is „du“. */
export const marketing: Translation<typeof source> = {
  languageSwitch: {
    toEn: "English",
    toDe: "Deutsch",
    label: "Sprache",
  },
};
