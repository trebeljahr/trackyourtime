import type { Translation } from "@starter/shared";

import type { tracker as source } from "../en/tracker";

/** German `tracker`. Terms follow i18n/GLOSSARY.de.md; voice is „du“. */
export const tracker: Translation<typeof source> = {
  description: {
    label: "Beschreibung",
    placeholder: "Woran arbeitest du?",
    suggestions: "Frühere Beschreibungen",
    fill: "„{description}“ mit Projekt, Tätigkeit, Schlagwörtern und Abrechenbarkeit übernehmen",
    legend: "Tab vervollständigt · {shortcut} übernimmt Projekt, Tätigkeit und Schlagwörter",
  },
};
