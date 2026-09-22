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
    waiting: "{count, plural, one {# Änderung wartet} other {# Änderungen warten}} auf ein Update",
    waitingHint: "Diese Änderungen brauchen eine neuere App-Version oder ein Server-Update. Sie bleiben erhalten und werden gesendet, sobald das möglich ist.",
  },
  description: {
    label: "Beschreibung",
    placeholder: "Woran arbeitest du?",
    suggestions: "Frühere Beschreibungen",
    fill: "„{description}“ mit Projekt, Tätigkeit, Schlagwörtern und Abrechenbarkeit übernehmen",
    legend: "Tab vervollständigt · {shortcut} übernimmt Projekt, Tätigkeit und Schlagwörter",
    ctrlEnter: "Strg+Enter",
  },
  fields: {
    startTime: "Uhrzeit (Beginn)",
    endTime: "Uhrzeit (Ende)",
    startDate: "Datum (Beginn)",
    endDate: "Datum (Ende)",
    notBillable: "Nicht abrechenbar",
  },
  bar: {
    /** Before the running entry's start time in the bar. */
    startedAt: "Seit",
    descriptionPlaceholder: "Woran arbeitest du?",
    addEntry: "Zeiteintrag hinzufügen",
    authBlocked: "Abgemeldet – melde dich an, um zu synchronisieren",
    clockSkewed: "Die Geräteuhr geht offenbar falsch",
    pending: "{count, plural, one {# Änderung ausstehend} other {# Änderungen ausstehend}}",
  },
  list: {
    loadError: "Deine Einträge konnten nicht geladen werden",
    retry: "Erneut versuchen",
    emptyTitle: "Noch keine Zeit erfasst",
    emptyDescription:
      "Gib oben ein, woran du arbeitest, und klick auf Starten – oder drück +, um schon geleistete Zeit nachzutragen.",
    importHistory: "Bisherige Zeiten importieren",
    loadingMore: "Frühere Tage werden geladen …",
    loadMore: "Frühere Tage laden",
    end: "Das ist alles, was du erfasst hast.",
  },
  row: {
    running: "Läuft",
    addDescription: "Beschreibung hinzufügen",
    now: "jetzt",
    nextDay: "+1 Tag",
    nextDayTitle: "Endet am nächsten Tag",
    recordedIn: "Erfasst in {zone}",
    stop: "Diesen Eintrag stoppen",
    continue: "Diesen Eintrag fortsetzen",
    actions: "Aktionen für den Eintrag",
    pin: "Zu Favoriten hinzufügen",
    unpin: "Aus Favoriten entfernen",
  },
  editDialog: {
    title: "Eintrag bearbeiten",
    description: "Ändere, was, wofür und wann erfasst wurde.",
    zoneNote:
      "Erfasst in {zoneLabel} ({zone}). Die Zeiten unten werden in dieser Zeitzone angezeigt und gespeichert, damit sie so bleiben, wie sie eingetragen wurden.",
  },
  manualDialog: {
    title: "Zeiteintrag hinzufügen",
    description: "Trag Arbeitszeit nach, die du nicht mit dem Timer erfasst hast.",
  },
  entryFields: {
    descriptionPlaceholder: "Woran hast du gearbeitet?",
    clientTitle: "Kunde: {name}",
  },
  projectPicker: {
    searchPlaceholder: "Projekte suchen …",
    empty: "Keine Projekte gefunden.",
    createProject: "Projekt „{project}“ erstellen",
    createProjectForClient: "Projekt „{project}“ für den Kunden „{client}“ erstellen",
    createHint: "Tipp: Gib „Kunde / Projekt“ ein, um beides auf einmal zu erstellen",
    newProject: "Neues Projekt …",
    created: "Projekt „{name}“ erstellt",
  },
  taskPicker: {
    searchPlaceholder: "Tätigkeit suchen oder erstellen …",
    empty: "Noch keine Tätigkeiten.",
    emptyForProject: "Noch keine Tätigkeiten in diesem Projekt. Tippe, um eine zu finden.",
    otherTasks: "Andere Tätigkeiten",
    createTask: "Tätigkeit „{name}“ erstellen",
    newTask: "Neue Tätigkeit …",
    created: "Tätigkeit „{name}“ erstellt",
  },
  quickStart: {
    trigger: "Schnellstart",
    triggerTitle: "Etwas starten, das du schon erfasst hast",
    favorites: "Favoriten",
    recents: "Zuletzt verwendet",
    moveUp: "{label} nach oben verschieben",
    moveDown: "{label} nach unten verschieben",
    unpin: "Nicht mehr anheften",
    unpinLabel: "{label} nicht mehr anheften",
    pinLabel: "{label} anheften",
    pinTitle: "Oben in diesem Menü anheften",
    noDescription: "Keine Beschreibung",
    projectDeleted: "Projekt gelöscht",
    projectArchived: "{project} (archiviert)",
    clientProject: "{client} · {project}",
  },
  idle: {
    screenLocked: "Bildschirm war {span} lang gesperrt",
    noInput: "{span} lang keine Eingabe",
    body: "Der Timer läuft seit {since}. Behalte die Zeit, wenn du gelesen, in einem Meeting gesessen oder telefoniert hast.",
    keep: "Ich habe gearbeitet",
    discard: "{span} verwerfen",
    discardAndResume: "Verwerfen und fortsetzen",
  },
  runaway: {
    title: "Dieser Timer lief {ran} lang",
    actionFlagged: "Der Timer läuft noch.",
    actionCapped: "Der Eintrag wurde auf die maximale Eintragsdauer gekürzt.",
    actionStopped: "Der Timer wurde gestoppt, die ganze Zeit bleibt erhalten.",
    body: "{action} Deine maximale Eintragsdauer ist {limit}. Behalte die Zeit, wenn du wirklich so lange gearbeitet hast.",
    realEnd: "Tatsächliches Ende",
    keepCap: "Kürzung behalten",
    keepLong: "Ich habe so lange gearbeitet",
    restore: "{ran} wiederherstellen",
    cap: "Auf {limit} kürzen",
    cutBack: "Auf {limit} kürzen",
    setEnd: "Ende festlegen …",
  },
  mutations: {
    startFailed: "Der Timer konnte nicht gestartet werden",
    stopFailed: "Der Timer konnte nicht gestoppt werden",
    addFailed: "Der Eintrag konnte nicht hinzugefügt werden",
    saveFailed: "Der Eintrag konnte nicht gespeichert werden",
    deleteFailed: "Der Eintrag konnte nicht gelöscht werden",
    updateFailed: "Der Eintrag konnte nicht aktualisiert werden",
    stoppedAfter: "Nach {duration} gestoppt",
    shortEntryKept: "Kurze Einträge bleiben erhalten, außer du verwirfst sie.",
    stillSyncing: "Wird noch synchronisiert – versuch es gleich noch einmal.",
  },
  favorites: {
    pinned: "Als Favorit angeheftet",
    pinFailed: "Anheften fehlgeschlagen",
    unpinFailed: "Anheften konnte nicht aufgehoben werden",
    reorderFailed: "Deine Favoriten konnten nicht neu sortiert werden",
  },
  offlineQueue: {
    rejected:
      "{count, plural, one {Eine Offline-Änderung konnte nicht gespeichert werden} other {# Offline-Änderungen konnten nicht gespeichert werden}}",
    rejectedDescription: "Der Server hat sie abgelehnt, deshalb wurden sie verworfen.",
    stale:
      "{count, plural, one {Ein alter Eintrag konnte nicht beendet werden} other {# alte Einträge konnten nicht beendet werden}}",
    staleDescription:
      "Ein Stopp, der vor mehr als einem Tag gespeichert wurde, verweist auf keinen Eintrag mehr, den wir sicher beenden können. Prüfe den Timer und stopp ihn von Hand.",
    held:
      "{count, plural, one {Eine Offline-Änderung wartet} other {# Offline-Änderungen warten}}",
    heldDescription:
      "Dein Server unterstützt sie noch nicht. Sie bleiben erhalten und werden gesendet, sobald der Server aktualisiert ist.",
  },
  desktopNotice: {
    idleTitle: "Du warst {span} lang abwesend",
    lockedTitle: "Dein Bildschirm war {span} lang gesperrt",
    idleBody: "Dein Timer läuft noch. Öffne Track Your Time, um die Zeit zu behalten oder zu verwerfen.",
    runawayTitle: "Dieser Timer läuft seit {ran}",
    runawayBody: "„{description}“ läuft noch. Öffne Track Your Time, um die Zeit zu behalten oder zu korrigieren.",
    runawayBodyNoDescription: "Dein Timer läuft noch. Öffne Track Your Time, um die Zeit zu behalten oder zu korrigieren.",
  },
};
