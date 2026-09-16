import type { Translation } from "@starter/shared";

import type { popup as source } from "../en/popup";

/** German `popup`. Terms follow packages/client/src/i18n/GLOSSARY.de.md; voice is „du“. */
export const popup: Translation<typeof source> = {
  workspace: {
    label: "Arbeitsbereich",
    heldTitle: "{count, plural, one {# Änderung} other {# Änderungen}} nicht gesendet",
    heldHint: "In einem Arbeitsbereich in die Warteschlange gestellt, zu dem dein Konto nicht mehr gehört. Sie werden an keinen anderen Arbeitsbereich gesendet. Bitte einen Inhaber, dich wieder hinzuzufügen, um sie zu synchronisieren, oder verwirf sie hier.",
    waitingNewer: {
      title: "{count, plural, one {# Änderung wartet} other {# Änderungen warten}} auf eine neuere Version",
      hint: "Eine neuere Version der Erweiterung hat diese Änderungen erstellt. Diese Version kann sie nicht lesen, deshalb werden sie nicht gesendet. Aktualisiere die Erweiterung, um sie zu synchronisieren, oder verwirf sie hier.",
    },
    waitingServer: {
      title: "{count, plural, one {# Änderung wird} other {# Änderungen werden}} von deinem Server noch nicht unterstützt",
      hint: "Dein Server unterstützt diese Änderungen noch nicht. Bitte deinen Admin, ihn zu aktualisieren – danach werden sie gesendet. Oder verwirf sie hier.",
    },
    waitingServerUpdate: {
      title: "{count, plural, one {# Änderung wartet} other {# Änderungen warten}} auf ein Server-Update",
      hint: "Dein Server ist älter als diese App. Diese Änderungen werden gesendet, sobald er aktualisiert ist.",
    },
    discardHintWaiting: "Damit löschst du Arbeit, die kein Server erhalten hat. Sie lässt sich nicht wiederherstellen.",
    leftWorkspace: "einen verlassenen Arbeitsbereich",
    untitled: "(ohne Beschreibung)",
    discard: "Verwerfen",
    discardHint: "Damit löschst du in {workspace} erfasste Arbeit, die kein Server erhalten hat. Sie lässt sich nicht wiederherstellen.",
    ops: {
      start: "„{description}“ in {workspace} starten",
      stop: "In {workspace} stoppen",
      create: "„{description}“ in {workspace} hinzufügen",
      update: "„{description}“ in {workspace} bearbeiten",
      remove: "Einen Eintrag in {workspace} löschen",
      other: "Eine Änderung in {workspace}",
    },
  },
  version: {
    serverTooOld:
      "Dieser Server läuft mit v{release} (API-Level {level}). Diese App braucht Level {min} oder höher. Bitte den Admin deines Servers, ihn zu aktualisieren.",
    serverTooOldNoRelease:
      "Dieser Server läuft mit einer älteren Version (API-Level {level}). Diese App braucht Level {min} oder höher. Bitte den Admin deines Servers, ihn zu aktualisieren.",
    howToUpdate: "So wird aktualisiert",
    clientTooOld: "Diese App ist zu alt für diesen Server. Aktualisiere die App.",
  },
  actions: {
    cancel: "Abbrechen",
    create: "Erstellen",
    creating: "Wird erstellt …",
    delete: "Löschen",
    signOut: "Abmelden",
    openApp: "Track Your Time öffnen",
    openAppExternal: "Track Your Time öffnen ↗",
  },
  fields: {
    description: "Beschreibung",
    project: "Projekt",
    noProject: "Kein Projekt",
    searchProjects: "Projekte suchen …",
    createProject: "Projekt „{name}“ erstellen",
    task: "Tätigkeit",
    noTask: "Keine Tätigkeit",
    searchTasks: "Tätigkeiten suchen …",
    createTask: "Tätigkeit „{name}“ erstellen",
    client: "Kunde",
    noClient: "Kein Kunde",
    searchClients: "Kunden suchen …",
    createClient: "Kunden „{name}“ erstellen",
    tags: "Schlagwörter",
    billable: "Abrechenbar",
    notBillable: "Nicht abrechenbar",
    start: "Beginn",
    end: "Ende",
    duration: "Dauer",
    day: "Tag",
  },
  app: {
    loading: "Wird geladen …",
    retry: "Erneut versuchen",
    signedIn: "Angemeldet",
    notes: {
      entryDeleted: "Eintrag gelöscht.",
      entryAdded: "Eintrag hinzugefügt.",
      entryGone: "Diesen Eintrag gibt es nicht mehr.",
      activityWiped: "Alle erfassten Aktivitäten wurden von diesem Gerät gelöscht.",
    },
  },
  errors: {
    credentials: "E-Mail und Passwort passen zu keinem Konto.",
    noSessionToken:
      "Der Server hat das Passwort akzeptiert, aber kein Sitzungstoken zurückgegeben, also kann sich die Erweiterung nichts merken. Dafür muss das Bearer-Plugin von better-auth aktiviert sein – eine erneute Anmeldung hilft nicht.",
    worker: "Der Hintergrunddienst der Erweiterung hat nicht geantwortet. Schließ das Pop-up und öffne es erneut.",
    unreachable:
      "{server} ist nicht erreichbar. Prüfe die Serveradresse und ob der Server läuft.",
    serverFailed: "Der Server hat mit {status} geantwortet. Versuch es gleich noch einmal.",
    invalidEmail: "Das sieht nicht nach einer E-Mail-Adresse aus.",
    emailNotVerified: "Bestätige deine E-Mail-Adresse, bevor du dich anmeldest.",
    twoFactorUnsupported:
      "Dieses Konto nutzt Zwei-Faktor-Authentifizierung, und die kann die Erweiterung nicht abschließen. Melde dich zuerst in diesem Browser in der Web-App an – die Erweiterung nutzt dann diese Sitzung.",
    noFetch: "Dieser Browser konnte die Anfrage nicht senden.",
    notSignedIn: "Melde dich zuerst an.",
    stillSyncing: "Dieser Eintrag ist noch nicht beim Server angekommen. Versuch es gleich noch einmal.",
    badTimeRange: "Das Ende muss nach dem Beginn liegen.",
    revokeSelf:
      "Das ist dieser Browser. Nutze stattdessen „Abmelden“, damit die Erweiterung auch ihre eigene Sitzung vergisst.",
    notRunning: "Es läuft kein Timer, also gibt es nichts zu bearbeiten.",
    invalidApiUrl: "Das ist keine gültige URL.",
    badMessage: "Die Erweiterung hat eine Nachricht erhalten, die sie nicht versteht.",
    forbidden: "Dafür fehlt dir die Berechtigung.",
    notFound: "Das wurde nicht gefunden. Vielleicht wurde es gelöscht.",
    tooManyRequests: "Zu viele Anfragen. Warte kurz und versuch es noch einmal.",
    generic: "Etwas ist schiefgelaufen. Versuch es noch einmal.",
    activityPermission:
      "Chrome hat keinen Zugriff auf die Tabs erlaubt, deshalb bleibt die Aktivitätserfassung aus.",
    activityPermissionFailed: "Chrome konnte nicht nach dem Zugriff auf die Tabs gefragt werden.",
    activityUnavailable:
      "Die Aktivitätserfassung hat noch kein Konto, dem sie etwas zuordnen kann. Versuch es gleich noch einmal.",
    suggestionTracked: "Diese Zeit ist schon erfasst oder ausgeblendet.",
    serverAccessMissing:
      "Chrome hat der Erweiterung keinen Zugriff auf {server} gegeben, deshalb kann sie diesen Server nicht erreichen.",
    serverAccessRefused:
      "Chrome hat der Erweiterung keinen Zugriff auf {server} gegeben, deshalb kann sie diesen Server nicht erreichen.",
    serverUnreachable: "{server} ist nicht erreichbar. Prüfe die Adresse und ob der Server läuft.",
    notTrackYourTime:
      "{server} hat geantwortet, ist aber kein Track-Your-Time-Server. Gib die Adresse ein, unter der du Track Your Time öffnest.",
    serverUnhealthy:
      "{server} ist ein Track-Your-Time-Server, erreicht seine Datenbank gerade aber nicht. Versuch es in einer Minute noch einmal.",
    unsentChanges:
      "Einige Änderungen haben den aktuellen Server noch nicht erreicht. Ein Serverwechsel meldet dich ab, und die Erweiterung verwirft diese Änderungen.",
    serverTooOld:
      "{server} läuft mit API-Level {level}. Diese App braucht Level {min} oder höher. Bitte den Admin des Servers, ihn zu aktualisieren.",
    serverTooOldUnknown:
      "{server} läuft mit einer älteren Version, als diese App braucht. Bitte den Admin des Servers, ihn zu aktualisieren.",
    serverEmpty: "Gib die Adresse deines Servers ein.",
    serverInvalid: "„{input}“ ist keine Webadresse. Eine Webadresse sieht so aus: https://track.example.com.",
    serverInsecure:
      "Verwende https:// für {host}. Einfaches http:// überträgt dein Passwort unverschlüsselt und wird deshalb nur für localhost akzeptiert.",
  },
  sync: {
    offline: "Offline",
    offlineQueued: "Offline · {count, number} ausstehend",
    offlineTitle:
      "Der Server antwortet nicht. Timer lassen sich trotzdem starten und stoppen und werden gesendet, sobald er wieder da ist.",
    offlineQueuedTitle:
      "Der Server antwortet nicht. {count, plural, one {# Änderung wird} other {# Änderungen werden}} gesendet, sobald er wieder da ist.",
    queued: "{count, number} ausstehend",
    queuedTitle: "{count, plural, one {# Änderung muss} other {# Änderungen müssen}} noch gesendet werden.",
    synced: "Synchronisiert",
    syncedTitle: "Live-Updates von deinen anderen Geräten sind verbunden.",
    connecting: "Verbinden …",
    connectingTitle: "Verbindung zu Live-Updates wird hergestellt.",
    polling: "Abfrage",
    pollingTitle:
      "Live-Updates sind nicht verfügbar, daher erscheinen Änderungen von anderswo mit kurzer Verzögerung. Alles, was du hier machst, wird normal gespeichert.",
  },
  header: {
    back: "Zurück",
    newEntry: "Neuer Eintrag",
    entries: "Einträge",
    settings: "Einstellungen",
    suggestions: "Vorschläge",
    suggestionsTitle: "Vorschläge aus deiner Aktivität",
  },
  server: {
    label: "Server",
    defaultServer: "Standard ({host})",
    ownServer: "Mein eigener Server",
    address: "Serveradresse",
    checking: "Server wird geprüft …",
    use: "Diesen Server verwenden",
    switchTitle: "Zu {server} wechseln?",
    discardAndSwitch: "Verwerfen und wechseln",
    unsentHint:
      "{count, plural, one {# Änderung hat {server} noch nicht erreicht. Ein Serverwechsel meldet dich ab, und die Erweiterung verwirft diese Änderung.} other {# Änderungen haben {server} noch nicht erreicht. Ein Serverwechsel meldet dich ab, und die Erweiterung verwirft diese Änderungen.}}",
    accessLost: "Chrome lässt die Erweiterung {host} nicht mehr erreichen.",
    accessLostRefused:
      "Chrome lässt die Erweiterung {host} nicht mehr erreichen. Der Zugriff wurde nicht erlaubt, deshalb kann die Erweiterung den Server weiterhin nicht erreichen.",
    allowAccess: "Zugriff erlauben",
  },
  suggestions: {
    title: "Vorschläge",
    filesUnder: "Wird unter {project} abgelegt",
    filedByRule: "Von einer Regel abgelegt, ohne Projekt",
    accept: "Übernehmen",
    edit: "Bearbeiten",
    dismiss: "Ausblenden",
    alwaysFile: "{site} immer ablegen unter",
    alwaysFileOpen: "{site} immer ablegen unter …",
    saveRule: "Regel speichern",
    rules: "Regeln auf diesem Gerät",
    remove: "Entfernen",
    off: "Die Aktivitätserfassung ist aus. Wenn sie an ist, merkt sich dieser Browser, auf welchen Websites du Zeit verbringst – nur auf diesem Gerät – und schlägt Einträge für Zeit vor, die du nicht erfasst hast.",
    openSettings: "Aktivitätseinstellungen öffnen",
    empty: "An diesem Tag gibt es keine nicht erfasste Aktivität.",
    acceptTitle: "Vorschlag übernehmen",
    acceptSubmit: "Als Eintrag übernehmen",
    accepting: "Wird übernommen …",
  },
  activity: {
    storageNewerVersion:
      "Die Aktivitätsdaten stammen von einer neueren Version der Erweiterung. Die Erfassung bleibt aus, bis diese Version wieder installiert ist. Es wurde nichts gelöscht.",
    enabledNote:
      "Merkt sich die Website, die du gerade vor dir hast, nur auf diesem Gerät. Es wird nichts gesendet, bis du einen Vorschlag übernimmst.",
    on: "Aktivität wird erfasst",
    off: "Aktivitätserfassung aus",
    titlesNote:
      "Seitentitel verraten mehr über dich als Websitenamen. Wenn das aus ist, wird nur der Hostname gespeichert.",
    storingTitles: "Seitentitel werden gespeichert",
    hostnamesOnly: "Nur Hostnamen",
    exclude: "Nie erfassen",
    excludeNote:
      "Websites auf dieser Liste werden nie gespeichert. Mit *.example.com schließt du eine ganze Domain aus. Inkognito-Tabs werden nie erfasst.",
    add: "Hinzufügen",
    remove: "Entfernen",
    retention: "Aktivität aufbewahren für",
    retentionNote: "Ältere Aktivität wird jeden Tag gelöscht. Regeln bleiben erhalten.",
    retentionSuffix: "Tage",
    retentionLabel: "Aufbewahrung der Aktivität in Tagen",
    wipeNote: "Entfernt erfasste Aktivität, Regeln und ausgeblendete Vorschläge von diesem Gerät.",
    wipeNoteCount:
      "{count, plural, one {# gespeicherter Aktivitätsabschnitt. Entfernt ihn, deine Regeln und ausgeblendete Vorschläge von diesem Gerät.} other {# gespeicherte Aktivitätsabschnitte. Entfernt sie, deine Regeln und ausgeblendete Vorschläge von diesem Gerät.}}",
    wipe: "Alle Aktivität jetzt löschen",
    wipeTitle: "Alle erfasste Aktivität löschen?",
    wipeHint: "Einträge, die du schon übernommen hast, bleiben unberührt. Das lässt sich nicht rückgängig machen.",
  },
  menu: {
    more: "Mehr",
    reports: "Berichte",
  },
  idle: {
    alert: "{span} abwesend – klären",
    lockedTitle: "Bildschirm war {span} lang gesperrt",
    inputTitle: "{span} lang keine Eingabe",
    hint: "Der Timer läuft noch. Behalte die Zeit, wenn du gelesen, in einem Meeting gesessen oder telefoniert hast.",
    keep: "Ich habe gearbeitet",
    discard: "{span} verwerfen",
    discardAndResume: "Verwerfen und fortsetzen",
  },
  dayStepper: {
    previous: "Vorheriger Tag",
    next: "Nächster Tag",
    today: "Heute",
  },
  entry: {
    today: "Heute",
    yesterday: "Gestern",
    noDescription: "Keine Beschreibung",
    running: "Läuft",
    pendingTitle: "Noch nicht gesendet – bearbeitbar, sobald er synchronisiert ist",
    projectDeleted: "Projekt gelöscht",
    projectArchived: "{project} (archiviert)",
    clientAndProject: "{client} · {project}",
  },
  tagPicker: {
    remove: "{name} entfernen",
    search: "Schlagwörter suchen oder hinzufügen …",
    addAnother: "Weiteres Schlagwort …",
    create: "Schlagwort „{name}“ erstellen",
  },
  signIn: {
    title: "Bei Track Your Time anmelden",
    email: "E-Mail",
    password: "Passwort",
    submitting: "Wird angemeldet …",
    submit: "Anmelden",
    signingInTo: "Anmeldung bei",
    changeServer: "Server wechseln",
    keepServer: "Abbrechen",
  },
  section: {
    saved: "Gespeichert",
  },
  quickStart: {
    title: "Schnellstart",
    rowTitle: "{label} – {hint}",
    pin: "{label} anheften",
    unpin: "{label} nicht mehr anheften",
  },
  timeField: {
    rejected: "Keine Uhrzeit – versuch 9:30, 930 oder 21:30.",
  },
  combobox: {
    create: "„{name}“ erstellen",
    notAvailable: "Nicht verfügbar",
    search: "Suchen …",
    noMatches: "Keine Treffer",
  },
  description: {
    fillTitle: "„{description}“ mit Projekt, Tätigkeit, Schlagwörtern und Abrechenbarkeit übernehmen",
    fillLabel: "„{description}“ mit allen Feldern übernehmen",
    legend: "⇥ vervollständigt",
    legendWithFill: "⇥ vervollständigt · ＋ oder ⌘⏎ übernimmt Projekt und Schlagwörter",
  },
  projectPicker: {
    newTitle: "Neues Projekt „{name}“",
  },
  entryForm: {
    descriptionPlaceholder: "Was war das?",
    onInvoice: "Abgerechnet",
    notSent: "Noch nicht gesendet",
    zoneNote: "Erfasst in {zone} und in dieser Zeitzone bearbeitet.",
  },
  tracker: {
    descriptionPlaceholder: "Woran arbeitest du?",
    start: "Starten",
    stop: "Stoppen",
    today: "Heute",
  },
  entries: {
    title: "Einträge",
    empty:
      "{days, plural, one {Heute noch nichts erfasst.} other {In den letzten # Tagen nichts erfasst.}}",
    newEntry: "Neuer Eintrag",
    loadOlder: "Ältere laden",
    end: "{days, plural, one {Das ist alles von heute.} other {Das sind die letzten # Tage.}} Ältere Einträge findest du in der Web-App.",
  },
  entryNew: {
    title: "Neuer Eintrag",
    duration: "Das sind {duration}.",
    adding: "Wird hinzugefügt …",
    add: "Eintrag hinzufügen",
  },
  entryDetail: {
    title: "Eintrag",
    queued: "Noch nicht gesendet – versuch es gleich noch einmal.",
    invoiced:
      "Abgerechnet – Zeiten, Projekt und Abrechenbarkeit sind gesperrt. Beschreibung und Schlagwörter kannst du noch ändern.",
    deleteTitle: "Diesen Eintrag löschen?",
    deleteHint: "{duration} · {day} · {subtitle}",
    cannotDelete: "Ein abgerechneter Eintrag kann nicht gelöscht werden.",
    deleteEntry: "Eintrag löschen",
  },
  settings: {
    title: "Einstellungen",
    loading: "Einstellungen werden geladen …",
    on: "An",
    off: "Aus",
    sections: {
      general: "Allgemein",
      idle: "Inaktivität",
      limits: "Limits",
      devices: "Geräte",
      activity: "Aktivität",
      account: "Konto",
    },
  },
  general: {
    hint: "{clock} · {duration} · {currency}",
    workspaceNote: "Gilt für den ganzen Arbeitsbereich",
    language: "Sprache",
    languageNote: "Gilt auch für die Web-App und deine anderen Geräte.",
    languages: {
      system: "Wie im System",
      en: "English",
      de: "Deutsch",
    },
    theme: "Design",
    themeNote: "Gilt auch für die Web-App und deine anderen Geräte.",
    themes: {
      system: "Wie im System",
      light: "Hell",
      dark: "Dunkel",
    },
    timeFormat: "Zeitformat",
    timeFormats: {
      "24h": "24 Stunden",
      "12h": "12 Stunden",
    },
    durationFormat: "Dauerformat",
    durationFormatNote: "Die meisten Rechnungen erwarten Dezimalstunden.",
    weekStart: "Woche beginnt am",
    currency: "Währung",
    currencyOption: "{code} – {name}",
    defaultRate: "Standard-Stundensatz",
    defaultRateNote:
      "Gilt, wenn das Projekt eines abrechenbaren Eintrags keinen eigenen Satz hat. Gilt für den ganzen Arbeitsbereich.",
  },
  idleSettings: {
    hint: "{behavior, select, ask {Nachfragen} pause {Pausieren} keep {Weiterlaufen} other {Stoppen}} nach {minutes, number} min",
    enabledNote:
      "Jedes Gerät beobachtet nur seine eigenen Eingaben. Ein Gerät, das den Timer nicht gestartet hat, rührt ihn nie an.",
    on: "Inaktivität wird erkannt",
    off: "Inaktivitätserkennung aus",
    threshold: "Abwesend nach",
    thresholdNote: "Wie lange ohne Eingabe, bis du als abwesend giltst.",
    thresholdLabel: "Schwelle für Inaktivität in Minuten",
    minutesSuffix: "min",
    behavior: "Bei Abwesenheit",
    lockNote: "Sperren ist eine bewusste Handlung, deshalb muss die Schwelle nicht erst abgewartet werden.",
    lockImmediate: "Sperren zählt sofort",
    lockWaits: "Sperren wartet die Schwelle ab",
    behaviors: {
      ask: {
        label: "Nachfragen",
        description:
          "Der Timer läuft weiter, und du entscheidest, wenn du zurück bist. Nichts wird verworfen, solange du es nicht sagst.",
      },
      pause: {
        label: "Pausieren und fortsetzen",
        description:
          "Beendet den Eintrag dort, wo die Inaktivität begann, und öffnet einen gleichen Eintrag, sobald du zurück bist.",
      },
      keep: {
        label: "Weiterlaufen lassen",
        description:
          "Reagiert nie auf Inaktivität. Für Lesen, Meetings und Anrufe, bei denen keine Eingabe normal ist.",
      },
      stop: {
        label: "Timer stoppen",
        description: "Beendet den Eintrag dort, wo die Inaktivität begann, und lässt den Timer gestoppt.",
      },
    },
  },
  limits: {
    hint: "{hours, number} h, dann {behavior, select, ask {nachfragen} cap {kürzen} other {stoppen}}",
    enabledNote:
      "Wird auf dem Server geprüft, nicht auf deinen Geräten – genau für den Fall, dass keins davon lief.",
    on: "Vergessene Timer werden abgefangen",
    off: "Schutz vor vergessenen Timern aus",
    after: "Nach",
    afterNote: "Wähle einen Wert über jeder glaubhaften Arbeitssitzung und unter einer ganzen Nacht.",
    hoursLabel: "Maximale Eintragsdauer in Stunden",
    hoursSuffix: "h",
    then: "Dann",
    behaviors: {
      ask: {
        label: "Nachfragen",
        description:
          "Der Timer läuft weiter, und du wirst beim nächsten Hinsehen gefragt. Nichts wird gekürzt, solange du es nicht sagst.",
      },
      cap: {
        label: "Kürzen",
        description:
          "Beendet den Eintrag beim Maximum und verwirft den Rest. Die ursprüngliche Dauer bleibt am Eintrag gespeichert, damit du sie wiederherstellen kannst.",
      },
      stop: {
        label: "Stoppen",
        description:
          "Beendet den Eintrag dort, wo er gerade steht. Jede Sekunde bleibt erhalten – der Timer wächst nur nicht weiter.",
      },
    },
  },
  devices: {
    hint: "{count, plural, one {# angemeldet} other {# angemeldet}}",
    loading: "Geräte werden geladen …",
    thisBrowser: "Dieser Browser",
    lastActive: "{client} · zuletzt aktiv {when}",
    justNow: "gerade eben",
    unknown: "unbekannt",
    clients: {
      web: "Web",
      desktop: "Desktop",
      mobile: "Mobil",
      raycast: "Raycast",
      extension: "Browsererweiterung",
      cli: "CLI",
      unknown: "Unbekannt",
    },
    signOutBrowserTitle: "Diesen Browser abmelden?",
    signOutDeviceTitle: "Dieses Gerät abmelden?",
    sharedSessionHint:
      "Diese Sitzung teilt sich die Erweiterung mit der Web-App. Wenn du dich hier abmeldest, wird Track Your Time auch in diesem Browser abgemeldet.",
    signOutBrowserHint: "Die Erweiterung vergisst ihre Sitzung, und du meldest dich neu an.",
    signOutDeviceHint:
      "{name} synchronisiert sofort nicht mehr und muss sich neu anmelden. Nichts, was dort schon erfasst wurde, geht verloren.",
    signOutOthers: "Andere Geräte abmelden",
    signOutOthersTitle: "Alle anderen Geräte abmelden?",
    signOutOthersHint: "Dieser Browser bleibt angemeldet. Alle anderen Geräte müssen sich neu anmelden.",
    signOutOthersConfirm: "Abmelden",
  },
  account: {
    signedInAs: "Angemeldet als",
    appVersion: "Erweiterung, Version {version}",
    sharedSession:
      "Mit der Sitzung der Web-App angemeldet – wenn du dich hier abmeldest, wird Track Your Time auch in diesem Browser abgemeldet.",
    changeServer: "Server wechseln …",
    keepServer: "Diesen Server behalten",
    signOutTitle: "Abmelden?",
    signOutSharedHint:
      "Diese Sitzung teilt sich die Erweiterung mit der Web-App, deshalb wird Track Your Time auch in diesem Browser abgemeldet.",
    signOutHint: "Alles bereits Erfasste bleibt erhalten. Melde dich wieder an, um weiter zu erfassen.",
  },
};
