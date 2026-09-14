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
        "Diese Zeile hat an diesem Tag mehrere Einträge. Bearbeite sie unter „Erfassen“, damit nichts auf Verdacht umgeschrieben wird.",
      spansDays:
        "Dieser Eintrag geht über Mitternacht und gehört damit zu zwei Tagen. Bearbeite ihn unter „Erfassen“.",
      tooLong: "Ein Tag kann nicht mehr als 24 Stunden haben.",
    },
  },
};
