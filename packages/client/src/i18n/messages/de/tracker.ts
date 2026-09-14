import type { Translation } from "@starter/shared";

import type { tracker as source } from "../en/tracker";

/** German `tracker`. Terms follow i18n/GLOSSARY.de.md; voice is „du“. */
export const tracker: Translation<typeof source> = {
  workspace: {
    replaced: "Dein Timer in {name} wurde gestoppt",
    runningElsewhere: "Läuft in {name}",
    runningElsewhereHint: "Dieser Timer läuft in einem anderen Arbeitsbereich. Wechsle zu {name}, um ihn zu bearbeiten, oder stoppe ihn hier.",
  },
  queue: {
    held: "{count, plural, one {# Änderung} other {# Änderungen}} nicht gesendet",
    heldHint: "Von einem anderen Konto, für einen anderen Server oder in einem verlassenen Arbeitsbereich in die Warteschlange gestellt. Sie bleiben erhalten und werden von hier nie gesendet.",
  },
  description: {
    label: "Beschreibung",
    placeholder: "Woran arbeitest du?",
    suggestions: "Frühere Beschreibungen",
    fill: "„{description}“ mit Projekt, Tätigkeit, Schlagwörtern und Abrechenbarkeit übernehmen",
    legend: "Tab vervollständigt · {shortcut} übernimmt Projekt, Tätigkeit und Schlagwörter",
  },
};
