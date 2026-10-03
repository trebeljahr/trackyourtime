import type { Translation } from "@starter/shared";

import type { calendar as source } from "../en/calendar";

/** German `calendar`. Terms follow i18n/GLOSSARY.de.md; voice is „du“. */
export const calendar: Translation<typeof source> = {
  toolbar: {
    visibleHours: "Sichtbare Stunden",
    zoom: "Zoom",
    zoomIn: "Vergrößern",
    zoomOut: "Verkleinern",
    resetZoom: "Zoom zurücksetzen",
    resetZoomHint: "Zoom zurücksetzen (0)",
    undo: "Rückgängig",
    undoChange: "{change} rückgängig machen",
    undoHint: "Rückgängig (Strg/⌘ + Z)",
    undoChangeHint: "{change} rückgängig machen (Strg/⌘ + Z)",
    redo: "Wiederholen",
    redoChange: "{change} wiederholen",
    redoHint: "Wiederholen (Strg/⌘ + Umschalt + Z)",
    redoChangeHint: "{change} wiederholen (Strg/⌘ + Umschalt + Z)",
    addEntry: "Eintrag hinzufügen",
  },
  history: {
    changes: {
      move: "Verschiebung",
      timeChange: "Zeitänderung",
      descriptionChange: "Beschreibungsänderung",
      projectChange: "Projektänderung",
      tagChange: "Schlagwortänderung",
      billableChange: "Abrechenbarkeitsänderung",
      edit: "Bearbeitung",
      create: "Erstellung",
      delete: "Löschung",
    },
    undid: "{change} rückgängig gemacht",
    redid: "{change} wiederholt",
    blocked: {
      stillSaving: "Diese Änderung wird noch gespeichert – versuch es gleich noch einmal",
      stopsRunningTimer:
        "Das Stoppen eines laufenden Timers lässt sich nicht rückgängig machen – es kann immer nur ein Eintrag laufen",
      deletesRunningTimer:
        "Das Löschen eines laufenden Timers lässt sich nicht rückgängig machen – es kann immer nur ein Eintrag laufen",
    },
  },
  grid: {
    now: "jetzt",
  },
  cluster: {
    count: "{count, plural, one {# kurzer Eintrag} other {# kurze Einträge}}",
    ariaLabel: "{count, plural, one {# kurzer Eintrag} other {# kurze Einträge}}, {time}",
    title: "{count, plural, one {# kurzer Eintrag} other {# kurze Einträge}} · {time} · {duration}",
    chipSuffix: "{count, plural, one {kurzer Eintrag} other {kurze Einträge}} · {duration}",
  },
  create: {
    title: "Neuer Zeiteintrag",
    newEntry: "Neuer Eintrag",
    descriptionPlaceholder: "Woran arbeitest du?",
    submit: "Eintrag erstellen",
    invalidTimes: "Gib Uhrzeiten wie 9:15 oder 14:00 ein",
    endBeforeStart: "Das Ende muss nach dem Beginn liegen",
  },
  edit: {
    invalidTime: "„{value}“ ist keine gültige Uhrzeit",
    endStopsTimer: "Ende (stoppt den Timer)",
  },
  year: {
    trackedThisYear: "Dieses Jahr erfasst",
    daysTracked: "Erfasste Tage",
    averagePerDay: "Schnitt pro erfasstem Tag",
    busiestDay: "Stärkster Tag",
    projectsThisYear: "Projekte dieses Jahr",
    nothingTracked: "nichts erfasst",
  },
  timesheet: {
    title: "Stundenzettel",
    previousWeek: "Vorherige Woche",
    nextWeek: "Nächste Woche",
    truncated:
      "Diese Woche hat mehr Einträge, als der Stundenzettel genau summieren kann, deshalb ist Bearbeiten ausgeschaltet. Grenze die Einträge stattdessen unter Berichte → Einträge ein.",
    emptyTitle: "Noch nichts auf diesem Stundenzettel",
    emptyDescription:
      "Füg unten eine Zeile für ein Projekt hinzu und trag die Stunden direkt bei dem Tag ein, an dem du gearbeitet hast.",
    addRow: "Zeile hinzufügen",
    weekTotal: "Woche gesamt",
    projectTask: "Projekt / Tätigkeit",
    removeRow: "Zeile {label} entfernen",
    running: "läuft",
    openEntries: "Diese Einträge öffnen",
    blocks: {
      show: "Zeitblöcke für {label} anzeigen",
      hint: "Bearbeite einen Zeitblock oder füge einen hinzu. Die Zelle zeigt die Summe ihrer Zeitblöcke.",
      add: "Zeitblock hinzufügen",
      edit: "Zeitblock {label} bearbeiten",
      empty: "An diesem Tag gibt es keine Zeitblöcke. Füge einen hinzu, um Zeit zu erfassen.",
      untitled: "Keine Beschreibung",
      dayContribution: "Die Dauer zeigt den Anteil dieses Zeitblocks an diesem Tag. Beim Bearbeiten öffnet sich der ganze Zeitblock.",
      refreshBeforeRetry: "Der Zeitblock wurde gespeichert, ist hier aber noch nicht verfügbar. Aktualisiere den Stundenzettel, bevor du es erneut versuchst.",
      scopeChanged: "Dein Konto oder Arbeitsbereich hat sich geändert. Schließe den Entwurf und öffne ihn erneut.",
      unavailable: "Bearbeiten ist während des Ladens oder bei einem unvollständigen Stundenzettel nicht möglich. Versuche es nach dem Aktualisieren erneut.",
      protection: {
        missing: "Dieser Eintrag ist nicht mehr verfügbar. Aktualisiere den Stundenzettel.",
        foreign: "Du kannst nur deine eigenen Einträge in diesem Arbeitsbereich bearbeiten.",
        running: "Stoppe diesen Timer, bevor du seinen Zeitblock bearbeitest.",
        invoiced: "Dieser Zeitblock wurde abgerechnet und kann hier nicht bearbeitet werden.",
        syncing: "Dieser Zeitblock wird noch synchronisiert. Bearbeite ihn danach.",
      },
    },
    stillSyncing: "Wird noch synchronisiert – versuch es gleich noch einmal.",
    entryRemoved: "Eintrag entfernt",
    failed: {
      add: "Die Zeit konnte nicht hinzugefügt werden",
      save: "Die Änderung konnte nicht gespeichert werden",
      remove: "Die Zeit konnte nicht entfernt werden",
    },
    refusal: {
      running: "In dieser Zelle läuft der Timer – stopp ihn, bevor du sie bearbeitest.",
      multiple:
        "An diesem Tag gibt es mehrere Zeitblöcke. Bearbeite die einzelnen Zeitblöcke unten; die Summe lässt sich nicht direkt ändern.",
      spansDays:
        "Dieser Zeitblock geht über Mitternacht. Bearbeite den ganzen Zeitblock unten; die Summe dieses Tages lässt sich nicht direkt ändern.",
      tooLong: "Ein Tag kann nicht mehr als 24 Stunden haben.",
    },
  },
};
