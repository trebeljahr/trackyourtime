import type { Translation } from "@starter/shared";

import type { reports as source } from "../en/reports";

/** German `reports`. Terms follow i18n/GLOSSARY.de.md; voice is „du“. */
export const reports: Translation<typeof source> = {
  invoiceIdentity: {
    profileMissing: "Dein Unternehmensprofil hat keine Adresse, also nennt diese Rechnung keinen Aussteller.",
    profileLink: "Unternehmensprofil vervollständigen",
    clientMissing: "{client} hat keine Rechnungsadresse, also zeigt diese Rechnung nur den Kundennamen.",
    clientLink: "Rechnungsdaten ergänzen",
    dueFromTerms: "Fälligkeitsdatum aus deinem Zahlungsziel von {days, plural, one {# Tag} other {# Tagen}}.",
  },

  screen: {
    title: "Berichte",
    viewLabel: "Berichtsansicht",
    views: {
      totals: "Summen",
      entries: "Einträge",
    },
  },

  rangePicker: {
    last5Years: "Letzte 5 Jahre",
    allTime: "Gesamter Zeitraum",
    selectDates: "Zeitraum wählen",
    from: "Von",
    to: "Bis",
    invalid: "„Von“ liegt nach „Bis“ – der Zeitraum wird noch nicht angewendet.",
  },

  budget: {
    hoursTarget: "{hours} h",
    progress: "{spent} von {target}",
    left: "{amount} übrig",
    over: "{amount} überschritten",
    nearlyUsedUp: "Fast aufgebraucht",
    overBudget: "Budget überschritten",
    trackedIn: "Erfasst in {currencies}. Beträge in verschiedenen Währungen werden nie addiert.",
    excludes:
      "Ohne Beträge in {currencies}, die erfasst wurden, bevor sich die Währung des Arbeitsbereichs geändert hat.",
    hoursMeter: "Erfasste Stunden im Vergleich zur Schätzung",
    amountMeter: "Abrechenbarer Betrag im Vergleich zum Budget",
    meterValue: "{percent} – {remainder}",
  },

  filters: {
    allEntries: "Alle Einträge",
    searchDescriptions: "Beschreibungen durchsuchen",
    clients: {
      empty: "Noch keine Kunden.",
      search: "Kunden suchen …",
      edit: "Kunden bearbeiten",
      create: "Neuer Kunde …",
    },
    projects: {
      empty: "Noch keine Projekte.",
      search: "Projekte suchen …",
      edit: "Projekt bearbeiten",
      create: "Neues Projekt …",
    },
    tasks: {
      empty: "Noch keine Tätigkeiten.",
      search: "Tätigkeiten suchen …",
      edit: "Tätigkeit bearbeiten",
      create: "Neue Tätigkeit …",
    },
  },

  multiSelect: {
    noMatches: "Keine Treffer.",
    search: "Suchen …",
    editOption: "{action}: {name}",
    clearSelected: "Auswahl aufheben ({count, number})",
  },

  groupBy: {
    label: "Gruppieren nach",
    breakdownTitle:
      "{groupBy, select, project {Aufteilung nach Projekt} client {Aufteilung nach Kunden} task {Aufteilung nach Tätigkeit} tag {Aufteilung nach Schlagwort} member {Aufteilung nach Mitglied} day {Aufteilung nach Tag} week {Aufteilung nach Woche} other {Aufteilung nach Monat}}",
    breakdownAria:
      "{groupBy, select, project {Anteil der erfassten Zeit nach Projekt} client {Anteil der erfassten Zeit nach Kunden} task {Anteil der erfassten Zeit nach Tätigkeit} tag {Anteil der erfassten Zeit nach Schlagwort} member {Anteil der erfassten Zeit nach Mitglied} day {Anteil der erfassten Zeit nach Tag} week {Anteil der erfassten Zeit nach Woche} other {Anteil der erfassten Zeit nach Monat}}",
    totalsTitle:
      "{groupBy, select, project {Gesamtzeit nach Projekt} client {Gesamtzeit nach Kunden} task {Gesamtzeit nach Tätigkeit} tag {Gesamtzeit nach Schlagwort} member {Gesamtzeit nach Mitglied} day {Gesamtzeit nach Tag} week {Gesamtzeit nach Woche} other {Gesamtzeit nach Monat}}",
  },

  kpi: {
    totalTracked: "Gesamt erfasst",
    amountEarned: "Verdienter Betrag",
    shareOfTracked: "{percent} der erfassten Zeit",
    wholeRange: "Gesamter gefilterter Zeitraum",
    entriesLoaded: "Geladene Einträge",
    moreAvailable: "Weitere verfügbar",
    allInRange: "Alle Einträge im Zeitraum",
  },

  charts: {
    timelineTitle: {
      day: "Aktivität pro Tag",
      week: "Aktivität pro Woche",
      month: "Aktivität pro Monat",
    },
    timelineAria: {
      day: "{count, plural, one {Erfasste Zeit über # Tag} other {Erfasste Zeit über # Tage}}",
      week: "{count, plural, one {Erfasste Zeit über # Woche} other {Erfasste Zeit über # Wochen}}",
      month:
        "{count, plural, one {Erfasste Zeit über # Monat} other {Erfasste Zeit über # Monate}}",
    },
    hourTick: "{hours} h",
    weekOf: "Woche ab {date}",
    tracked: "Erfasst",
    durationWithShare: "{duration} ({share})",
    sliceSummary: "{label}: {duration}, {amount}",
    more: "{count, number} weitere",
    timelineEmptyTitle: "Keine Zeit in diesem Zeitraum",
    timelineEmptyDescription:
      "Erfasse Zeit oder erweitere den Zeitraum, um den Verlauf zu sehen.",
    breakdownEmptyTitle: "Nichts aufzuteilen",
    breakdownEmptyDescription: "Keine erfasste Zeit passt zu den aktuellen Filtern.",
  },

  summary: {
    overlapNote:
      "Ein Eintrag mit mehreren Schlagwörtern zählt bei jedem davon, deshalb ergeben diese Zeilen zusammen mehr als die Gesamtzeit unten.",
    share: "Anteil",
    budget: "Budget",
    lifetime: "(gesamte Laufzeit)",
    showEntriesFor: "Zeiteinträge für {name} anzeigen",
    emptyTitle: "In diesem Zeitraum keine Zeit erfasst",
    emptyDescription:
      "Passe die Filter an oder erfasse Zeit, dann erscheinen die Zahlen hier.",
  },

  detailed: {
    selectAll: "Alle geladenen Einträge auswählen",
    selectEntry: "Eintrag „{description}“ auswählen",
    selectEntryUntitled: "Eintrag ohne Beschreibung auswählen",
    sortBy: "Nach {label} sortieren",
    startEnd: "Beginn / Ende",
    noDescription: "Keine Beschreibung",
    editProject: "Projekt „{name}“ bearbeiten",
    running: "läuft",
    loadMore: "Mehr laden",
    emptyTitle: "Keine Einträge passen zu diesen Filtern",
    emptyDescription:
      "Erweitere den Zeitraum, entferne einen Filter oder erfasse Zeit, damit hier Einträge erscheinen.",
    toast: {
      removedProject:
        "{count, plural, one {Projekt von # Eintrag entfernt} other {Projekt von # Einträgen entfernt}}",
      moved:
        "{count, plural, one {# Eintrag in {project} verschoben} other {# Einträge in {project} verschoben}}",
      theProject: "das Projekt",
      markedBillable:
        "{count, plural, one {# Eintrag als abrechenbar markiert} other {# Einträge als abrechenbar markiert}}",
      markedNonBillable:
        "{count, plural, one {# Eintrag als nicht abrechenbar markiert} other {# Einträge als nicht abrechenbar markiert}}",
      deleted: "{count, plural, one {# Eintrag gelöscht} other {# Einträge gelöscht}}",
      failed: "Sammelbearbeitung fehlgeschlagen",
    },
  },

  bulk: {
    region: "Sammelaktionen",
    setProject: "Projekt festlegen",
    markBillable: "Als abrechenbar markieren",
    markNonBillable: "Als nicht abrechenbar markieren",
    clearSelection: "Auswahl aufheben",
    confirmTitle:
      "{count, plural, one {# Zeiteintrag löschen?} other {# Zeiteinträge löschen?}}",
    confirmDescription:
      "Damit werden die ausgewählten Einträge und die erfasste Zeit endgültig entfernt. Das lässt sich nicht rückgängig machen.",
    confirm: "{count, plural, one {Eintrag löschen} other {Einträge löschen}}",
  },


  exportMenu: {
    title: "Bericht exportieren",
    csv: "CSV herunterladen",
    pdf: "PDF herunterladen",
    unsupported:
      "Diese App kann noch keine Dateien speichern – öffne den Bericht im Browser, um die {format}-Datei herunterzuladen.",
    exported: "{filename} exportiert",
    failed: "Der Bericht konnte nicht exportiert werden",
  },

  invoices: {
    description:
      "Rechne erfasste Zeit aus einem Zeitraum mit einem Kunden ab. Schon abgerechnete Zeit wird nie ein zweites Mal angeboten.",
    count: "{count, plural, one {# Rechnung} other {# Rechnungen}}",
    newInvoice: "Neue Rechnung",
    emptyTitle: "Noch keine Rechnungen",
    emptyDescription:
      "Eine Rechnung macht aus der abrechenbaren Zeit eines Kunden in einem Zeitraum ein Dokument. Zeit, die auf einer Rechnung steht, wird nie wieder zur Abrechnung angeboten.",
    status: {
      draft: "Entwurf",
      sent: "Versendet",
      paid: "Bezahlt",
    },
    markAs:
      "{status, select, draft {Als Entwurf markieren} sent {Als versendet markieren} other {Als bezahlt markieren}}",
    backTo:
      "{status, select, draft {Wieder als Entwurf markieren} sent {Wieder als versendet markieren} other {Wieder als bezahlt markieren}}",
    columns: {
      number: "Nummer",
      issued: "Rechnungsdatum",
      due: "Fälligkeitsdatum",
      status: "Status",
      billedRange: "Abgerechneter Zeitraum",
      language: "Sprache",
      line: "Position",
      hours: "Stunden",
    },
    hoursValue: "{hours} h",
    billedHours: "Abgerechnete Stunden",
    subtotal: "Zwischensumme",
    noTax: "Keine Steuer",
    tax: "USt. ({rate})",
    languages: {
      en: "English",
      de: "Deutsch",
    },

    detail: {
      close: "Rechnung schließen",
      entriesDraft:
        "{count, plural, one {# Zeiteintrag ist auf dieser Rechnung abgerechnet und kann erst wieder abgerechnet werden, wenn dieser Entwurf gelöscht wird.} other {# Zeiteinträge sind auf dieser Rechnung abgerechnet und können erst wieder abgerechnet werden, wenn dieser Entwurf gelöscht wird.}}",
      entriesFinal:
        "{count, plural, one {# Zeiteintrag ist auf dieser Rechnung abgerechnet und kann nicht noch einmal abgerechnet werden.} other {# Zeiteinträge sind auf dieser Rechnung abgerechnet und können nicht noch einmal abgerechnet werden.}}",
      downloadPdf: "PDF herunterladen",
      deleteDraft: "Entwurf löschen",
      deleteTitle: "Entwurf {number} löschen?",
      deleteDescription:
        "{count, plural, one {Der # Eintrag darauf wird wieder abrechenbar, und die Nummer verfällt. Nur Entwürfe lassen sich löschen – eine versendete Rechnung ist ein Beleg.} other {Die # Einträge darauf werden wieder abrechenbar, und die Nummer verfällt. Nur Entwürfe lassen sich löschen – eine versendete Rechnung ist ein Beleg.}}",
    },

    toast: {
      created: "Rechnung {number} erstellt.",
      statusChanged: "Status von Rechnung {number}: {status}.",
      deleted:
        "{count, plural, one {Entwurf gelöscht – # Zeiteintrag ist wieder abrechenbar.} other {Entwurf gelöscht – # Zeiteinträge sind wieder abrechenbar.}}",
      createFailed: "Die Rechnung konnte nicht erstellt werden.",
      statusFailed: "Der Status konnte nicht geändert werden.",
      deleteFailed: "Die Rechnung konnte nicht gelöscht werden.",
      pdfFailed: "Das PDF für {number} konnte nicht erstellt werden.",
    },

    notices: {
      missingRate:
        "{count, plural, one {# Eintrag hat keinen Stundensatz und kann nicht abgerechnet werden. Leg am Projekt einen Stundensatz fest und lade die Vorschau neu.} other {# Einträge haben keinen Stundensatz und können nicht abgerechnet werden. Leg am Projekt einen Stundensatz fest und lade die Vorschau neu.}}",
      alreadyInvoiced:
        "{count, plural, one {# Eintrag steht schon auf einer früheren Rechnung und wird nicht noch einmal abgerechnet.} other {# Einträge stehen schon auf einer früheren Rechnung und werden nicht noch einmal abgerechnet.}}",
    },

    emptyReason: {
      both: "Jede abrechenbare Stunde in diesem Zeitraum ist entweder schon abgerechnet oder hat keinen Stundensatz.",
      invoiced:
        "Jede abrechenbare Stunde in diesem Zeitraum ist schon abgerechnet. Dieselbe Zeit wird nie zweimal abgerechnet.",
      missingRate:
        "Die erfasste Zeit in diesem Zeitraum hat keinen Stundensatz, also gibt es nichts abzurechnen.",
      none: "Für diesen Kunden wurde in diesem Zeitraum keine abrechenbare, noch nicht abgerechnete Zeit erfasst.",
    },

    form: {
      title: "Neue Rechnung",
      description:
        "Die Vorschau ändert nichts. Wenn du die Rechnung erstellst, ist die Zeit darauf abgerechnet – sie kann nie wieder abgerechnet werden.",
      selectClient: "Kunden auswählen",
      lines: "Positionen",
      perProject: "Eine Position pro Projekt",
      perTask: "Eine Position pro Tätigkeit",
      taxRate: "Steuersatz (%)",
      taxHint: "Leer lassen, wenn die Rechnung keine Steuerzeile haben soll. Bei 0 steht eine Zeile mit 0 % darauf.",
      taxNotNumber: "Gib den Steuersatz als Zahl ein, z. B. 19.",
      taxOutOfRange: "Der Steuersatz muss zwischen 0 und 100 liegen.",
      issueDate: "Rechnungsdatum",
      dueDate: "Fälligkeitsdatum",
      notes: "Anmerkungen (optional)",
      notesPlaceholder: "Zahlungsbedingungen, eine Referenz, alles, was der Kunde sehen muss.",
      language: "Rechnungssprache",
      languageAuto: "Automatisch ({language})",
      languageHint:
        "Automatisch nimmt die Sprache des Kunden, sonst deine. Die Rechnung behält ihre Sprache, nachdem sie erstellt wurde.",
      preview: "Vorschau",
      nextNumber: "Nächste Nummer: {number}",
      pickClient: "Wähle einen Kunden, um zu sehen, was abgerechnet würde.",
      fixTax: "Korrigiere den Steuersatz, um die Vorschau zu sehen.",
      gathering: "Abrechenbare Zeit wird gesammelt …",
      nothingToBill: "Nichts abzurechnen. {reason}",
      confirm:
        "Damit erstellst du Rechnung <b>{number}</b> für <b>{client}</b> über <b>{total}</b> und rechnest {count, plural, one {# Eintrag} other {# Einträge}} ab. Diese Zeit kann nicht noch einmal abgerechnet werden.",
      backToPreview: "Zurück zur Vorschau",
      createNumbered: "Rechnung {number} erstellen",
      create: "Rechnung erstellen …",
    },
  },
};
