import type { Translation } from "@starter/shared";

import type { report as source } from "../en/report.js";

/** German `report`. Terms follow packages/client/src/i18n/GLOSSARY.de.md; voice is „du“. */
export const report: Translation<typeof source> = {
  title: {
    summary:
      "Übersicht nach {groupBy, select, project {Projekt} client {Kunden} task {Tätigkeit} tag {Schlagwort} member {Mitglied} day {Tag} week {Woche} month {Monat} other {{groupBy}}}",
    detailed: "Detaillierter Bericht",
    weekly: "Wöchentlicher Stundenzettel",
  },
  footer: {
    product: "Track Your Time · {timeZone}",
    page: "Seite {page}",
  },
  range: "{from} bis {to} · Zeitzone {timeZone}",
  amountsIn: "Beträge in {currency} · erstellt am {generatedAt}",
  generated: "erstellt am {generatedAt}",
  continued: "{from} bis {to} · {timeZone} · Fortsetzung",
  stats: {
    totalTracked: "Gesamt erfasst",
    billable: "Abrechenbar",
    amount: "Betrag ({currency})",
    entries: "Einträge",
    rows: "Zeilen",
    week: "Woche",
  },
  weekRange: "{from} bis {to}",
  columns: {
    group: "Gruppe",
    duration: "Dauer",
    billable: "Abrechenbar",
    amount: "Betrag ({currency})",
    date: "Datum",
    time: "Uhrzeit",
    description: "Beschreibung",
    projectTask: "Projekt / Tätigkeit",
    billableShort: "A",
    total: "Gesamt",
  },
  billableMark: "J",
  empty: {
    range: "In diesem Zeitraum wurde keine Zeit erfasst.",
    week: "In dieser Woche wurde keine Zeit erfasst.",
  },
  total: "Gesamt",
  running: "{start} – läuft",
  noProject: "Kein Projekt",
  noDescription: "(keine Beschreibung)",
  unassigned: {
    project: "Kein Projekt",
    client: "Kein Kunde",
    task: "Keine Tätigkeit",
    tag: "Kein Schlagwort",
  },
  member: {
    former: "Ehemaliges Mitglied",
    unnamed: "Mitglied ohne Namen",
  },
};
