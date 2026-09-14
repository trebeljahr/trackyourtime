import type { Translation } from "@starter/shared";

import type { shell as source } from "../en/shell";

/** German `shell`. Terms follow i18n/GLOSSARY.de.md; voice is „du“. */
export const shell: Translation<typeof source> = {
  theme: {
    change: "Design ändern",
    light: "Hell",
    dark: "Dunkel",
    system: "System",
  },
  palette: {
    title: "Befehlspalette",
    description: "Suche nach einer Aktion, einer Seite, einem Projekt, einem Kunden, einer Tätigkeit oder einem Schlagwort.",
    placeholder: "Befehl eingeben oder suchen …",
    empty: "Keine Treffer.",
    open: "Suchen",
    openHint: "Befehlspalette öffnen",
    groups: {
      timer: "Timer",
      navigate: "Gehe zu",
      projects: "Projekte",
      clients: "Kunden",
      tasks: "Tätigkeiten",
      tags: "Schlagwörter",
      discard: "Laufenden Timer verwerfen?",
    },
    actions: {
      startTimer: "Timer starten",
      stopTimer: "Timer stoppen",
      discardRunning: "Laufenden Timer verwerfen",
      startFavorite: "Favorit starten: {label}",
      continueRecent: "Fortsetzen: {label}",
      startOn: "Timer für {name} starten",
      openReport: "Bericht nach {name} gefiltert öffnen",
      keepRunning: "Weiterlaufen lassen",
      confirmDiscard: "{elapsed} von {label} verwerfen",
      confirmDiscardHint: "Löscht den Eintrag. Das lässt sich nicht rückgängig machen.",
      noDescription: "Keine Beschreibung",
    },
    keywords: {
      start: "neu, beginnen, starten",
      stop: "beenden, stoppen",
      discard: "löschen, abbrechen, verwerfen",
      favorite: "Favorit",
      recent: "zuletzt verwendet",
      navigate: "gehe zu, öffnen",
      keep: "nein, zurück, abbrechen",
      confirmDiscard: "ja, löschen, verwerfen",
    },
  },
};
