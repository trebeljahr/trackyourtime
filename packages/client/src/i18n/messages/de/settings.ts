import type { Translation } from "@starter/shared";

import type { settings as source } from "../en/settings";

/** German `settings`. Terms follow i18n/GLOSSARY.de.md; voice is „du“. */
export const settings: Translation<typeof source> = {
  about: {
    appVersion: "Track Your Time, Version {version}",
    appVersionUnknown: "Track Your Time (Entwicklungs-Build)",
    apiLevel: "API-Level {level}",
    server: "Server: {version}, API-Level {level}",
    serverUnknown: "Server: Version unbekannt",
    updateAvailable: "v{version} ist verfügbar.",
    releaseNotes: "Versionshinweise",
    upgrading: "So aktualisierst du",
  },
  page: {
    title: "Einstellungen",
    description:
      "Die Einstellungen gelten für jede Track-Your-Time-App, die mit deinem Konto angemeldet ist. Änderungen werden sofort gespeichert.",
    tabs: {
      general: "Allgemein",
      workspace: "Arbeitsbereich",
      billing: "Abrechnung",
      idle: "Inaktivität",
      limits: "Limits",
      data: "Daten",
      devices: "Geräte",
      integrations: "Integrationen",
      account: "Konto",
      desktop: "Desktop",
    },
  },
  toasts: {
    saveFailed: "Deine Einstellungen konnten nicht gespeichert werden",
  },
  profile: {
    title: "Profil",
    description: "Verwalte deine Profilangaben",
    loading: "Profil wird geladen …",
    bio: "Über mich",
    noBio: "Noch nichts über dich eingetragen",
    edit: "Profil bearbeiten",
  },
  general: {
    title: "Allgemein",
    description: "Wie Track Your Time aussieht und wie es Datumsangaben und Dauern anzeigt.",
    theme: {
      title: "Design",
      description:
        "Wird in deinem Konto gespeichert, damit die Browsererweiterung und deine anderen Geräte es übernehmen.",
      light: "Hell",
      dark: "Dunkel",
      system: "System",
    },
    weekStart: {
      title: "Woche beginnt am",
      description: "Legt die erste Spalte des Wochen-Stundenzettels und den Zeitraum „Diese Woche“ fest.",
    },
    timeFormat: {
      title: "Zeitformat",
      description: "Uhrzeiten werden als {sample} angezeigt.",
      hour24: "24 Stunden",
      hour12: "12 Stunden",
    },
    durationFormat: {
      title: "Dauerformat",
      description: "Dauern werden als {sample} angezeigt. Die meisten Rechnungen erwarten Dezimalstunden.",
    },
  },
  billing: {
    title: "Abrechnung",
    description: "Der Satz für abrechenbare Zeit, wenn ein Projekt keinen eigenen Satz hat.",
    defaultRate: {
      title: "Standard-Stundensatz",
      description: "Gilt immer dann, wenn ein abrechenbarer Eintrag zu einem Projekt ohne eigenen Satz gehört.",
    },
    currency: {
      title: "Währung",
      description: "Beträge werden als {sample} angezeigt.",
      placeholder: "Währung auswählen",
    },
    snapshotNote:
      "Eine Änderung von Satz oder Währung gilt nur für Zeit, die du ab jetzt erfasst – jeder Eintrag speichert den Satz und die Währung vom Moment, in dem er gestoppt wurde. Frühere Berichte und Rechnungen ändern sich also nie.",
  },
  idle: {
    title: "Inaktivitätserkennung",
    description:
      "Erkennt, wenn du nicht mehr arbeitest, und lässt dich entscheiden, was mit dem laufenden Timer passiert.",
    enabled: {
      title: "Inaktivität erkennen",
      description:
        "Jedes Gerät beobachtet nur seine eigenen Eingaben. Ein Gerät, das den Timer nicht gestartet hat, rührt ihn nie an. Ein schlafender Laptop kann also keine Arbeit pausieren, die du woanders machst.",
    },
    threshold: {
      title: "Inaktiv nach",
      description: "Wie lange ohne Eingabe, bis du als abwesend giltst.",
      ariaLabel: "Schwelle für Inaktivität in Minuten",
    },
    behavior: {
      title: "Bei Inaktivität",
    },
    behaviors: {
      ask: {
        label: "Nachfragen",
        description:
          "Der Timer läuft weiter, und du entscheidest, wenn du zurück bist. Nichts wird verworfen, solange du es nicht sagst.",
      },
      "pause-and-resume": {
        label: "Pausieren und fortsetzen",
        description:
          "Beendet den Eintrag dort, wo die Inaktivität begann, und öffnet einen gleichen Eintrag, sobald du zurück bist.",
      },
      "keep-running": {
        label: "Weiterlaufen lassen",
        description:
          "Reagiert nie auf Inaktivität. Für Lesen, Meetings und Anrufe, bei denen keine Eingabe normal ist.",
      },
      stop: {
        label: "Timer stoppen",
        description: "Beendet den Eintrag dort, wo die Inaktivität begann, und lässt den Timer gestoppt.",
      },
    },
    lock: {
      title: "Gesperrten Bildschirm als abwesend werten",
      description: "Sperren ist eine bewusste Handlung, deshalb muss die Schwelle nicht erst abgewartet werden.",
    },
    projects: {
      title: "Pro Projekt festlegen",
      description:
        "Projekte können im Projektdialog ihr eigenes Verhalten wählen – stell „Weiterlaufen lassen“ für Projekte ein, bei denen Tippen nicht üblich ist, etwa Meetings oder Lesen.",
      location: "Verwalten → Projekte",
    },
  },
  maxDuration: {
    title: "Maximale Eintragsdauer",
    description:
      "Fängt den Timer ab, den du Freitagabend gestartet hast und der am Montagmorgen immer noch läuft.",
    enabled: {
      title: "Vergessene Timer abfangen",
      description:
        "Wird auf dem Server geprüft, nicht auf deinen Geräten – genau für den Fall, dass keins davon lief.",
    },
    hours: {
      title: "Länger als",
      description: "Wähle einen Wert über jeder glaubhaften Arbeitssitzung und unter einer ganzen Nacht.",
      ariaLabel: "Maximale Eintragsdauer in Stunden",
    },
    behavior: {
      title: "Wenn ein Timer so lange läuft",
    },
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
    undo: {
      title: "Nichts wird endgültig gelöscht",
      description:
        "Ein gekürzter Eintrag behält die Dauer, die er wirklich gelaufen ist. Die Wiederherstellung ist in der Nachfrage immer nur einen Klick entfernt.",
      always: "Immer",
    },
  },
  account: {
    title: "Konto",
    description: "Die Identität, der jeder Kunde, jedes Projekt und jeder Zeiteintrag zugeordnet ist.",
    signedInAs: "Angemeldet als",
    picture: {
      title: "Profilbild",
      description: "Erscheint in der Kopfzeile und, für Kolleginnen und Kollegen, neben deinem Namen. Wird auf deinem Gerät quadratisch zugeschnitten und verkleinert.",
      upload: "Bild hochladen",
      change: "Bild ändern",
      remove: "Entfernen",
      toasts: {
        saved: "Profilbild gespeichert",
        removed: "Profilbild entfernt",
      },
      errors: {
        unsupported: "Diese Datei ist kein Bild, das die App verwenden kann. Wähle ein JPEG, PNG oder WebP.",
        tooLarge: "Dieses Bild ist zu groß. Wähle eines unter 25 MB.",
        failed: "Dein Profilbild konnte nicht gespeichert werden",
      },
    },
    notifications: {
      title: "E-Mail-Benachrichtigungen",
      description: "E-Mails zum Produkt und zu deinem Konto. Timer-Erinnerungen sind davon getrennt.",
    },
    signOut: {
      description: "Beendet nur diese Sitzung auf diesem Gerät.",
    },
    subscription: {
      title: "Abonnement",
      description: "Verwalte dein Abonnement und deine Zahlungsmethoden.",
      manage: "Zahlungen verwalten",
      manageUnavailable: "Zahlungen verwalten (nicht verfügbar)",
      unconfigured: "Stripe ist nicht vollständig eingerichtet.",
      unconfiguredWithMode: "Stripe ist nicht vollständig eingerichtet (Modus: {mode}).",
      unconfiguredDetail:
        "Die Zahlungs-Endpunkte (Checkout, Kundenportal, Webhooks) geben Fehler zurück, bis jedes Stripe-Secret einen echten Wert hat. Der Rest der App ist davon nicht betroffen.",
      missingKeys: "Fehlende Umgebungsvariablen:",
    },
    toasts: {
      profileFailed: "Dein Profil konnte nicht aktualisiert werden",
      signOutFailed: "Abmelden fehlgeschlagen. Versuch es noch einmal.",
    },
  },
  deleteAccount: {
    title: "Konto löschen",
    description:
      "Löscht dein Konto, meldet jedes Gerät ab und löscht die Daten, die dir gehören. Das lässt sich nicht rückgängig machen.",
    dialog: {
      title: "Dein Konto löschen?",
      descriptionWithEmail:
        "Damit wird {email} endgültig gelöscht und jedes Gerät abgemeldet, auch die Browsererweiterung, Raycast und die Mobil-App. Das lässt sich nicht rückgängig machen.",
      description:
        "Damit wird dein Konto endgültig gelöscht und jedes Gerät abgemeldet, auch die Browsererweiterung, Raycast und die Mobil-App. Das lässt sich nicht rückgängig machen.",
      soloTitle: "In Arbeitsbereichen, die nur du nutzt, wird alles gelöscht:",
      soloDetail:
        "Zeiteinträge, Kunden, Projekte, Tätigkeiten, Schlagwörter, angeheftete Schnellstarts, Rechnungen, Importverlauf, API-Tokens, Webhooks und Einstellungen des Arbeitsbereichs.",
      sharedTitle: "In Arbeitsbereichen, die du mit anderen teilst, werden nur deine eigenen Daten gelöscht:",
      sharedDetail:
        "deine Zeiteinträge, angehefteten Schnellstarts, API-Tokens, Webhooks und Importe. Der Arbeitsbereich mit seinen Kunden, Projekten, Tätigkeiten, Schlagwörtern und Rechnungen bleibt bestehen, ebenso Einträge, die schon in einer Rechnung stehen. Bist du der letzte Inhaber, geht der Arbeitsbereich an einen Admin über, sonst an das Mitglied, das am längsten dabei ist.",
      exportHint: "Willst du vorher eine Kopie? <link>Exportiere deine Daten als JSON</link>, bevor du weitermachst.",
      exportHintPlain:
        "Willst du vorher eine Kopie? Exportiere deine Daten unter Einstellungen → Daten als JSON, bevor du weitermachst.",
      unsynced:
        "{count, plural, one {# Änderung auf diesem Gerät ist noch nicht synchronisiert und wird verworfen.} other {# Änderungen auf diesem Gerät sind noch nicht synchronisiert und werden verworfen.}}",
      checking: "Prüfe, wie du bestätigen kannst …",
      password: "Dein Passwort",
      typeEmail: "Gib <mono>{email}</mono> ein, um zu bestätigen",
      confirm: "Konto endgültig löschen",
    },
    refusals: {
      passwordRequired: "Gib dein Passwort ein, um dein Konto zu löschen.",
      invalidPassword: "Das Passwort ist falsch. Es wurde nichts gelöscht.",
      sessionExpired:
        "Ein Konto ohne Passwort kann nur kurz nach einer Anmeldung gelöscht werden. Melde dich ab, wieder an und lösche es innerhalb von 24 Stunden.",
      failed: "Dein Konto konnte nicht gelöscht werden und besteht weiter. Versuch es noch einmal.",
    },
    toasts: {
      deleted: "Dein Konto wurde gelöscht",
    },
  },
  devices: {
    title: "Geräte & Apps",
    description:
      "Alles, was mit deinem Konto angemeldet ist. Melde dich in der Desktop-App, der Mobil-App, in Raycast oder einer Browsererweiterung an, und sie erscheint hier – du musst nichts kopieren oder einfügen.",
    revokeOthers: "Andere abmelden",
    tokenNotPersisted: {
      title: "Du meldest dich bei jedem Start der App neu an",
      body: "Dieser Computer hat keinen Schlüsselbund, mit dem die Anmeldung verschlüsselt werden kann (Speicher: {backend}). Die Desktop-App behält sie deshalb nur im Arbeitsspeicher. Installiere und entsperre einen Schlüsselbund wie GNOME Keyring oder KWallet, um angemeldet zu bleiben.",
    },
    empty: {
      title: "Keine anderen Geräte",
      description: "Melde dich in einer anderen App an, dann erscheint sie hier.",
    },
    columns: {
      device: "Gerät",
      signedIn: "Angemeldet",
      lastActive: "Zuletzt aktiv",
      actions: "Aktionen",
    },
    current: "Dieses Gerät",
    clientVersion: "· {version}",
    justNow: "Gerade eben",
    revoke: {
      title: "{name} abmelden?",
      titleThisDevice: "Dieses Gerät abmelden?",
      description:
        "Die App synchronisiert sofort nicht mehr und muss sich neu anmelden. Nichts, was sie schon erfasst hat, geht verloren.",
    },
    connectHint: {
      title: "Raycast oder eine CLI verbinden",
      body: "Apps, die kein Anmeldeformular zeigen können, geben dir stattdessen einen kurzen Code. Öffne <link>/app/device</link>, während du hier angemeldet bist, und gib ihn ein – die App ist dann mit deinem Konto angemeldet und erscheint in der Liste oben.",
    },
    toasts: {
      revoked: "Gerät abgemeldet.",
      revokeFailed: "Das Gerät konnte nicht abgemeldet werden",
      revokedOthers: "{count, plural, one {# Gerät abgemeldet.} other {# Geräte abgemeldet.}}",
      revokeOthersFailed: "Die anderen Geräte konnten nicht abgemeldet werden",
    },
  },
  foreignQueue: {
    held: {
      unknownOp: {
        title: "Wartet auf eine neuere App-Version",
        description:
          "{count, plural, one {# Änderung auf diesem Gerät stammt von einer neueren Version von Track Your Time.} other {# Änderungen auf diesem Gerät stammen von einer neueren Version von Track Your Time.}} Diese Version kann sie nicht lesen, deshalb werden sie nicht gesendet. Aktualisiere die App, um sie zu synchronisieren, oder verwirf sie hier.",
      },
      unknownProcedure: {
        title: "Dein Server unterstützt das noch nicht",
        description:
          "{count, plural, one {# Änderung auf diesem Gerät braucht eine Funktion, die dein Server noch nicht hat.} other {# Änderungen auf diesem Gerät brauchen eine Funktion, die dein Server noch nicht hat.}} Bitte deinen Admin, den Server zu aktualisieren – danach werden sie gesendet. Oder verwirf sie hier.",
      },
      serverTooOld: {
        title: "Dein Server ist älter als diese App",
        description:
          "Dein Server ist älter als diese App. {count, plural, one {Diese Änderung wird} other {Diese # Änderungen werden}} gesendet, sobald er aktualisiert ist. Bitte deinen Admin, den Server zu aktualisieren, oder verwirf sie hier.",
      },
      confirm:
        "Damit löschst du Arbeit, die kein Server je erhalten hat. Sie lässt sich nicht wiederherstellen. Aktualisiere stattdessen die App oder den Server, wenn sie erhalten bleiben soll.",
    },
    leftTitle: "Nicht synchronisierte Daten für {workspace}",
    leftWorkspace: "einen verlassenen Arbeitsbereich",
    leftDescription: "{count, plural, one {# Änderung} other {# Änderungen}} auf diesem Gerät in {workspace} in die Warteschlange gestellt. Dein Konto gehört nicht mehr dazu. Sie werden an keinen anderen Arbeitsbereich gesendet. Bitte einen Inhaber, dich wieder hinzuzufügen, um sie zu synchronisieren, oder verwirf sie hier.",
    inWorkspace: "in {workspace}",
    confirmLeft: "Damit löschst du in {workspace} erfasste Arbeit, die kein Server je erhalten hat. Sie lässt sich nicht wiederherstellen. Bitte stattdessen einen Inhaber, dich wieder hinzuzufügen, wenn sie erhalten bleiben soll.",
    titleDevice: "Nicht synchronisierte Daten auf diesem Gerät",
    pendingRows:
      "{count, plural, one {# Änderung auf diesem Gerät kann von hier aus nicht gesendet werden.} other {# Änderungen auf diesem Gerät können von hier aus nicht gesendet werden.}}",
    title: "Nicht synchronisierte Daten eines anderen Kontos",
    titleServer: "Nicht synchronisierte Daten für {server}",
    serverSummary:
      "{count, plural, one {# Änderung wurde auf diesem Gerät gespeichert, während es {server} verwendet hat.} other {# Änderungen wurden auf diesem Gerät gespeichert, während es {server} verwendet hat.}}",
    serverSummaryWithRange:
      "{count, plural, one {# Änderung wurde auf diesem Gerät gespeichert, während es {server} verwendet hat ({range}).} other {# Änderungen wurden auf diesem Gerät gespeichert, während es {server} verwendet hat ({range}).}}",
    serverExplanation:
      "Diese Änderungen wurden nie gesendet und werden auch nicht an {here} gesendet – sonst landen sie auf einem Server, für den sie nicht bestimmt waren. Stell dieses Gerät auf dem Anmeldebildschirm wieder auf {server} um, um sie zu synchronisieren, oder verwirf sie hier.",
    summary:
      "{count, plural, one {# Änderung wurde auf diesem Gerät von einem Konto gespeichert, das nicht angemeldet ist.} other {# Änderungen wurden auf diesem Gerät von einem Konto gespeichert, das nicht angemeldet ist.}}",
    summaryWithRange:
      "{count, plural, one {# Änderung wurde auf diesem Gerät von einem Konto gespeichert, das nicht angemeldet ist ({range}).} other {# Änderungen wurden auf diesem Gerät von einem Konto gespeichert, das nicht angemeldet ist ({range}).}}",
    explanation:
      "Diese Änderungen wurden nie an einen Server gesendet und werden nicht unter deinem Konto nachgeholt – sonst landet die Arbeit von jemand anderem in deinem Arbeitsbereich. Melde dich auf diesem Gerät mit diesem Konto an, um sie zu synchronisieren, oder verwirf sie hier.",
    ops: {
      start: "Timer gestartet",
      stop: "Timer gestoppt",
      create: "Zeit nachgetragen",
      update: "Eintrag bearbeitet",
      remove: "Eintrag gelöscht",
      discard: "Timer verworfen",
      unknown: "Unbekannte Änderung",
    },
    unknownTime: "Unbekannte Zeit",
    discard: "{count, plural, one {# Änderung verwerfen} other {# Änderungen verwerfen}}",
    confirm: {
      title:
        "{count, plural, one {# nicht synchronisierte Änderung verwerfen?} other {# nicht synchronisierte Änderungen verwerfen?}}",
      description:
        "Damit wird Arbeit gelöscht, die nie ein Server erhalten hat. Sie lässt sich nicht wiederherstellen – weder durch eine Anmeldung dieses Kontos hier noch aus einem Backup. Wenn sie erhalten bleiben soll, melde dich stattdessen auf diesem Gerät mit diesem Konto an.",
      descriptionWithRange:
        "Damit wird erfasste Arbeit ({range}) gelöscht, die nie ein Server erhalten hat. Sie lässt sich nicht wiederherstellen – weder durch eine Anmeldung dieses Kontos hier noch aus einem Backup. Wenn sie erhalten bleiben soll, melde dich stattdessen auf diesem Gerät mit diesem Konto an.",
      serverDescription:
        "Damit wird Arbeit gelöscht, die nie ein Server erhalten hat. Sie lässt sich nicht wiederherstellen – weder durch einen Wechsel zurück zu {server} noch aus einem Backup. Wenn sie erhalten bleiben soll, stell dieses Gerät stattdessen wieder auf {server} um.",
      serverDescriptionWithRange:
        "Damit wird erfasste Arbeit ({range}) gelöscht, die nie ein Server erhalten hat. Sie lässt sich nicht wiederherstellen – weder durch einen Wechsel zurück zu {server} noch aus einem Backup. Wenn sie erhalten bleiben soll, stell dieses Gerät stattdessen wieder auf {server} um.",
      delete: "Endgültig löschen",
    },
    toasts: {
      discarded:
        "{count, plural, one {# nicht synchronisierte Änderung verworfen} other {# nicht synchronisierte Änderungen verworfen}}",
      discardFailed: "Die Änderungen konnten nicht verworfen werden",
    },
  },
  secret: {
    warning: "Kopiere es jetzt – es wird nur dieses eine Mal angezeigt.",
    stored: "Ich habe es gespeichert",
    toasts: {
      copyUnavailable: "Kopieren ist hier nicht möglich – markiere den Wert von Hand.",
      copied: "In die Zwischenablage kopiert.",
      copyFailed: "Kopieren fehlgeschlagen – markiere den Wert und kopiere ihn von Hand.",
    },
  },
  apiTokens: {
    title: "API-Tokens",
    description:
      "Schlüssel für Skripte, CI-Jobs und andere Tools, die die REST-API nutzen, statt sich anzumelden. Jedes Token gehört zu diesem Arbeitsbereich und sieht nie mehr als du. Diese Liste gehört nur dir – andere Mitglieder sehen deine Tokens nicht und können sie nicht widerrufen.",
    create: "Neues Token",
    empty: {
      title: "Keine API-Tokens",
      description:
        "Erstelle eins, wenn etwas deine Zeit ohne Browser lesen oder schreiben soll.",
    },
    columns: {
      token: "Token",
      scopes: "Darf",
      created: "Erstellt",
      lastUsed: "Zuletzt genutzt",
      expires: "Läuft ab",
      actions: "Aktionen",
    },
    states: {
      revoked: "Widerrufen",
      expired: "Abgelaufen",
    },
    noScopes: "Nichts",
    never: "Nie",
    revoke: {
      title: "{name} widerrufen?",
      titleThisToken: "Dieses Token widerrufen?",
      description:
        "Wer das Token noch nutzt, wird ab der nächsten Anfrage abgewiesen. Nichts, was damit schon gespeichert wurde, geht verloren, und die Zeile bleibt hier stehen, damit du siehst, dass es abgeschaltet wurde.",
      action: "Widerrufen",
    },
    hint: {
      title: "Ein Token verwenden",
      body: "Sende es bei Anfragen an die REST-API als <code>{header}</code>. Bewahre es in einem Passwortmanager oder einem anderen sicheren Speicher auf – wer es hat, kann mit den oben angehakten Berechtigungen handeln.",
    },
    scopes: {
      entriesRead: {
        title: "Zeiteinträge lesen",
        description: "Einträge auflisten, einzeln lesen und den laufenden Timer sehen.",
      },
      entriesWrite: {
        title: "Zeiteinträge schreiben",
        description: "Einträge erstellen, bearbeiten und löschen sowie den Timer starten und stoppen.",
      },
      catalogRead: {
        title: "Stammdaten lesen",
        description: "Kunden, Projekte, Tätigkeiten und Schlagwörter auflisten.",
      },
      catalogWrite: {
        title: "Stammdaten schreiben",
        description: "Kunden, Projekte, Tätigkeiten und Schlagwörter erstellen, bearbeiten, archivieren und löschen.",
      },
      reportsRead: {
        title: "Berichte lesen",
        description: "Die Berichte Übersicht, Detailliert und Wöchentlich abrufen.",
      },
    },
    form: {
      title: "Neues API-Token",
      description:
        "Ein Token authentifiziert Skripte und Integrationen gegenüber der REST-API. Es gehört zu diesem Arbeitsbereich und sieht nie mehr als du.",
      namePlaceholder: "Rechnungsskript",
      nameRequired: "Der Name ist ein Pflichtfeld",
      nameHint: "Erscheint in der Liste unten. Benenne es nach dem, was es nutzen wird.",
      scopes: "Was es darf",
      noScopes:
        "<b>Dieses Token darf nichts.</b> Nichts ist angehakt, deshalb wird jede Anfrage abgewiesen. Hake mindestens eine Berechtigung an.",
      expiry: "Läuft ab (optional)",
      expiryInvalid: "Das ist kein Datum",
      expiryPast: "Wähle ein Datum in der Zukunft",
      expiryHint: "Leer lassen, dann gilt es, bis du es widerrufst.",
      submit: "Token erstellen",
    },
    reveal: {
      title: "Token erstellt",
      description: "Sende es bei jeder REST-Anfrage als <code>{header}</code>.",
      hint: "Gespeichert wird nur ein Hash davon, deshalb kann es weder hier noch in der Datenbank noch einmal angezeigt werden. Wenn du es verlierst, widerrufe dieses Token und erstelle ein neues.",
    },
    toasts: {
      created: "Token „{name}“ erstellt.",
      createFailed: "Das Token konnte nicht erstellt werden",
      revoked: "Token widerrufen.",
      revokeFailed: "Das Token konnte nicht widerrufen werden",
    },
  },
  webhooks: {
    title: "Webhooks",
    description:
      "Schicke Ereignisse sofort an deinen eigenen Endpunkt, statt die API danach abzufragen. Die Payloads sind signiert und enthalten nur, was du sehen darfst. Deine Webhooks gehören dir – niemand sonst im Arbeitsbereich sieht ihre URLs oder kann ändern, wohin sie zeigen.",
    create: "Neuer Webhook",
    empty: {
      title: "Keine Webhooks",
      description: "Füge einen Endpunkt hinzu, der benachrichtigt wird, wenn ein Timer startet oder sich ein Eintrag ändert.",
    },
    columns: {
      endpoint: "Endpunkt",
      events: "Ereignisse",
      state: "Status",
      lastDelivery: "Letzte Zustellung",
      actions: "Aktionen",
    },
    never: "Nie",
    deliveriesAction: "Zustellungen",
    toggle: {
      pause: "Diesen Webhook pausieren",
      enable: "Diesen Webhook einschalten",
    },
    health: {
      active: "Aktiv",
      paused: "Pausiert",
      failing: "Fehlerhaft",
      failingDetail:
        "{count, plural, one {# fehlgeschlagene Zustellung in Folge. Es wird weiter versucht.} other {# fehlgeschlagene Zustellungen in Folge. Es wird weiter versucht.}}",
      turnedOff: "Abgeschaltet",
      turnedOffDetail:
        "{count, plural, one {Nach # fehlgeschlagener Zustellung in Folge gestoppt. Schalte ihn wieder ein, sobald der Endpunkt wieder antwortet.} other {Nach # fehlgeschlagenen Zustellungen in Folge gestoppt. Schalte ihn wieder ein, sobald der Endpunkt wieder antwortet.}}",
    },
    deliveryStatus: {
      pending: "Ausstehend",
      delivered: "Zugestellt",
      failed: "Fehlgeschlagen",
      skippedVisibility: "Nicht gesendet",
    },
    deliveries: {
      title: "Letzte Zustellungen",
      description:
        "Die letzten Versuche, <mono>{url}</mono> zu erreichen. Jede fehlgeschlagene Zustellung wird in immer größeren Abständen erneut versucht.",
      empty: {
        title: "Noch nichts zugestellt",
        description: "Versuche erscheinen hier, sobald eines der gewählten Ereignisse eintritt.",
      },
      columns: {
        when: "Wann",
        event: "Ereignis",
        status: "Status",
        attempt: "Versuch",
        detail: "Details",
      },
      skippedDetail: "Du kannst den Eintrag, um den es ging, nicht sehen.",
      httpStatus: "HTTP {status}",
      nextTry: "Nächster Versuch {when}",
    },
    delete: {
      title: "Diesen Webhook löschen?",
      description:
        "Wir rufen <mono>{url}</mono> ab sofort nicht mehr auf, und das Zustellprotokoll wird mitgelöscht. Der Signaturschlüssel lässt sich nicht wiederherstellen – ein neuer Webhook bekommt einen neuen.",
    },
    hint: {
      title: "Eine Zustellung prüfen",
      body: "Jede Anfrage enthält <code>{timestampHeader}</code> und <code>{signatureHeader}</code>. Berechne den HMAC-SHA256 von <code>{signedPayload}</code> mit deinem Signaturschlüssel und vergleiche – was nicht übereinstimmt, kam nicht von uns.",
    },
    events: {
      entryStarted: "Ein Timer wurde gestartet",
      entryStopped: "Ein laufender Timer wurde gestoppt",
      entryCreated: "Ein Eintrag wurde hinzugefügt",
      entryUpdated: "Ein Eintrag wurde geändert",
      entryDeleted: "Ein Eintrag wurde gelöscht",
      invoiceCreated: "Eine Rechnung wurde erstellt",
      invoiceStatusChanged: "Der Status einer Rechnung hat sich geändert",
    },
    form: {
      title: "Neuer Webhook",
      description:
        "Wir senden per POST eine signierte JSON-Payload an deinen Endpunkt, sobald eines der Ereignisse unten in diesem Arbeitsbereich eintritt.",
      url: "Endpunkt-URL",
      urlRequired: "Die Endpunkt-URL ist ein Pflichtfeld",
      urlInvalid: "Gib eine vollständige URL ein, die mit https:// beginnt",
      urlScheme: "Nur http- und https-Endpunkte können aufgerufen werden",
      urlHint:
        "Muss aus dem Internet über https erreichbar sein. Adressen im eigenen Netzwerk des Servers werden abgelehnt.",
      events: "Wann aufrufen",
      eventsRequired: "Wähle mindestens ein Ereignis",
      submit: "Webhook erstellen",
    },
    reveal: {
      title: "Webhook erstellt",
      description:
        "Jede Zustellung enthält einen <code>{header}</code>-Header. Prüfe ihn mit diesem Schlüssel, bevor du der Payload vertraust.",
      label: "Signaturschlüssel",
      hint: "Der Server gibt ihn nie wieder heraus, deshalb kann er nicht noch einmal angezeigt werden. Wenn du ihn verlierst, lösche diesen Webhook und erstelle einen neuen.",
    },
    toasts: {
      created: "Webhook erstellt.",
      createFailed: "Der Webhook konnte nicht erstellt werden",
      deleted: "Webhook gelöscht.",
      deleteFailed: "Der Webhook konnte nicht gelöscht werden",
      enabled: "Webhook eingeschaltet.",
      paused: "Webhook pausiert.",
      updateFailed: "Der Webhook konnte nicht geändert werden",
    },
  },
  data: {
    roles: {
      ignored: "Nicht importieren",
      description: "Beschreibung",
      client: "Kunde",
      project: "Projekt",
      task: "Tätigkeit",
      tags: "Schlagwörter",
      billable: "Abrechenbar",
      start: "Beginn (Datum und Uhrzeit)",
      end: "Ende (Datum und Uhrzeit)",
      date: "Datum",
      startTime: "Beginn (Uhrzeit)",
      endDate: "Ende (Datum)",
      endTime: "Ende (Uhrzeit)",
      duration: "Dauer",
      rate: "Stundensatz",
    },
    import: {
      title: "Bisherige Zeiten importieren",
      description:
        "Hol dir die Zeit, die du anderswo erfasst hast. Exportiere sie im anderen Tool als CSV, zieh die Datei hierher und prüfe, was dabei entstehen würde, bevor etwas gespeichert wird. Ein Export aus Track Your Time (CSV oder JSON) funktioniert auch.",
      dropzone: "CSV- oder JSON-Export hierher ziehen",
      choose: "Datei auswählen",
      chooseDifferent: "Andere Datei auswählen",
      options: {
        skipDuplicates: {
          title: "Vorhandene Einträge überspringen",
          description: "So kannst du einen überlappenden Export erneut importieren, ohne etwas doppelt anzulegen.",
        },
        createMissing: {
          title: "Fehlende Projekte, Kunden, Tätigkeiten und Schlagwörter anlegen",
          description: "Ist die Option aus, werden Einträge nur mit Stammdaten verknüpft, die es schon gibt.",
        },
        defaultBillable: {
          title: "Nicht markierte Einträge als abrechenbar werten",
          description: "Gilt nur für Zeilen, bei denen die Datei nichts dazu sagt.",
        },
        restoreSettings: {
          title: "Arbeitsbereichseinstellungen wiederherstellen",
          description: "Währung, Stundensätze und Wochenbeginn aus der Datei ersetzen die dieses Arbeitsbereichs.",
        },
        restoreFavorites: {
          title:
            "{count, plural, one {# angehefteten Schnellstart wiederherstellen} other {# angeheftete Schnellstarts wiederherstellen}}",
          description: "Wird bei dir angeheftet, nicht bei anderen.",
        },
      },
      receipt: {
        created: "Außerdem angelegt: {items}.",
        clients: "{count, plural, one {# Kunde} other {# Kunden}}",
        projects: "{count, plural, one {# Projekt} other {# Projekte}}",
        tasks: "{count, plural, one {# Tätigkeit} other {# Tätigkeiten}}",
        tags: "{count, plural, one {# Schlagwort} other {# Schlagwörter}}",
        favorites: "{count, plural, one {# angehefteter Schnellstart} other {# angeheftete Schnellstarts}}",
        settings: "Arbeitsbereichseinstellungen",
        skipped: "{count, plural, one {# Eintrag war schon vorhanden.} other {# Einträge waren schon vorhanden.}}",
      },
      commit: "{count, plural, one {# Eintrag importieren} other {# Einträge importieren}}",
      megabytes: "{size} MB",
      toasts: {
        readFailed: "Die Datei konnte nicht gelesen werden",
        importFailed: "Die Datei konnte nicht importiert werden",
        tooLarge:
          "Die Datei ist {size} groß; die Grenze liegt bei {limit}. Exportiere sie in Zeiträumen und importiere die Teile einzeln.",
        imported:
          "{count, plural, one {# Eintrag importiert – {duration} erfasste Zeit.} other {# Einträge importiert – {duration} erfasste Zeit.}}",
      },
    },
    preview: {
      stats: {
        ready: "{count, plural, one {Eintrag zum Importieren} other {Einträge zum Importieren}}",
        duplicates: "schon vorhanden",
        unreadable: "{count, plural, one {Zeile nicht lesbar} other {Zeilen nicht lesbar}}",
        trackedTime: "erfasste Zeit",
      },
      nothingNew: "In dieser Datei ist nichts Neues.",
      range: "{from} bis {to}, gelesen in der Zeitzone {timeZone}.",
      ambiguousDates:
        "Jedes Datum in dieser Datei lässt sich auf zwei Arten lesen – <strong>03/04</strong> ist der 3. April oder der 4. März. Wähle vor dem Import, was deine Datei meint.",
      newerVersion:
        "<strong>Diese Datei stammt aus einer neueren Version von Track Your Time</strong> (Exportformat {version}). Einträge und alles, was diese Version kennt, werden wie gewohnt importiert. Daten, die diese Version nicht kennt, werden übersprungen.",
      moneyRedacted:
        "<strong>Die Geldbeträge dieser Datei wurden beim Export geleert.</strong> Einträge, Stammdaten und Zeiten werden vollständig importiert, aber jeder Satz ist leer. Die importierten Einträge werden deshalb mit den Sätzen dieses Arbeitsbereichs berechnet, nicht mit denen, zu denen sie erfasst wurden.",
      invoicesDropped:
        "{count, plural, one {# Rechnung in dieser Datei wird nicht importiert – eine ausgestellte Rechnung hält fest, was passiert ist, und sie hier neu anzulegen, würde entweder nichts oder die falschen Stunden doppelt abrechnen.} other {# Rechnungen in dieser Datei werden nicht importiert – eine ausgestellte Rechnung hält fest, was passiert ist, und sie hier neu anzulegen, würde entweder nichts oder die falschen Stunden doppelt abrechnen.}}",
      dateDuration:
        "Diese Datei enthält einen Tag und eine Dauer, aber keine Uhrzeit. Die Einträge werden ab {time} in der Reihenfolge der Datei lückenlos hintereinander gelegt. So stimmt die Summe jedes Tages, auch wenn die Uhrzeiten erfunden sind.",
      columns: {
        title: "Spalten",
        column: "Spalte",
        firstValue: "Erster Wert",
        importedAs: "Importiert als",
        unnamed: "Spalte {number}",
        roleFor: "Rolle für {column}",
      },
      dateOrder: {
        label: "Datumsangaben",
        ariaLabel: "Wie Datumsangaben geschrieben sind",
        dmy: "Tag zuerst (31/12/2026)",
        mdy: "Monat zuerst (12/31/2026)",
        ymd: "Jahr zuerst (2026-12-31)",
      },
      creates: {
        title: "Dieser Import legt außerdem an",
        clients: "Kunden: {names}",
        projects: "Projekte: {names}",
        tasks: "Tätigkeiten: {count, number}",
        tags: "Schlagwörter: {names}",
      },
      namesAndMore: "{names} und {count, plural, one {# weiterer} other {# weitere}}",
      sample: {
        title: "{count, plural, one {Erster Eintrag} other {Erste # Einträge}}",
        length: "Dauer",
        noDescription: "Keine Beschreibung",
      },
      issues: {
        title: "{count, plural, one {# Zeile muss geprüft werden} other {# Zeilen müssen geprüft werden}}",
        row: "Zeile {row}: {message}",
      },
    },
    history: {
      title: "Frühere Importe",
      description: "Jeder Import lässt sich als Ganzes rückgängig machen, egal wie lange er her ist.",
      columns: {
        file: "Datei",
        imported: "Importiert",
      },
      unnamedFile: "Unbenannte Datei",
      undone: "Rückgängig gemacht",
      undo: {
        title: "Diesen Import rückgängig machen?",
        description:
          "{count, plural, one {# Eintrag aus {filename} wird gelöscht. Zeit, die du von Hand erfasst hast, bleibt unberührt.} other {# Einträge aus {filename} werden gelöscht. Zeit, die du von Hand erfasst hast, bleibt unberührt.}}",
        descriptionUnnamed:
          "{count, plural, one {# Eintrag aus dieser Datei wird gelöscht. Zeit, die du von Hand erfasst hast, bleibt unberührt.} other {# Einträge aus dieser Datei werden gelöscht. Zeit, die du von Hand erfasst hast, bleibt unberührt.}}",
        includeCatalog: "Auch entfernen, was er angelegt hat",
        includeCatalogHint: "Projekte, Kunden, Tätigkeiten und Schlagwörter werden nur entfernt, wenn nichts anderes sie nutzt.",
        keep: "Behalten",
        confirm: "Import rückgängig machen",
      },
      toasts: {
        undone:
          "{count, plural, one {# importierter Eintrag entfernt.} other {# importierte Einträge entfernt.}}",
        undoneWithProjects:
          "{count, plural, one {# importierter Eintrag} other {# importierte Einträge}} {projects, plural, one {und # Projekt entfernt.} other {und # Projekte entfernt.}}",
        undoFailed: "Der Import konnte nicht rückgängig gemacht werden",
      },
    },
    export: {
      title: "Alles exportieren",
      description:
        "Dein ganzer Arbeitsbereich in einer Datei, die du behältst. Das JSON enthält Einträge, Kunden, Projekte, Tätigkeiten, Schlagwörter, Einstellungen des Arbeitsbereichs und deine angehefteten Schnellstarts und lässt sich wieder importieren; ausgestellte Rechnungen sind als Nachweis dabei und werden beim Import nicht neu angelegt. Das CSV enthält die Einträge in einer Form, die jede Tabellenkalkulation öffnet und dieser Import wieder einliest.",
      from: "Von",
      to: "Bis",
      count: "{count, plural, one {# Eintrag in diesem Zeitraum.} other {# Einträge in diesem Zeitraum.}}",
      emptyRangeHint: "Lass beide Datumsfelder leer, um alles zu exportieren, was je erfasst wurde.",
      tooLarge:
        "Das sind mehr als {max} Einträge – mehr, als eine Datei aufnimmt. Grenze den Zeitraum ein und exportiere in Teilen, damit kein Teil unbemerkt fehlt.",
      redacted:
        "Alle Sätze fehlen in deinem Download – der Satz jedes Eintrags ebenso wie Projektsätze, Budgets und Rechnungsbeträge, denn der Satz eines Eintrags ist eine Kopie des Projektsatzes. Deine Rolle umfasst nicht die Geldbeträge anderer Mitglieder. Zeiten, Stammdaten und alles andere sind vollständig.",
      downloadJson: "JSON-Backup herunterladen",
      downloadCsv: "CSV herunterladen",
      toasts: {
        cannotSave: "Diese App kann noch keine Dateien speichern – öffne Track Your Time im Browser, um zu exportieren.",
        failed: "Export fehlgeschlagen",
        exportedEntries: "{count, plural, one {# Eintrag exportiert.} other {# Einträge exportiert.}}",
        exportedFile: "{filename} exportiert",
      },
    },
  },
  device: {
    title: "Gerät verbinden",
    description:
      "Gib den Code ein, den Raycast, die CLI oder die wartende App anzeigt. Wenn du ihn bestätigst, wird die App mit deinem Konto angemeldet.",
    code: "Code",
    codeHint: "Bestätige nur einen Code, den du gerade vor dir siehst, auf einem Gerät, das dir gehört.",
    approve: "Bestätigen",
    decline: "Ablehnen",
    errors: {
      invalidRequest: "Dieser Code ist ungültig oder wurde schon verwendet.",
      expiredToken: "Dieser Code ist abgelaufen. Starte die Verbindung auf deinem Gerät neu.",
      accessDenied: "Dieser Code wurde bereits abgelehnt.",
      alreadyProcessed: "Dieser Code wurde schon verwendet.",
      unauthorized: "Melde dich erneut an und gib den Code dann noch einmal ein.",
      claimFailed: "Dieser Code ist ungültig oder abgelaufen.",
      approveFailed: "Der Code konnte nicht bestätigt werden.",
      denyFailed: "Der Code konnte nicht abgelehnt werden.",
      network: "Der Server ist nicht erreichbar. Prüfe deine Verbindung.",
    },
    result: {
      approvedTitle: "Gerät verbunden",
      approvedDescription:
        "Du kannst zu der App zurückgehen – sie ist angemeldet und synchronisiert. Sie steht jetzt unter Einstellungen → Geräte, wo du sie jederzeit abmelden kannst.",
      deniedTitle: "Code abgelehnt",
      deniedDescription: "Es wurde nichts verbunden. Wenn du das nicht selbst gestartet hast, musst du nichts tun.",
      openSettings: "Einstellungen öffnen",
      again: "Anderen Code eingeben",
    },
  },
  language: {
    title: "Sprache",
    description: "Wird in deinem Konto gespeichert. „System“ folgt der Sprache des jeweiligen Geräts.",
    system: "System",
    en: "English",
    de: "Deutsch",
    pseudo: "Pseudo (nur Entwicklung)",
  },
  businessProfile: {
    title: "Unternehmensprofil",
    description: "Wer deine Rechnungen ausstellt. Eine neue Rechnung übernimmt diese Angaben; bereits erstellte Rechnungen behalten die Angaben von ihrer Erstellung.",
    legalName: "Offizieller Name",
    addressLine: "Adresszeile {line}",
    postalCode: "Postleitzahl",
    city: "Ort",
    country: "Ländercode",
    countryHint: "Zwei Buchstaben, zum Beispiel DE oder AT.",
    taxId: "Steuernummer",
    email: "E-Mail",
    phone: "Telefon",
    website: "Website",
    paymentDetails: "Zahlungsinformationen",
    paymentDetailsHint: "Bankverbindung oder Zahlungslink. Die Rechnung druckt den Text so, wie du ihn schreibst.",
    paymentTermsDays: "Zahlungsziel in Tagen",
    paymentTermsHint: "Legt das vorgeschlagene Fälligkeitsdatum einer neuen Rechnung fest. Leer lassen für kein Zahlungsziel.",
    invoiceFooter: "Fußzeile der Rechnung",
    save: "Unternehmensprofil speichern",
    saved: "Unternehmensprofil gespeichert.",
    saveFailed: "Das Unternehmensprofil konnte nicht gespeichert werden.",
    forbidden: "Nur Inhaber oder Admins können das Unternehmensprofil ändern.",
    hiddenByRole: "Deine Rolle in diesem Arbeitsbereich darf das Unternehmensprofil nicht sehen. Frag einen Inhaber oder Admin.",
    loadFailed: "Das Unternehmensprofil konnte nicht geladen werden.",
    invalidTerms: "Gib eine ganze Zahl von 0 bis 365 Tagen ein.",
    invalidCountry: "Gib einen zweistelligen Ländercode ein.",
    sections: {
      taxIdentity: "Steuerliche Angaben",
      contact: "Kontakt",
      einvoiceAddress: "Adresse für E-Rechnungen",
      bank: "Bankverbindung",
      vat: "Umsatzsteuer",
    },
    vatId: "USt-IdNr.",
    vatIdHint: "Umsatzsteuer-Identifikationsnummer, zum Beispiel DE123456789.",
    taxNumber: "Steuernummer",
    taxNumberHint: "Nötig, wenn du keine USt-IdNr. hast.",
    legacyTaxId: "Bisherige Steuerangabe",
    legacyTaxIdHint: "Rechnungen drucken diesen Text, bis du eine USt-IdNr. oder eine Steuernummer einträgst. Übernimm ihn in das passende Feld.",
    useAsVatId: "Als USt-IdNr. übernehmen",
    useAsTaxNumber: "Als Steuernummer übernehmen",
    registrationNumber: "Registernummer",
    registrationNumberHint: "Handelsregistereintrag, zum Beispiel HRB 12345, Amtsgericht Berlin.",
    sellerIdentifier: "Verkäuferkennung",
    sellerIdentifierHint: "Eine E-Rechnung ohne USt-IdNr. braucht eine Registernummer oder eine Verkäuferkennung.",
    contactName: "Ansprechperson",
    contactNameHint: "XRechnung braucht eine Ansprechperson, eine Telefonnummer und eine E-Mail-Adresse.",
    electronicAddressHint: "Hierhin schicken dir Kunden E-Rechnungen. Leer lassen, um deine E-Mail-Adresse zu verwenden.",
    iban: "IBAN",
    bic: "BIC",
    bankName: "Bank",
    accountHolder: "Kontoinhaber",
    bankHint: "Steht auf der Rechnung und in der E-Rechnung. Wiederhole diese Angaben nicht in den Zahlungsinformationen.",
    smallBusiness: "Kleinunternehmer nach § 19 UStG",
    smallBusinessHint: "Deine Rechnungen weisen keine Umsatzsteuer aus.",
    smallBusinessNote: "Hinweis zur Steuerbefreiung",
    smallBusinessNoteHint: "Steht auf jeder Rechnung als Grund für die fehlende Umsatzsteuer.",
    defaultTax: "Standard-Umsatzsteuer",
    defaultTaxHint: "Vorausgewählt auf jeder neuen Rechnung. Ein Kunde kann eine eigene Standard-Steuerkategorie haben.",
    invalidFields: "Korrigiere die markierten Felder, um zu speichern.",
    smallBusinessNeedsE: "Ein Kleinunternehmer stellt ohne Umsatzsteuer aus: Wähle Steuerbefreit (E) als Standard.",
    backToInvoice: "Zurück zur Rechnung",
  },
  twoFactor: {
    title: "Zwei-Faktor-Authentifizierung",
    googleAccount:
      "Du meldest dich mit Google an. Die Zwei-Faktor-Einstellungen dafür verwaltest du bei Google.",
    on: "An. Zum Anmelden brauchst du einen Code aus deiner Authenticator-App oder einen Backup-Code.",
    off: "Aus. Verlange bei jeder Anmeldung zusätzlich einen Code aus einer Authenticator-App.",
    turnOn: "Einschalten",
    turnOff: "Ausschalten",
    invalidPassword: "Dieses Passwort ist nicht richtig.",
    invalidCode:
      "Dieser Code ist nicht gültig. Prüfe die Uhrzeit auf deinem Gerät und versuch es mit dem nächsten Code.",
    enabledToast: "Zwei-Faktor-Authentifizierung ist eingeschaltet",
    disabledToast: "Zwei-Faktor-Authentifizierung ist ausgeschaltet",
    enable: {
      title: "Zwei-Faktor-Authentifizierung einschalten",
      description:
        "Jede Anmeldung im Web fragt dann nach einem Code aus einer Authenticator-App. Bis die Mobil-App und die Browsererweiterung das unterstützen, können sie sich nicht mit diesem Konto anmelden; Geräte, die schon angemeldet sind, bleiben angemeldet.",
    },
    scan: {
      title: "QR-Code scannen",
      description:
        "Scanne ihn mit deiner Authenticator-App und gib dann den 6-stelligen Code ein, den die App anzeigt.",
      qrLabel: "QR-Code für deine Authenticator-App",
      manualKey: "Scannen klappt nicht? Gib diesen Schlüssel ein:",
      code: "Code",
      verify: "Bestätigen",
    },
    codes: {
      title: "Backup-Codes speichern",
      description:
        "Mit jedem Code kannst du dich einmal anmelden, falls du deine Authenticator-App verlierst. Bewahre die Codes sicher auf. Sie werden nicht noch einmal angezeigt.",
      copied: "Backup-Codes kopiert",
      copyFailed: "Kopieren fehlgeschlagen. Markiere die Codes stattdessen.",
      saved: "Ich habe sie gespeichert",
    },
    disable: {
      title: "Zwei-Faktor-Authentifizierung ausschalten?",
      description: "Zum Anmelden brauchst du dann nur noch dein Passwort. Deine Backup-Codes funktionieren nicht mehr.",
    },
  },
  password: {
    title: "Passwort",
    googleAccount: "Du meldest dich mit Google an, deshalb hat dein Konto kein Passwort, das du ändern könntest.",
    description: "Ändere das Passwort, mit dem du dich anmeldest.",
    change: "Passwort ändern",
    minLength: "Verwende mindestens {min, number} Zeichen.",
    current: "Aktuelles Passwort",
    new: "Neues Passwort",
    confirm: "Neues Passwort bestätigen",
    revokeOthers: "Alle anderen Geräte abmelden, auch die Mobil-App, die Browsererweiterung und Raycast",
    problems: {
      currentMissing: "Gib dein aktuelles Passwort ein.",
      tooShort: "Das neue Passwort braucht mindestens {min, number} Zeichen.",
      mismatch: "Die neuen Passwörter stimmen nicht überein.",
      unchanged: "Das neue Passwort ist dasselbe wie das aktuelle.",
      wrongCurrent: "Das aktuelle Passwort ist nicht richtig. Es wurde nichts geändert.",
      tooLong: "Das neue Passwort ist zu lang.",
      failed: "Dein Passwort konnte nicht geändert werden. Versuch es noch einmal.",
    },
    toasts: {
      othersStillSignedIn: "Passwort geändert, aber andere Geräte sind noch angemeldet",
      othersStillSignedInHint: "Melde sie unter Einstellungen → Geräte ab.",
      changedOthersSignedOut: "Passwort geändert. Andere Geräte sind abgemeldet.",
      changed: "Passwort geändert",
    },
  },
  email: {
    title: "E-Mail-Adresse",
    description: "Hierhin gehen Anmeldelinks und E-Mails zu deinem Konto.",
    change: "E-Mail ändern",
    dialogTitle: "E-Mail-Adresse ändern",
    current:
      "Aktuell {email}. Die neue Adresse bekommt einen Link, und die Änderung gilt, sobald du ihn öffnest.",
    newAddress: "Neue E-Mail-Adresse",
    sendLink: "Link senden",
    sentTitle: "Neue Adresse bestätigen",
    sent: "Wir haben einen Link an {email} geschickt. Deine E-Mail-Adresse ändert sich, sobald du ihn öffnest.",
    sentToLog:
      "Dieser Server verschickt keine E-Mails, deshalb steht der Bestätigungslink für {email} im Server-Log. Deine E-Mail-Adresse ändert sich, sobald der Link geöffnet wird.",
    invalid: "Gib eine gültige E-Mail-Adresse ein.",
    same: "Das ist bereits deine E-Mail-Adresse.",
    failed: "Deine E-Mail-Adresse konnte nicht geändert werden. Versuch es noch einmal.",
  },
  moveServer: {
    title: "Auf einen anderen Server umziehen",
    description:
      "Kopiere diesen Arbeitsbereich von {here} auf einen anderen Track-Your-Time-Server – deinen eigenen oder {cloud}. Einträge, Kunden, Projekte, Tätigkeiten, Schlagwörter, die Arbeitsbereichseinstellungen und deine angehefteten Schnellstarts kommen mit; hier wird nichts geändert oder gelöscht.",
    open: "Meine Daten umziehen …",
    from: "Von {here}.",
    fromTo: "Von {here} nach {there}.",
    targetLabel: "Umziehen nach",
    ownServer: "Mein eigener Server",
    address: "Serveradresse",
    check: "Server prüfen",
    sameServer: "Das ist {here}, der Server, auf dem dieser Arbeitsbereich schon liegt.",
    untrustedApp:
      "{host} akzeptiert noch keine Anmeldungen aus dieser App. Wer den Server betreibt, muss TRUST_STORE_APPS=true setzen oder {origins} zu TRUSTED_ORIGINS hinzufügen.",
    signInHint:
      "Melde dich mit deinem Konto auf {server} an. Die Daten werden in den Arbeitsbereich dieses Kontos kopiert.",
    signUpHint: "Erstelle ein Konto auf {server}, in das die Daten kopiert werden.",
    toSignUp: "Dort noch kein Konto? Konto erstellen",
    toSignIn: "Dort schon ein Konto? Anmelden",
    createAccount: "Konto erstellen",
    signInFailed: "Die Anmeldung bei {host} ist fehlgeschlagen.",
    counting: "Die zu kopierenden Einträge werden gezählt …",
    willCopy:
      "{count, plural, one {# abgeschlossener Eintrag wird von {here} kopiert.} other {# abgeschlossene Einträge werden von {here} kopiert.}}",
    targetHasEntries:
      "{count, plural, one {Der Arbeitsbereich auf {server} hat schon # Eintrag. Einträge, die schon dort sind, werden übersprungen, und die Arbeitsbereichseinstellungen bleiben, wie sie sind.} other {Der Arbeitsbereich auf {server} hat schon # Einträge. Einträge, die schon dort sind, werden übersprungen, und die Arbeitsbereichseinstellungen bleiben, wie sie sind.}}",
    settingsComeAlong:
      "Die Arbeitsbereichseinstellungen – Währung, Sätze, Wochenbeginn – kommen ebenfalls mit.",
    catalogComesAlong:
      "Kunden, Projekte, Tätigkeiten und Schlagwörter kommen mit den Einträgen, die sie verwenden. Ausgestellte Rechnungen werden nicht neu erstellt.",
    running: "Ein Timer läuft. Er wird erst kopiert, wenn er gestoppt ist.",
    redacted:
      "Deine Rolle umfasst nicht die Beträge anderer Mitglieder, deshalb werden keine Sätze mitkopiert.",
    copyTo: "Nach {server} kopieren",
    stopped: "Der Umzug wurde abgebrochen.",
    preparing: "Wird vorbereitet …",
    exporting: "Wird von {here} exportiert (Teil {done, number} von {total, number}) …",
    importing: "Wird auf {server} importiert (Teil {done, number} von {total, number}) …",
    fileUntrusted:
      "{server} akzeptiert keine Anfragen von der Adresse dieser Seite ({origin}), deshalb gehen die Daten als Datei hinüber.",
    fileBlocked:
      "Dein Browser konnte sich von dieser Seite aus nicht bei {server} anmelden, deshalb gehen die Daten als Datei hinüber.",
    download: "Umzugsdatei herunterladen",
    savedFiles:
      "{count, plural, one {# Datei gespeichert.} other {# Dateien gespeichert – importiere alle.}}",
    openTarget: "Öffne <target></target> und melde dich an oder erstelle ein Konto.",
    importStep:
      "Wähle unter Einstellungen → Daten → Bisherige Zeiten importieren die Datei aus und importiere sie. Die Vorschau zeigt die Einträge, bevor etwas geschrieben wird.",
    trustHint: "Um nächstes Mal direkt zu kopieren, füge {origin} zu TRUSTED_ORIGINS dieses Servers hinzu.",
    cannotSaveFiles:
      "Diese App kann keine Dateien speichern. Öffne Track Your Time im Browser, um mit einer Datei umzuziehen.",
    exportFailed: "Dieser Arbeitsbereich konnte nicht exportiert werden.",
    tooLargeDay:
      "Die Einträge vom {day} sind für einen Import zu groß. Exportiere diesen Tag separat.",
    nothingToMove: "In diesem Arbeitsbereich gibt es keine abgeschlossenen Einträge zum Umziehen.",
    found: "{version} unter {host} gefunden.",
    done: {
      complete:
        "{count, plural, one {Der Eintrag ist jetzt auf {server}.} other {Alle # Einträge sind jetzt auf {server}.}}",
      completeWithTime:
        "{count, plural, one {Der Eintrag ist jetzt auf {server} – {time} erfasste Zeit kopiert.} other {Alle # Einträge sind jetzt auf {server} – {time} erfasste Zeit kopiert.}}",
      incomplete:
        "{missing, plural, one {# Eintrag} other {# Einträge}} von {total, number} {missing, plural, one {ist} other {sind}} nicht angekommen. Starte den Umzug noch einmal – Einträge, die schon dort sind, werden übersprungen.",
      entries: "Kopierte Einträge",
      skipped: "Schon vorhandene Einträge",
      clients: "Kunden",
      projects: "Projekte",
      tasks: "Tätigkeiten",
      tags: "Schlagwörter",
      favorites: "Angeheftete Schnellstarts",
      settings: "Arbeitsbereichseinstellungen",
      restored: "Wiederhergestellt",
      leftAsTheyWere: "Unverändert",
      nothingChanged:
        "Auf {here} wurde nichts geändert. Lösche die Daten dort, sobald du sie auf {there} geprüft hast.",
      stay: "Auf {here} bleiben",
      switch: "Dieses Gerät auf {there} umstellen",
      openTarget: "{host} öffnen",
    },
  },
  desktop: {
    app: {
      title: "Desktop-App",
      description: "Wie sich die App auf diesem Computer verhält. Diese Einstellungen gelten nur für diesen Computer.",
    },
    openAtLogin: {
      title: "Beim Anmelden öffnen",
      description: "Track Your Time startet, wenn du dich an diesem Computer anmeldest.",
      requiresApproval: "macOS braucht deine Bestätigung. Erlaube Track Your Time unter Systemeinstellungen → Allgemein → Anmeldeobjekte.",
      unsupported: "Auf diesem System kann sich die App nicht selbst beim Anmelden öffnen.",
    },
    tray: {
      titleMac: "Timer in der Menüleiste zeigen",
      titleOther: "Timer im Infobereich zeigen",
      description: "Die laufende Zeit und ein Menü zum Stoppen, Fortsetzen oder Starten eines Timers.",
    },
    closeHides: {
      title: "Beim Schließen des Fensters weiterlaufen",
      description: "Der Schließen-Knopf blendet das Fenster aus, und der Timer synchronisiert weiter. Beenden kannst du über das Menü im Infobereich.",
      needsTray: "Dafür muss der Timer im Infobereich angezeigt werden.",
    },
    runningBadge: {
      titleMac: "Kennzeichen im Dock, solange ein Timer läuft",
      titleWindows: "Kennzeichen in der Taskleiste, solange ein Timer läuft",
      description: "Ein roter Punkt auf dem App-Symbol, solange ein Timer läuft.",
    },
    shortcuts: {
      title: "Tastenkürzel",
      description: "Sie funktionieren in jeder App, auch wenn das Fenster geschlossen ist.",
      actions: {
        "toggle-timer": {
          title: "Timer starten oder stoppen",
          description: "Stoppt den laufenden Timer. Läuft keiner, wird der neueste Eintrag der letzten 7 Tage fortgesetzt oder ein neuer geöffnet.",
        },
        "new-timer": {
          title: "Neuer Timer",
          description: "Öffnet die App mit dem Beschreibungsfeld, bereit zum Tippen.",
        },
        "toggle-window": {
          title: "Fenster zeigen oder ausblenden",
          description: "Holt die App nach vorne oder blendet sie aus, wenn sie schon vorne ist.",
        },
        "open-palette": {
          title: "Befehlspalette",
          description: "Öffnet die App mit der Befehlspalette.",
        },
      },
      notSet: "Nicht festgelegt",
      change: "Ändern",
      set: "Festlegen",
      recording: "Drücke das Tastenkürzel …",
      recordingHint: "Halte {modifiers} gedrückt und drücke eine Taste. Esc bricht ab.",
      modifiersMac: "⌘, ⌃ oder ⌥",
      modifiersOther: "{ctrl}, {alt} oder {super}",
      cancel: "Abbrechen",
      clear: "Entfernen",
      reset: "Auf {shortcut} zurücksetzen",
      problems: {
        taken: "Eine andere App oder das System nutzt {shortcut} schon. Wähle ein anderes Tastenkürzel.",
        invalid: "{shortcut} geht nicht. Halte mindestens eine Sondertaste gedrückt und drücke einen Buchstaben, eine Ziffer oder eine Funktionstaste.",
        duplicate: "{shortcut} ist schon für „{action}“ festgelegt.",
      },
      optionWarning: "Auf dem Mac tippt ⌥ mit einer Taste ein Sonderzeichen. Solange dieses Tastenkürzel gilt, kannst du dieses Zeichen nicht tippen.",
      keys: {
        ctrl: "Strg",
        alt: "Alt",
        shift: "Umschalt",
        win: "Win",
        super: "Super",
        space: "Leertaste",
        enter: "Eingabe",
        escape: "Esc",
        backspace: "Rücktaste",
        delete: "Entf",
      },
    },
    /** Stage 8: Aktivitätserfassung für /app/activity. Geräte-Einstellungen, gespeichert vom Hauptprozess. */
    activity: {
      title: "Aktivitätserfassung",
      description:
        "Zeichnet auf, welche App im Vordergrund ist, nur auf diesem Computer, und schlägt Einträge für Zeit vor, die du nicht erfasst hast. Nichts wird gesendet, bis du einen Eintrag hinzufügst.",
      enabled: {
        title: "Aufzeichnen, welche App im Vordergrund ist",
        description: "Aus, bis du es einschaltest. Es ist keine Systemberechtigung nötig: Die App liest nur, welche App im Vordergrund ist.",
      },
      status: {
        off: "Aus.",
        recording: "Aktivität wird erfasst.",
        idle: "Pausiert: seit einer Weile keine Eingabe.",
        locked: "Pausiert, solange der Bildschirm gesperrt ist.",
        noScope: "Beginnt, sobald dein Konto und dein Arbeitsbereich geladen sind.",
      },
      unavailable: {
        store: "In Installationen aus einem App-Store gibt es keine Aktivitätserfassung. Nutze den direkten Download von der Download-Seite.",
        "linux-sandbox": "Snap- und Flatpak-Installationen können andere Apps nicht sehen. Nutze das AppImage, das deb- oder das rpm-Paket von der Download-Seite.",
        wayland: "Wayland teilt Apps nicht mit, welches Fenster im Vordergrund ist. Die Aktivitätserfassung funktioniert in einer X11-Sitzung.",
        "unsupported-platform": "Auf diesem System funktioniert die Aktivitätserfassung nicht.",
        "tool-missing": "Die Aktivitätserfassung braucht xprop. Installiere das Paket {package} und schalte die Erfassung dann aus und wieder ein.",
        "blocked-by-policy": "Eine Windows-Richtlinie auf diesem Computer blockiert das PowerShell-Hilfsprogramm, das die App im Vordergrund liest. Frag die Person, die diesen Computer verwaltet.",
        "source-failed": "Das Hilfsprogramm, das die App im Vordergrund liest, antwortet nicht mehr. Track Your Time versucht es alle 5 Minuten noch einmal.",
        "newer-format": "Eine neuere Version von Track Your Time hat die Aktivität auf diesem Computer gespeichert. Die Erfassung bleibt aus, bis du aktualisierst. Nichts wurde gelöscht.",
      },
      titles: {
        title: "Fenstertitel mit aufzeichnen",
        description: "Fenstertitel verraten mehr über dich als App-Namen. Wenn du das ausschaltest, werden die gespeicherten Titel gelöscht.",
        notOnMac: "Unter macOS werden Fenstertitel noch nicht aufgezeichnet.",
        notHere: "Auf diesem System werden Fenstertitel nicht aufgezeichnet.",
      },
      exclude: {
        title: "Nie aufzeichnen",
        description:
          "Apps auf dieser Liste werden nie gespeichert. Wenn du eine hinzufügst, wird gelöscht, was für sie schon aufgezeichnet ist. Mit com.example.* erfasst du eine ganze Gruppe von Apps.",
        recent: "Zuletzt genutzte Apps",
        add: "Hinzufügen",
        addApp: "{app} nie aufzeichnen",
        remove: "{app} wieder aufzeichnen",
      },
      retention: {
        title: "Aktivität aufbewahren für",
        description: "Ältere Aktivität wird täglich gelöscht. Regeln bleiben erhalten.",
        suffix: "Tage",
        label: "Aufbewahrung der Aktivität in Tagen",
      },
      wipe: {
        title: "Alle Aktivität löschen",
        description:
          "{count, plural, =0 {Für dieses Konto ist keine Aktivität gespeichert.} one {# gespeicherter Abschnitt Aktivität.} other {# gespeicherte Abschnitte Aktivität.}} Beim Löschen werden auch deine Regeln und ausgeblendeten Vorschläge entfernt.",
        button: "Alle Aktivität jetzt löschen",
        confirmTitle: "Alle aufgezeichnete Aktivität löschen?",
        confirmHint:
          "Das entfernt aufgezeichnete Aktivität, Regeln und ausgeblendete Vorschläge von diesem Computer. Einträge, die du schon hinzugefügt hast, bleiben unverändert. Das lässt sich nicht rückgängig machen.",
        done: "Alle aufgezeichnete Aktivität wurde von diesem Computer gelöscht.",
      },
      failed: "Die Änderung konnte nicht gespeichert werden. Versuch es noch einmal.",
    },
    updates: {
      title: "Updates",
      version: "Version {version}",
      check: "Nach Updates suchen",
      restart: "Neu starten und aktualisieren",
      status: {
        idle: "Track Your Time sucht beim Start und alle 6 Stunden nach Updates.",
        upToDate: "Du hast die neueste Version. Zuletzt gesucht: {when}.",
        checking: "Suche nach Updates …",
        downloading: "Version {version} wird geladen …",
        downloadingPercent: "Version {version} wird geladen ({percent}) …",
        ready: "Version {version} ist bereit. Sie wird installiert, wenn du Track Your Time beendest oder jetzt neu startest.",
        error: "Die Suche nach Updates ist fehlgeschlagen. Track Your Time versucht es in ein paar Stunden noch einmal.",
      },
      disabled: {
        store: "Updates für diese Installation kommen aus dem Store, über den du sie installiert hast.",
        sandbox: "Updates für diese Installation kommen aus dem Snap Store oder von Flathub, je nachdem, woher sie stammt.",
        "package-manager": "Diese Installation aktualisiert sich nicht selbst. Installiere das neue Paket von der Download-Seite, oder nutze das AppImage, das sich selbst aktualisiert.",
        "no-feed": "Dieser Build aktualisiert sich nicht selbst. Neue Versionen gibt es auf der Download-Seite.",
        unpackaged: "Ein Entwicklungs-Build aktualisiert sich nicht selbst.",
        "turned-off": "Updates sind auf diesem Computer ausgeschaltet.",
      },
    },
  },
};
