import type { Translation } from "@starter/shared";

import type { activity as source } from "../en/activity";

/** German `activity`. Terms follow i18n/GLOSSARY.de.md; voice is „du“. */
export const activity: Translation<typeof source> = {
  page: {
    title: "Aktivität",
    description:
      "Zeit, in der dieser Computer dich arbeiten gesehen hat und die noch kein Eintrag abdeckt. Es verlässt nichts diesen Computer, bis du einen Eintrag hinzufügst.",
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
  toasts: {
    added: "Eintrag hinzugefügt",
    alreadyTracked: "Diese Zeit ist schon erfasst oder ausgeblendet.",
    workspaceChanged: "Du hast den Arbeitsbereich gewechselt, deshalb wurde kein Eintrag hinzugefügt.",
    addFailed: "Der Eintrag konnte nicht hinzugefügt werden.",
    dismissFailed: "Der Vorschlag konnte nicht ausgeblendet werden.",
    ruleFailed: "Die Regel konnte nicht gespeichert werden.",
  },
};
