import type { Translation } from "@starter/shared";

import type { activity as source } from "../en/activity";

/** German `activity`. Terms follow i18n/GLOSSARY.de.md; voice is „du“. */
export const activity: Translation<typeof source> = {
  page: {
    title: "Aktivität",
    description:
      "Zeit, in der dieser Computer dich arbeiten gesehen hat und die noch kein Eintrag abdeckt. Nichts verlässt diesen Computer außer den Einträgen, die du hinzufügst oder Autopilot für dich anlegt.",
  },
  web: {
    title: "Aktivitätsvorschläge gibt es in der Desktop-App",
    body: "Die Desktop-App kann sich merken, welche App vorne ist, und Einträge für Zeit vorschlagen, die du nicht erfasst hast. Im Browser macht die Erweiterung dasselbe für Websites.",
    download: "Desktop-App herunterladen",
    extension: "Browser-Erweiterung holen",
  },
  day: {
    previous: "Vorheriger Tag",
    next: "Nächster Tag",
    today: "Heute",
  },
  status: {
    off: "Die Aktivitätserfassung ist aus. Du schaltest sie in den Einstellungen unter Desktop ein.",
    openSettings: "Desktop-Einstellungen öffnen",
    unavailable: "Die Aktivitätserfassung funktioniert auf diesem Computer nicht.",
    noScope: "Aktivität wird erfasst, sobald dein Konto und dein Arbeitsbereich geladen sind.",
    locked:
      "Eine neuere Version der App hat die Aktivität auf diesem Computer geschrieben. Aktualisiere die App, um Vorschläge zu sehen.",
  },
  empty: "An diesem Tag gibt es keine nicht erfasste Aktivität.",
  loading: "Vorschläge werden geladen …",
  refreshFailed:
    "Die Vorschläge konnten nicht aktualisiert werden. Was du siehst, ist vielleicht nicht mehr aktuell.",
  card: {
    filesUnder: "Wird unter {project} abgelegt",
    filedByRule: "Von einer Regel abgelegt, ohne Projekt",
    noProject: "Kein Projekt",
    appShare: "{app} {share}",
  },
  actions: {
    add: "Übernehmen",
    editAndAdd: "Bearbeiten und übernehmen",
    dismiss: "Ausblenden",
    alwaysFile: "{app} immer ablegen unter …",
  },
  rule: {
    title: "{app} immer ablegen unter",
    description:
      "Neue Vorschläge, in denen {app} die meistgenutzte App ist, bekommen diese Angaben. Die Regel bleibt auf diesem Computer.",
    save: "Regel speichern",
  },
  rules: {
    heading: "Regeln auf diesem Computer",
    empty: "Noch keine Regeln.",
    remove: "Regel für {app} entfernen",
  },
  autopilot: {
    name: "Autopilot",
    noDescription: "(keine Beschreibung)",
    via: {
      rule: "nach deiner Regel",
      learned: "aus deinen Einträgen gelernt",
    },
    toast: {
      started: "„{label}“ wird erfasst",
      switched: "Gewechselt zu „{label}“",
      stopped: "„{label}“ gestoppt",
      since: "Seit {time}",
      at: "Um {time}",
      evidence: "{span} in {app}",
      stoppedBody: "Du hast mit etwas anderem weitergemacht.",
      undo: "Rückgängig",
      change: "Ändern",
      undone: "Rückgängig gemacht. Autopilot lässt diese Arbeit bis zu deiner nächsten Pause in Ruhe.",
      undoFailed: "Der Timer konnte nicht entfernt werden. Stoppe ihn in der Timer-Leiste.",
    },
    notice: {
      started: "„{label}“ wird seit {time} erfasst",
      switched: "Um {time} zu „{label}“ gewechselt",
      stopped: "„{label}“ um {time} gestoppt",
      body: "Autopilot hat {span} in {app} gesehen. Öffne Track Your Time, um das rückgängig zu machen oder zu ändern.",
      stoppedBody: "Du hast mit etwas anderem weitergemacht.",
    },
    strip: {
      owned: "Von Autopilot um {time} gestartet, aus {app}",
      ownedNoApp: "Von Autopilot um {time} gestartet",
      warming: "{span} in {app} · Autopilot startet „{label}“ nach {threshold}",
      ask: "{span} in {app}. Woran arbeitest du?",
      trackAs: "Erfassen als …",
      notWork: "Keine Arbeit",
      notNow: "Jetzt nicht",
      held: "Autopilot wartet bis zu deiner nächsten Pause, bevor er {app} wieder erfasst.",
      undo: "Rückgängig",
    },
    panel: {
      title: "Autopilot",
      offTitle: "Lass Autopilot deinen Timer starten",
      offBody:
        "Wenn du ein paar Minuten in einer App arbeitest, startet Autopilot einen Timer ab dem Moment, in dem du angefangen hast. Er startet nur Arbeit, die er benennen kann: nach deinen Regeln oder nach dem, was du in dieser App schon erfasst hast.",
      turnOn: "Autopilot einschalten",
      needsCapture: "Autopilot nutzt die Aktivitätserfassung. Schalte zuerst die Aktivitätserfassung ein.",
      openSettings: "Desktop-Einstellungen öffnen",
      on: "An",
      off: "Aus",
      watching: "{app} · {span}",
      willStart: "Startet „{label}“ nach {threshold}",
      tracking: "„{label}“ wird erfasst",
      unknown: "Autopilot weiß noch nicht, wofür du {app} nutzt.",
      held: "Wartet auf deine nächste Pause.",
      quiet: "Gerade gibt es nichts zu starten.",
      learned:
        "{count, plural, =0 {Noch keine App aus deinen Einträgen gelernt.} one {Kennt # App aus deinen Einträgen.} other {Kennt # Apps aus deinen Einträgen.}}",
      logHeading: "Was Autopilot gemacht hat",
      logEmpty: "Autopilot hat heute noch keinen Timer gestartet.",
      log: {
        start: "„{label}“ gestartet",
        switch: "Zu „{label}“ gewechselt",
        stop: "Timer gestoppt",
      },
      undone: "Rückgängig gemacht",
    },
    timeline: {
      label: "Zeitleiste für {day}",
      tracked: "Erfasst",
      autopilot: "Von Autopilot gestartet",
      untracked: "Noch nicht erfasst",
      entry: "{label}, {from}–{to}",
      gap: "Nicht erfasst: {from}–{to}",
      now: "Jetzt",
    },
  },
  toasts: {
    added: "Eintrag hinzugefügt",
    alreadyTracked: "Diese Zeit ist schon erfasst oder ausgeblendet.",
    workspaceChanged: "Du hast den Arbeitsbereich gewechselt, deshalb wurde kein Eintrag hinzugefügt.",
    addFailed: "Der Eintrag konnte nicht hinzugefügt werden.",
    dismissFailed: "Der Vorschlag konnte nicht ausgeblendet werden.",
    ruleFailed: "Die Regel konnte nicht gespeichert werden.",
  },
};
