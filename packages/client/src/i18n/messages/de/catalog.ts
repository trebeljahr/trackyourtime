import type { Translation } from "@starter/shared";

import type { catalog as source } from "../en/catalog";

/** German `catalog`. Terms follow i18n/GLOSSARY.de.md; voice is „du“. */
export const catalog: Translation<typeof source> = {
  clientBilling: {
    toggle: "Rechnungsdaten",
    toggleHint: "Was eine Rechnung unter „Rechnungsempfänger“ druckt. Alle Felder sind optional.",
    legalName: "Offizieller Name",
    addressLine: "Adresszeile {line}",
    postalCode: "Postleitzahl",
    city: "Ort",
    country: "Ländercode",
    taxId: "Steuernummer",
    email: "E-Mail für Rechnungen",
    reference: "Referenz",
    referenceHint: "Bestellnummer oder Kostenstelle des Kunden.",
    invalidCountry: "Gib einen zweistelligen Ländercode ein.",
  },
  screen: {
    showArchived: "Archivierte anzeigen",
    loadError: "Die Stammdaten konnten nicht geladen werden. Prüfe deine Verbindung und versuch es noch einmal.",
  },
  row: {
    actions: "Aktionen für {name}",
    archivedName: "{name} (archiviert)",
    archivedMarker: "archiviert",
    empty: "—",
  },
  columns: {
    tracked: "Erfasst",
    entries: "Einträge",
    billing: "Abrechnung",
    budget: "Budget",
  },
  entriesLink: {
    title: "Zeiteinträge für {name} anzeigen",
    menuItem: "Zeiteinträge anzeigen",
  },
  form: {
    nameRequired: "Der Name ist ein Pflichtfeld",
    saveChanges: "Änderungen speichern",
  },
  applyToEntries: {
    title: "Bestehende Einträge aktualisieren?",
    count:
      "{count, plural, one {# Zeiteintrag in {project} behält die Abrechnung, mit der er gespeichert wurde.} other {# Zeiteinträge in {project} behalten die Abrechnung, mit der sie gespeichert wurden.}} Neue Einträge verwenden in jedem Fall die neue Abrechnung.",
    flagChanged:
      "{count, plural, one {Beim Aktualisieren wird er als {billable, select, billable {abrechenbar} other {nicht abrechenbar}} markiert, auch wenn du ihn von Hand geändert hast, und neu berechnet.} other {Beim Aktualisieren werden alle als {billable, select, billable {abrechenbar} other {nicht abrechenbar}} markiert, auch von Hand geänderte Einträge, und neu berechnet.}} Die Gesamtwerte in Berichten ändern sich entsprechend.",
    rateOnly:
      "Beim Aktualisieren wird abrechenbare Zeit neu berechnet. Jeder Eintrag bleibt abrechenbar oder nicht abrechenbar wie bisher. Die Gesamtwerte in Berichten ändern sich entsprechend.",
    invoiced:
      "{count, plural, one {# abgerechneter Eintrag bleibt} other {# abgerechnete Einträge bleiben}} unverändert.",
    newOnly: "Nur neue Einträge",
    accept: "{count, plural, one {# Eintrag} other {# Einträge}} aktualisieren",
  },
  errors: {
    nameTaken:
      "{kind, select, client {Ein Kunde} project {Ein Projekt} task {Eine Tätigkeit} other {Ein Schlagwort}} mit dem Namen „{name}“ gibt es bereits.",
    createClient: "Der Kunde konnte nicht erstellt werden.",
    saveClient: "Der Kunde konnte nicht gespeichert werden.",
    archiveClient: "Der Kunde konnte nicht archiviert werden.",
    deleteClient: "Der Kunde konnte nicht gelöscht werden.",
    createProject: "Das Projekt konnte nicht erstellt werden.",
    saveProject: "Das Projekt konnte nicht gespeichert werden.",
    archiveProject: "Das Projekt konnte nicht archiviert werden.",
    deleteProject: "Das Projekt konnte nicht gelöscht werden.",
    createTask: "Die Tätigkeit konnte nicht hinzugefügt werden.",
    saveTask: "Die Tätigkeit konnte nicht gespeichert werden.",
    archiveTask: "Die Tätigkeit konnte nicht archiviert werden.",
    deleteTask: "Die Tätigkeit konnte nicht gelöscht werden.",
    createTag: "Das Schlagwort konnte nicht erstellt werden.",
    saveTag: "Das Schlagwort konnte nicht gespeichert werden.",
    deleteTag: "Das Schlagwort konnte nicht gelöscht werden.",
    countEntries: "Die Einträge in diesem Projekt konnten nicht gezählt werden.",
  },
  removal: {
    deleted: "{kind, select, client {Kunde} project {Projekt} other {Tätigkeit}} gelöscht.",
    deletedWithDetail:
      "{kind, select, client {Kunde} project {Projekt} other {Tätigkeit}} gelöscht – {detail}.",
    tasksDeleted: "{count, plural, one {# Tätigkeit} other {# Tätigkeiten}} gelöscht",
    projectsDetached:
      "{count, plural, one {# Projekt bleibt} other {# Projekte bleiben}} ohne Kunden erhalten",
    entriesDetached:
      "{count, plural, one {# Zeiteintrag bleibt} other {# Zeiteinträge bleiben}} ohne {kind, select, client {Kunden} project {Projekt} other {Tätigkeit}} erhalten",
    favoritesDetached:
      "{count, plural, one {# Favorit bleibt} other {# Favoriten bleiben}} ohne {kind, select, client {Kunden} project {Projekt} other {Tätigkeit}} erhalten",
  },
  clients: {
    description:
      "Kunden stehen über Projekten und fassen deren erfasste Zeit zusammen. Wenn du einen Kunden löschst, bleiben seine Projekte erhalten – sie haben dann nur keinen Kunden mehr.",
    new: "Neuer Kunde",
    search: "Kunden suchen",
    editLabel: "Kunden „{name}“ bearbeiten",
    empty: {
      title: "Noch keine Kunden",
      filteredTitle: "Kein Kunde passt zu diesen Filtern",
      description: "Kunden stehen über Projekten und fassen deren erfasste Zeit zusammen.",
      filteredDescription: "Leere die Suche oder schalte „Archivierte anzeigen“ ein.",
    },
    delete: {
      title: "„{name}“ löschen?",
      withProjects:
        "{projects, plural, one {Sein Projekt bleibt erhalten. Es verliert den Kunden und behält {entries, plural, one {seinen # Zeiteintrag} other {seine # Zeiteinträge}}.} other {Seine # Projekte bleiben erhalten. Sie verlieren den Kunden und behalten ihre {entries, plural, one {# Zeiteintrag} other {# Zeiteinträge}}.}} Archiviere ihn stattdessen, wenn du den Kunden behalten willst.",
      noProjects: "Dieser Kunde hat keine Projekte. Sonst ist nichts betroffen.",
      confirm: "Kunden löschen",
    },
    form: {
      titleNew: "Neuer Kunde",
      titleEdit: "Kunden bearbeiten",
      description: "Kunden stehen über Projekten und fassen deren erfasste Zeit zusammen.",
      namePlaceholder: "Muster GmbH",
      create: "Kunden erstellen",
      created: "Kunde „{name}“ erstellt.",
      saved: "Kunde gespeichert.",
      invoiceLocale: {
        label: "Rechnungssprache",
        inherit: "Deine Spracheinstellung",
        en: "English",
        de: "Deutsch",
        hint: "Rechnungen für diesen Kunden werden in dieser Sprache geschrieben. Für eine einzelne Rechnung kannst du trotzdem eine andere wählen.",
      },
    },
  },
  projects: {
    description:
      "Projekte bündeln erfasste Zeit und legen die Abrechnung für neue Einträge fest. Wenn du ein Projekt löschst, bleiben seine Zeiteinträge erhalten – sie haben dann nur kein Projekt mehr.",
    new: "Neues Projekt",
    search: "Projekte oder Kunden suchen",
    editLabel: "Projekt „{name}“ bearbeiten",
    summary: "{count, plural, one {# Projekt} other {# Projekte}} · {duration} erfasst",
    overBudget: "{count, number} über Budget",
    clientFilter: {
      all: "Alle Kunden",
      search: "Nach Kunden filtern …",
      empty: "Noch keine Kunden.",
    },
    empty: {
      title: "Noch keine Projekte",
      filteredTitle: "Kein Projekt passt zu diesen Filtern",
      description: "Projekte bündeln erfasste Zeit und legen die Abrechnung für neue Einträge fest.",
      filteredDescription:
        "Leere die Suche oder den Kundenfilter, oder schalte „Archivierte anzeigen“ ein.",
    },
    noBudget: "Kein Budget",
    delete: {
      title: "„{name}“ löschen?",
      withEntries:
        "{count, plural, one {# Zeiteintrag behält seine erfasste Zeit und hat danach kein Projekt mehr.} other {# Zeiteinträge behalten ihre erfasste Zeit und haben danach kein Projekt mehr.}} Tätigkeiten bleiben unverändert. Archiviere es stattdessen, wenn du das Projekt behalten willst.",
      noEntries: "Für dieses Projekt ist keine Zeit erfasst. Tätigkeiten bleiben unverändert.",
      confirm: "Projekt löschen",
    },
    billing: {
      editLabel: "Abrechnung für {name} bearbeiten",
      rate: "{amount}/h",
      defaultMarker: "Standard",
      billableByDefault: "Standardmäßig abrechenbar",
      hourlyRate: "Stundensatz ({currency})",
      ratePlaceholder: "Standard: {amount}",
      rateInvalid: "Gib einen Satz von 0 oder mehr ein oder lass das Feld leer",
      rateHint: "Leer lassen, um den Standard des Arbeitsbereichs zu verwenden.",
      nonBillableHint: "Nicht abrechenbare Zeit hat keinen Satz.",
      saved: "Abrechnung für neue Einträge gespeichert.",
      savedWithEntries:
        "Abrechnung gespeichert und {count, plural, one {# Eintrag} other {# Einträge}} aktualisiert.",
    },
    form: {
      titleNew: "Neues Projekt",
      titleEdit: "Projekt bearbeiten",
      description: "Projekte bündeln erfasste Zeit und legen die Abrechnung für neue Einträge fest.",
      namePlaceholder: "Website-Relaunch",
      create: "Projekt erstellen",
      created: "Projekt „{name}“ erstellt.",
      saved: "Projekt gespeichert.",
      savedWithEntries:
        "Projekt gespeichert und {count, plural, one {# Eintrag} other {# Einträge}} aktualisiert.",
      client: {
        search: "Suchen oder neuen Namen eingeben …",
        empty: "Noch keine Kunden.",
      },
      advanced: {
        toggle: "Abrechnung & Limits",
        summary: "Satz, Ziele, Inaktivität",
      },
      billableHint: "Neue Einträge in diesem Projekt sind zunächst abrechenbar.",
      rateHint: "Leer lassen, um den Standard-Stundensatz des Arbeitsbereichs zu verwenden.",
      targets: {
        legend: "Schätzung & Budget",
        hint: "Ziele für das ganze Projekt über seine gesamte Laufzeit, kein monatliches Kontingent. Lass ein Feld leer, wenn es kein Ziel gibt – das ist nicht dasselbe wie ein Ziel von null.",
        estimate: "Geschätzte Stunden",
        estimatePlaceholder: "Keine Schätzung",
        estimateInvalid: "Gib 0 oder mehr Stunden ein oder lass das Feld leer",
        budget: "Budget ({currency})",
        budgetInvalid: "Gib einen Betrag von 0 oder mehr ein oder lass das Feld leer",
        currencyNote:
          "Dieses Budget ist in {budgetCurrency} angegeben, der Währung des Arbeitsbereichs beim Festlegen. Zeit, die in {currency} erfasst ist, wird getrennt ausgewiesen und nicht umgerechnet.",
      },
      idle: {
        label: "Bei Inaktivität",
        inherit: "Einstellung des Arbeitsbereichs verwenden",
        hint: "Wähle „{keepRunning}“ für Arbeit ohne Tippen – Meetings, Anrufe, Lesen. Die Inaktivitätserkennung wird dadurch nie eingeschaltet; das bleibt eine Einstellung des Arbeitsbereichs.",
        behaviors: {
          ask: "Nachfragen",
          pauseAndResume: "Pausieren und fortsetzen",
          keepRunning: "Weiterlaufen lassen",
          stop: "Timer stoppen",
        },
      },
    },
  },
  tasks: {
    description:
      "Was die Arbeit ist, unabhängig davon, für welches Projekt sie war. Ein Eintrag kann eine Tätigkeit, ein Projekt, beides oder keins von beiden haben – wenn du eine Tätigkeit löschst, bleiben die zugehörigen Einträge erhalten.",
    new: "Neue Tätigkeit",
    search: "Tätigkeiten suchen",
    editLabel: "Tätigkeit „{name}“ bearbeiten",
    markDone: "{name} als erledigt markieren",
    summary:
      "{count, plural, one {# Tätigkeit} other {# Tätigkeiten}} · {open, number} offen · {duration} erfasst",
    empty: {
      title: "Noch keine Tätigkeiten",
      filteredTitle: "Keine Tätigkeit passt zu diesen Filtern",
      description:
        "Tätigkeiten benennen die Art der Arbeit. Ein Eintrag kann eine Tätigkeit, ein Projekt, beides oder keins von beiden haben.",
      filteredDescription: "Leere die Suche oder schalte „Archivierte anzeigen“ ein.",
    },
    delete: {
      title: "„{name}“ löschen?",
      withTime:
        "Einträge mit dieser Tätigkeit behalten ihre erfasste Zeit und ihr Projekt – sie verlieren nur die Tätigkeit.",
      noTime: "Für diese Tätigkeit ist keine Zeit erfasst.",
      confirm: "Tätigkeit löschen",
    },
    form: {
      titleNew: "Neue Tätigkeit",
      titleEdit: "Tätigkeit bearbeiten",
      description:
        "Tätigkeiten benennen die Art der Arbeit, egal in welchem Projekt sie anfällt. Ein Eintrag kann eine Tätigkeit, ein Projekt, beides oder keins von beiden haben.",
      namePlaceholder: "Launch-Beitrag schreiben",
      create: "Tätigkeit erstellen",
      created: "Tätigkeit „{name}“ erstellt.",
      saved: "Tätigkeit gespeichert.",
    },
  },
  tags: {
    description:
      "Schlagwörter gelten quer über alle Projekte. Ein Eintrag kann mehrere haben, und ein archiviertes Schlagwort bleibt an der Zeit, die schon damit markiert ist.",
    new: "Neues Schlagwort",
    editLabel: "Schlagwort „{name}“ bearbeiten",
    showArchived: "Archivierte anzeigen ({count, number})",
    empty: {
      title: "Noch keine Schlagwörter",
      description:
        "Schlagwörter gelten quer über alle Projekte – „vor Ort“, „Bugfix“, „Review nötig“. Leg hier eins an oder direkt in der Timer-Leiste.",
    },
    removal: {
      archiveTitle: "„{name}“ archivieren?",
      archiveDescription:
        "{count, plural, one {# Zeiteintrag hat dieses Schlagwort noch} other {# Zeiteinträge haben dieses Schlagwort noch}}, deshalb wird es archiviert statt gelöscht – die Zeit behält das Schlagwort, und es wird für neue Einträge nicht mehr angeboten.",
      deleteTitle: "„{name}“ löschen?",
      deleteDescription:
        "Nichts ist damit markiert, deshalb wird es endgültig gelöscht. Das lässt sich nicht rückgängig machen.",
    },
    deleted: "Schlagwort gelöscht.",
    archivedInstead:
      "Dieses Schlagwort hängt noch an erfasster Zeit, deshalb wurde es archiviert statt gelöscht.",
    form: {
      titleNew: "Neues Schlagwort",
      titleEdit: "Schlagwort bearbeiten",
      description: "Ein Schlagwort gilt quer über alle Projekte. Ein Eintrag kann mehrere haben.",
      namePlaceholder: "Review nötig",
      created: "Schlagwort „{name}“ erstellt.",
      saved: "Schlagwort gespeichert.",
    },
    picker: {
      search: "Schlagwort suchen oder erstellen …",
      empty: "Noch keine Schlagwörter – tipp eins ein, um es zu erstellen.",
      create: "„{name}“ erstellen",
      remove: "{count, plural, one {# Schlagwort} other {# Schlagwörter}} entfernen",
      tooMany: "Ein Eintrag kann höchstens {max, plural, one {# Schlagwort} other {# Schlagwörter}} haben.",
    },
    filter: {
      empty: "Noch keine Schlagwörter.",
      search: "Schlagwörter suchen …",
      edit: "Schlagwort bearbeiten",
      new: "Neues Schlagwort …",
    },
  },
  colorPicker: {
    pick: "Farbe wählen",
    custom: "Eigene Farbe",
    hex: "Hex-Farbe",
  },
};
