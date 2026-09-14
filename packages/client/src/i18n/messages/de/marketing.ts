import type { Translation } from "@starter/shared";

import type { marketing as source } from "../en/marketing";

/**
 * German `marketing`. Terms follow i18n/GLOSSARY.de.md; voice is „du“.
 *
 * Written for a German reader rather than mirrored sentence by sentence, but
 * every claim is the English page's claim — nothing added, nothing dropped.
 * The settings paths („Einstellungen → Geräte“) must match the German labels
 * in de/settings.ts. „Start / Stop Timer“ and „Timer“ are Raycast command
 * names and stay English. Units after a number take a literal no-break space (U+00A0).
 */
export const marketing: Translation<typeof source> = {
  languageSwitch: {
    toEn: "English",
    toDe: "Deutsch",
    label: "Sprache",
  },

  meta: {
    ogImageAlt: "Track Your Time – Open-Source-Zeiterfassung auf deinem eigenen Server",
  },

  shell: {
    nav: {
      chrome: "Chrome",
      raycast: "Raycast",
      mobile: "iPhone & Android",
    },
    logIn: "Anmelden",
    createAccount: "Konto erstellen",
    footer: {
      tagline: "Open-Source-Zeiterfassung auf deinem eigenen Server.",
      chromeExtension: "Chrome-Erweiterung",
      raycastExtension: "Raycast-Erweiterung",
      mobile: "iPhone und Android",
      sourceCode: "Quellcode",
      apiSpec: "API-Spezifikation",
      privacy: "Datenschutzerklärung",
      support: "Support",
    },
  },

  stores: {
    chrome: { pending: "Noch nicht im Chrome Web Store", label: "Zu Chrome hinzufügen" },
    raycast: { pending: "Noch nicht im Raycast Store", label: "Im Raycast Store installieren" },
    appStore: { pending: "Noch nicht im App Store", label: "Laden im App Store" },
    googlePlay: { pending: "Noch nicht bei Google Play", label: "Jetzt bei Google Play" },
  },

  landing: {
    meta: {
      title: "Track Your Time – Open-Source-Zeiterfassung auf deinem eigenen Server",
      description:
        "Deine Stunden, Kunden und Rechnungen liegen auf einem Server, den du kontrollierst. Open Source, mit Timer für Browser, Mac und Handy.",
    },
    hero: {
      eyebrow: "Open-Source-Zeiterfassung",
      title: "Zeiterfassung auf deinem eigenen Server",
      hostYourself: "Selbst hosten",
      useHosted: "Gehostete Version nutzen",
      shotAlt: "Der Timer von Track Your Time läuft, darunter die abrechenbaren Einträge von heute",
      body: "Track Your Time speichert deine Stunden, Kunden und Rechnungen auf einem Server, den du kontrollierst. Den Timer hast du trotzdem überall dabei: im Browser, in der Menüleiste deines Macs und auf dem Handy. Starten dauert eine Sekunde, auch ohne Verbindung.",
      beta: "Kostenlos und Open Source. Die gehostete Version ist während der Beta kostenlos.",
    },
    ownership: {
      title: "Deine Zeitdaten gehören dir",
      why: "Eine Zeiterfassung weiß, wer deine Kunden sind, was du ihnen berechnest und wie du jeden Arbeitstag verbringst. Das gehört auf einen Server, den du kontrollierst, und nicht in die Datenbank von jemand anderem.",
      install:
        "Eine einzige Compose-Datei startet alles auf einem Server, HTTPS inklusive. Die <guide>Anleitung zum Selbsthosten</guide> führt Schritt für Schritt durch Installation, Backups, Updates und E-Mail. Und exportieren kannst du alles jederzeit, als JSON oder CSV.",
      memory:
        "Ein offizielles Release gibt es noch nicht. Der erste Start baut deshalb aus dem Quellcode und braucht einen Server mit 4 GB Arbeitsspeicher. Sobald fertige Images veröffentlicht sind, reichen 1–2 GB.",
    },
    timer: {
      title: "Ein Timer, den du wirklich benutzt",
      shotAlt: "Die Chrome-Erweiterung von Track Your Time mit laufendem Timer",
      forgotten:
        "Stunden, die du nicht erfasst, rechnest du auch nicht ab. Eine Zeiterfassung, die nur in einem Browsertab steckt, gerät schnell in Vergessenheit. Deshalb ist Track Your Time da, wo du ohnehin bist: ein Klick in Chrome, ein Tastenkürzel auf dem Mac, ein Tippen auf dem Handy.",
      offline:
        "Verbindung weg? Erfass einfach weiter. Sobald du wieder online bist, wird alles synchronisiert. Und ein Timer, den du auf einem Gerät stoppst, ist auf allen gestoppt.",
    },
    invoice: {
      title: "Von den Stunden zur Rechnung",
      shotAlt: "Eine Rechnung für einen Kunden, mit einem Monat abrechenbarer Stunden in Positionen zusammengefasst",
      rates:
        "Gib jedem Projekt einen Stundensatz. Wenn abgerechnet wird, wählst du einen Kunden und einen Monat. Track Your Time macht aus den noch nicht abgerechneten Stunden eine Rechnung, die du als PDF herunterlädst.",
      once: "Keine Stunde landet zweimal auf einer Rechnung. Und wenn du deinen Stundensatz erhöhst, behalten die schon geleisteten Stunden den Satz, den du vereinbart hattest.",
    },
    reports: {
      title: "Sieh, wo die Zeit geblieben ist",
      shotAlt: "Ein Bericht über vier Wochen Arbeit, nach Tätigkeit aufgeteilt, mit Stunden und Umsatz",
      hours:
        "Berichte zeigen, wie viele Stunden jeder Kunde und jedes Projekt gebraucht hat und was diese Stunden eingebracht haben. So merkst du vor deinem Kunden, dass ein Projekt über die Schätzung hinausläuft.",
      export: "Wenn die Steuerberatung fragt, exportierst du jeden Bericht als CSV oder PDF.",
    },
    surfaces: {
      title: "Da, wo du arbeitest",
      web: { name: "Web-App", text: "Timer, Stundenzettel, Kalender, Berichte und Rechnungen." },
      chrome: { name: "Chrome", text: "Ein Timer in der Symbolleiste. Ein Klick startet oder stoppt ihn." },
      raycast: { name: "Raycast", text: "Eine Uhr in der Menüleiste und ein Tastenkürzel zum Starten und Stoppen auf dem Mac." },
      mobile: { name: "iPhone und Android", text: "Zeit erfassen, wenn du unterwegs bist, auch ohne Empfang." },
    },
    free: {
      title: "Kostenlos, ohne Einschränkungen",
      license:
        "Track Your Time steht unter der AGPL-3.0. Jede Installation hat jede Funktion. Es gibt keine kostenpflichtigen Plugins und keine Premium-Stufe.",
      builtBy: "Entwickelt wird es von einer Person, Rico Trebeljahr, öffentlich auf <repo>GitHub</repo>.",
      donate: "Wenn es dir ein Abo erspart, <donate>kannst du die Entwicklung unterstützen</donate>.",
    },
    audience: {
      title: "Für wen es gedacht ist",
      body: "Für Freelancer, Berater und kleine Studios, die nach Stunden abrechnen und ihre Daten selbst in der Hand haben wollen. Es gibt keine Überwachung per Screenshot oder Tastenanschlag, und niemand muss deinen Stundenzettel freigeben. Lade Kolleginnen und Kollegen per E-Mail ein. Jede Person sieht nur ihre eigene Zeit, bis du ihr die Zeit oder die Beträge der anderen freigibst. Stundensätze legst du pro Projekt fest, also rechnen alle in einem Projekt zum selben Satz ab.",
    },
    faq: {
      title: "Fragen",
      hosting: {
        q: "Muss ich es selbst hosten?",
        a: "Nein. Die gehostete Version auf trackyourtime.dev steht allen offen und ist während der Beta kostenlos. Später kannst du auf deinen eigenen Server umziehen: Daten exportieren und dort importieren.",
      },
      requirements: {
        q: "Was brauche ich, um es zu betreiben?",
        a: "Einen Linux-Server mit Docker, eine Domain und 4 GB Arbeitsspeicher für den ersten Build. Die <guide>Anleitung</guide> nennt jeden Befehl.",
      },
      import: {
        q: "Kann ich meine Zeiten aus einer anderen Zeiterfassung mitnehmen?",
        a: "Ja. Exportiere eine CSV-Datei aus deinem alten Tool und importiere sie. Bevor etwas gespeichert wird, siehst du eine Vorschau, und du kannst den Import rückgängig machen.",
      },
      api: {
        q: "Gibt es eine API?",
        a: "Ja. Jede Installation bringt eine REST-API und signierte Webhooks mit. Am besten fängst du mit der <reference>API-Referenz</reference> an.",
      },
      shutdown: {
        q: "Was passiert, wenn das Projekt eingestellt wird?",
        a: "Dein Server läuft mit deiner Version weiter, und der Code bleibt Open Source. Nichts hängt an einem Dienst, der abgeschaltet werden könnte.",
      },
    },
    cta: {
      title: "Auf deinem Server oder auf unserem",
      guide: "Anleitung zum Selbsthosten lesen",
      account: "Kostenloses Konto erstellen",
    },
  },

  privacy: {
    meta: {
      title: "Datenschutzerklärung",
      description:
        "Was der gehostete Dienst Track Your Time speichert, warum, wer es sonst sieht und wie du deine Daten zurückbekommst oder löschen lässt.",
    },
    hero: {
      lastUpdated: "Zuletzt aktualisiert am {date}",
      title: "Datenschutzerklärung",
      scope:
        "Diese Erklärung gilt für den gehosteten Dienst Track Your Time unter trackyourtime.dev und api.trackyourtime.dev, und für die Apps und Erweiterungen von Track Your Time, wenn sie sich mit diesem Dienst verbinden. Wenn du einen eigenen Track-Your-Time-Server betreibst, gehen deine Daten an deinen Server, und für ihn gilt diese Erklärung nicht.",
      contact: "Track Your Time wird von Rico Trebeljahr betrieben. Schreib an <mail>{email}</mail>, wenn du Fragen zu deinen Daten hast.",
    },
    summary: {
      title: "Kurz gesagt",
      stores: "Track Your Time speichert dein Konto und die Zeit, die du erfasst, damit es sie dir wieder anzeigen kann.",
      noAnalytics: "Es gibt keine Analyse-Tools, keine Werbung und keinen Verkauf von Daten.",
      noTracking: "Der Dienst verfolgt nicht, was du in anderen Apps oder auf anderen Websites tust.",
      control: "Du kannst jederzeit alle deine Daten exportieren und verlangen, dass alles gelöscht wird.",
    },
    stored: {
      title: "Was der Dienst speichert",
      account:
        "<strong>Dein Konto.</strong> Dein Name, deine E-Mail-Adresse und ein Hash deines Passworts. Das Passwort selbst speichert der Server nie.",
      tracked:
        "<strong>Was du erfasst.</strong> Zeiteinträge und ihre Beschreibungen, Kunden, Projekte, Tätigkeiten, Schlagwörter, Favoriten, Stundensätze, Budgets, Rechnungen und importierte Dateien. All das gibst du selbst ein.",
      settings:
        "<strong>Deine Einstellungen.</strong> Währung, Wochenbeginn, Zeitformat, Umgang mit Inaktivität und ähnliche Einstellungen.",
      sessions:
        "<strong>Deine Sitzungen.</strong> Für jedes Gerät, auf dem du dich anmeldest: die IP-Adresse und die Browser- oder App-Kennung, mit der die Anmeldung erfolgt ist, und der Name der Track-Your-Time-App. Genau das zeigt dir Einstellungen → Geräte, damit du ein Gerät wiedererkennst und abmelden kannst.",
      tokens:
        "<strong>API-Tokens und Webhooks</strong>, wenn du welche anlegst: ein Hash jedes Tokens, seine Berechtigungen und die Adressen, an die deine Webhooks senden, mit einem Protokoll jeder Zustellung.",
      logs: "<strong>Anfrageprotokolle.</strong> Der Server protokolliert jede Anfrage mit IP-Adresse, Zeitpunkt, angefragter Adresse und Browser-Kennung. Die Protokolle dienen dazu, Fehler zu finden und zu beheben, und zu nichts anderem.",
    },
    purpose: {
      title: "Warum der Dienst das speichert",
      contract:
        "Der Dienst braucht dein Konto und deine erfasste Zeit, um das zu tun, wofür du dich registriert hast. Das ist die Rechtsgrundlage für die Speicherung: Ohne diese Daten funktioniert der Dienst, den du nutzen willst, nicht.",
      interest:
        "Sitzungsdaten und Anfrageprotokolle halten den Dienst sicher und funktionsfähig. Das ist ein berechtigtes Interesse des Dienstes und aller, die ihn nutzen.",
      newsletter:
        "Der Newsletter ist die einzige Ausnahme. Du bekommst nichts, solange du ihn nicht abonnierst und das Abonnement per E-Mail bestätigst. Jede Ausgabe enthält einen Link zum Abbestellen.",
    },
    processors: {
      title: "Wer die Daten sonst verarbeitet",
      cloudflare:
        "<strong>Cloudflare</strong> beantwortet DNS-Anfragen für trackyourtime.dev und leitet jede Anfrage an den Server weiter. Cloudflare sieht deine IP-Adresse und die Anfrage.",
      ses: "<strong>Amazon Web Services (SES)</strong> stellt E-Mails zu: Links zum Zurücksetzen des Passworts und, wenn du ihn abonnierst, den Newsletter. SES erhält deine E-Mail-Adresse und die Nachricht.",
      host: "<strong>Der Server-Anbieter</strong> vermietet den virtuellen Server, auf dem Track Your Time und seine Datenbank laufen. Deine Daten liegen auf diesem Server.",
      nobodyElse:
        "Kein anderes Unternehmen erhält deine Daten. Track Your Time nutzt keine Werbe- oder Analysedienste.",
    },
    extension: {
      title: "Die Browsererweiterung",
      storage:
        "Die Erweiterung speichert dein Sitzungstoken und noch nicht gesendete Änderungen im Erweiterungsspeicher von Chrome auf deinem Computer.",
      cookies:
        "Die Berechtigung <strong>cookies</strong> liest ein einziges Cookie: das Sitzungscookie der Web-App von Track Your Time, damit du dich nicht zweimal anmelden musst. Andere Cookies liest die Erweiterung nicht.",
      idle: "Die Berechtigung <strong>idle</strong> meldet der Erweiterung, dass der Computer inaktiv oder gesperrt ist. Die Erweiterung nutzt das nur, um zu fragen, was mit der inaktiven Zeit passieren soll. Den Inaktivitätsstatus sendet sie nirgendwohin.",
      network: "Die Erweiterung spricht nur mit api.trackyourtime.dev. Die Seiten, die du besuchst, kann sie nicht lesen.",
      limitedUse:
        "Die Nutzung von Informationen, die über Chrome-APIs empfangen werden, entspricht der Chrome Web Store User Data Policy, einschließlich der Anforderungen zur eingeschränkten Nutzung (Limited Use).",
    },
    raycast: {
      title: "Die Raycast-Erweiterung",
      body: "Die Raycast-Erweiterung speichert dein Sitzungstoken, eine Kopie der zuletzt geladenen Daten und noch nicht gesendete Änderungen im verschlüsselten lokalen Speicher von Raycast auf deinem Mac. Sie spricht nur mit dem Track-Your-Time-Server, der in ihren Einstellungen eingetragen ist.",
    },
    mobile: {
      title: "Die Apps für iPhone und Android",
      keychain: "Die Apps bewahren dein Sitzungstoken im iOS-Schlüsselbund oder im Android Keystore auf.",
      storage:
        "Noch nicht gesendete Änderungen und der laufende Timer liegen im eigenen Speicher der App auf dem Handy. So überstehen sie einen Neustart ohne Empfang.",
      permissions:
        "Die Apps lesen den Netzwerkstatus des Handys, um zu wissen, ob sie online sind. Standort, Kontakte, Kamera, Mikrofon und Fotos nutzen sie nicht.",
      noTracking: "Die Apps enthalten keinen Code für Werbung, Analyse oder Tracking.",
    },
    retention: {
      title: "Wie lange die Daten gespeichert bleiben",
      body: "Dein Konto und deine erfasste Zeit bleiben gespeichert, bis du sie löschst oder ihre Löschung verlangst. Eine Browser-Sitzung endet 7 Tage nach ihrer letzten Nutzung. Eine Sitzung in einer App oder Erweiterung endet 30 Tage nach ihrer letzten Nutzung. Beide enden sofort, wenn du das Gerät abmeldest.",
    },
    rights: {
      title: "Deine Rechte",
      copy: "<strong>Kopie erhalten.</strong> Einstellungen → Daten exportiert jederzeit alles als JSON oder CSV, ohne dass du jemanden fragen musst.",
      correct: "<strong>Berichtigen.</strong> Jeden Eintrag und jede Einstellung kannst du selbst bearbeiten.",
      delete:
        "<strong>Löschen.</strong> Öffne Einstellungen → Konto → Konto löschen, in der Web-App oder in den Mobil-Apps, und bestätige mit deinem Passwort. Das Konto, jede Sitzung und alles in deinem Arbeitsbereich werden sofort gelöscht. Jedes angemeldete Gerät wird abgemeldet.",
      noSignIn:
        "Wenn du dich nicht anmelden kannst, schreib von der E-Mail-Adresse deines Kontos an <mail>{email}</mail>. Das Konto wird dann innerhalb von 30 Tagen gelöscht, und du bekommst eine Bestätigung.",
      eu: "Wenn du in der EU oder im Vereinigten Königreich lebst, hast du außerdem das Recht auf Widerspruch, auf Einschränkung der Verarbeitung und auf Beschwerde bei deiner Datenschutzaufsichtsbehörde.",
    },
    children: {
      title: "Kinder",
      body: "Track Your Time ist ein Werkzeug für die Arbeit. Es richtet sich nicht an Kinder unter 16 Jahren.",
    },
    changes: {
      title: "Änderungen an dieser Erklärung",
      body: "Wenn sich diese Erklärung ändert, ändert sich das Datum oben. Die vollständige Versionsgeschichte dieser Seite ist öffentlich im <repo>Quellcode-Repository</repo> einsehbar.",
    },
  },

  support: {
    meta: {
      title: "Support",
      description: "Hilfe zu Track Your Time und Antworten auf die häufigsten Fragen.",
    },
    hero: {
      eyebrow: "Support",
      title: "Hilfe zu Track Your Time",
      email:
        "Schreib an <mail>{email}</mail>. Sag dazu, welche App du nutzt (Web-App, Chrome, Raycast, iPhone oder Android) und was du erwartet hast. Jede E-Mail wird persönlich gelesen.",
      issues: "Einen Fehler gefunden oder eine Idee für eine Funktion? Eröffne ein Issue auf <issues>GitHub</issues>. Dann finden auch andere die Antwort.",
    },
    faq: {
      title: "Häufige Fragen",
      extensionSignIn: {
        term: "Die Chrome-Erweiterung will eine Anmeldung, dabei bin ich in der Web-App angemeldet",
        detail:
          "Öffne die Web-App auf trackyourtime.dev im selben Chrome-Profil und öffne dann das Pop-up erneut. Die Erweiterung liest nur die Sitzung dieses Profils.",
      },
      raycastConnect: {
        term: "Wie verbinde ich die Raycast-Erweiterung?",
        detail:
          "Öffne den Befehl „Timer“. Er zeigt einen Code und öffnet eine Seite im Browser. Bestätige den Code dort, während du bei Track Your Time angemeldet bist.",
      },
      waitingChanges: {
        term: "Die App meldet, dass Änderungen auf die Synchronisierung warten",
        detail:
          "Die Änderungen sind auf dem Gerät sicher und gehen der Reihe nach an den Server, sobald das Gerät online und angemeldet ist. Melde dich in der Chrome-Erweiterung nicht ab, solange dort Änderungen warten: Die Abmeldung löscht sie.",
      },
      lostDevice: {
        term: "Ich habe ein Handy oder einen Computer verloren",
        detail:
          "Öffne in der Web-App Einstellungen → Geräte und melde das Gerät ab. Seine Live-Verbindung wird innerhalb einer Minute getrennt.",
      },
      export: {
        term: "Wie bekomme ich alle meine Daten heraus?",
        detail:
          "Einstellungen → Daten exportiert alles als JSON oder CSV. Die JSON-Datei lässt sich in eine neue Track-Your-Time-Instanz einspielen.",
      },
      deleteAccount: {
        term: "Wie lösche ich mein Konto?",
        detail:
          "Öffne Einstellungen → Konto → Konto löschen und bestätige mit deinem Passwort. Wenn du deine Daten behalten willst, exportiere sie vorher. Was gelöscht wird, steht in der <privacy>Datenschutzerklärung</privacy>.",
      },
      selfHost: {
        term: "Kann ich Track Your Time auf meinem eigenen Server betreiben?",
        detail: "Ja. Die <guide>Anleitung zum Selbsthosten</guide> erklärt den ersten Start, E-Mail, Backups und Updates.",
      },
    },
  },

  extension: {
    meta: {
      title: "Chrome-Erweiterung",
      description:
        "Starte und stoppe deinen Track-Your-Time-Timer in der Chrome-Symbolleiste. Trag vergessene Zeit nach und erfasse weiter, wenn die Verbindung abbricht.",
    },
    hero: {
      eyebrow: "Track Your Time für Chrome",
      title: "Dein Timer, einen Klick entfernt",
      createAccount: "Konto erstellen",
      body: "Du verbringst den Tag im Browser, und deine Zeiterfassung sollte nicht noch ein Tab sein, den du suchen musst. Die Erweiterung von Track Your Time sitzt in der Chrome-Symbolleiste. Ein Klick startet den Timer, und das Symbol zeigt, wie lange er schon läuft.",
    },
    recent: {
      title: "Mach da weiter, wo du aufgehört hast",
      shotAlt: "Das Pop-up der Track-Your-Time-Erweiterung mit laufendem Timer",
      recents:
        "Was du zuletzt erfasst hast, steht direkt im Pop-up. Ein Klick startet dieselbe Arbeit noch einmal. Was du jeden Tag machst, heftest du an, dann bleibt es oben.",
      suggestions:
        "Tipp eine Beschreibung ein, und die Erweiterung schlägt vor, was du schon einmal benutzt hast. Wählst du einen Vorschlag, kann sie auch Kunde und Projekt vom letzten Mal übernehmen.",
    },
    fixDay: {
      title: "Bring den Tag in Ordnung, bevor du abrechnest",
      body: "Vergessen, den Timer vor einem Anruf zu starten? Trag die Zeit hinterher nach. Geh frühere Tage durch und korrigiere, was nicht stimmt, ohne die Web-App zu öffnen.",
    },
    offline: {
      title: "Erfasst weiter, auch wenn das WLAN streikt",
      body: "Bricht die Verbindung ab, arbeitest du einfach weiter. Die Erweiterung speichert deine Änderungen und sendet sie, sobald du wieder online bist. Stoppst du hier einen Timer, ist er auch in der Web-App und auf dem Handy gestoppt.",
    },
    login: {
      title: "Keine zweite Anmeldung",
      body: "Du bist in Chrome schon bei Track Your Time angemeldet? Dann nutzt die Erweiterung diese Anmeldung. Kein zusätzliches Passwort, kein API-Token zum Kopieren.",
    },
    selfHost: {
      title: "Du nutzt einen eigenen Server?",
      body: "Die Version aus dem Chrome Web Store verbindet sich mit trackyourtime.dev. Für deinen eigenen Server baust du die Erweiterung aus dem Quellcode, mit der Adresse deines Servers. Wie das geht, zeigt die <guide>Anleitung zum Selbsthosten</guide>.",
    },
    permissions: {
      title: "Worauf die Erweiterung zugreifen kann",
      login: "Deine Anmeldung bei Track Your Time, damit du dich nicht zweimal anmelden musst.",
      idle: "Ob dein Computer inaktiv ist, damit sie fragen kann, was mit der Zeit passieren soll, in der du weg warst.",
      storage: "Speicher auf deinem Computer, für Änderungen, die du offline gemacht hast.",
      server: "Dein Track-Your-Time-Server. Die Websites, die du besuchst, kann sie nicht lesen.",
    },
  },

  raycast: {
    meta: {
      title: "Raycast-Erweiterung",
      description:
        "Starte und stoppe deinen Track-Your-Time-Timer per Tastenkürzel und sieh ihn in der Menüleiste deines Macs laufen.",
    },
    hero: {
      eyebrow: "Track Your Time für Raycast",
      title: "Zeit erfassen, ohne die Tastatur loszulassen",
      createAccount: "Konto erstellen",
      body: "Wenn du deinen Mac ohnehin über Raycast steuerst, gehört deine Zeiterfassung auch dorthin. Ein Tastenkürzel startet oder stoppt den Timer, und ein Blick in die Menüleiste zeigt, was gerade läuft.",
    },
    menuBar: {
      title: "Eine Uhr, die du nicht übersiehst",
      body: "Ein Timer ist schnell vergessen, egal ob du ihn laufen gelassen oder nie gestartet hast. Track Your Time zeigt die laufende Zeit in der Menüleiste, wo du sie den ganzen Tag siehst. Läuft nichts, kann dort stattdessen die Gesamtzeit von heute stehen.",
    },
    hotkey: {
      title: "Eine Taste zum Starten und Stoppen",
      body: "Leg für den Befehl „Start / Stop Timer“ ein Tastenkürzel fest. Drückst du es, stoppt, was gerade läuft. Drückst du es noch einmal, geht es mit deiner letzten Arbeit weiter. Dabei öffnet sich kein Fenster.",
    },
    logPast: {
      title: "Trag das vergessene Meeting nach",
      body: "Öffne Raycast, drück <strong>{shortcut}</strong> und gib ein, wann das Meeting angefangen und aufgehört hat. Die Web-App musst du dafür nicht öffnen.",
    },
    offline: {
      title: "Funktioniert auch im Flugzeug",
      body: "Kein WLAN? Starte und stoppe Timer trotzdem. Raycast behält die Änderungen auf deinem Mac und sendet sie, sobald du wieder online bist.",
    },
    connect: {
      title: "In einer Minute verbunden",
      pairing:
        "Wenn du Track Your Time zum ersten Mal in Raycast öffnest, siehst du einen kurzen Code. Bestätige ihn im Browser, und du bist angemeldet. Berichte und Rechnungen bleiben in der Web-App, einen Befehl entfernt.",
      selfHost:
        "Du betreibst einen eigenen Server? Trag seine Adresse in den Einstellungen der Erweiterung ein. Neu bauen musst du nichts.",
    },
  },

  mobile: {
    meta: {
      title: "iPhone und Android",
      description:
        "Erfasse abrechenbare Zeit auf deinem iPhone oder Android-Handy, auch ohne Empfang. Alles wird mit deinem Laptop synchronisiert.",
    },
    hero: {
      eyebrow: "Track Your Time für iPhone und Android",
      title: "Zeit erfassen, wo die Arbeit passiert",
      trackShotAlt: "Der Timer von Track Your Time läuft auf einem Handy",
      reportsShotAlt: "Stunden und Umsatz dieser Woche auf einem Handy",
      menuShotAlt: "Das Menü von Track Your Time auf einem Handy, mit Stundenzettel, Kalender und Rechnungen",
      body: "Nicht jede abrechenbare Stunde entsteht am Schreibtisch. Starte einen Timer beim Kunden, bei einem Termin vor Ort oder im Zug nach Hause. Wenn du dich an die Rechnung setzt, ist die Zeit schon auf deinem Laptop.",
    },
    offline: {
      title: "Kein Empfang? Erfass einfach weiter.",
      body: "Die App funktioniert im Flugmodus und im Tunnel. Schließ sie, und der Timer läuft weiter. Sobald du wieder online bist, wird alles, was du offline gemacht hast, von selbst synchronisiert.",
    },
    wholeApp: {
      title: "Die ganze App, keine abgespeckte Version",
      body: "Stundenzettel, Kalender, Berichte und Rechnungen hast du alle auf dem Handy. Sieh dir vor einem Kundengespräch die Stunden dieses Monats an, oder korrigiere auf dem Weg zur Arbeit die Einträge von gestern.",
    },
    lost: {
      title: "Handy verloren?",
      body: "Öffne die Einstellungen in der Web-App und melde das Handy ab. Es verliert sofort den Zugriff auf dein Konto.",
    },
    selfHost: {
      title: "Du nutzt einen eigenen Server?",
      body: "Die Mobil-Apps verbinden sich vorerst mit trackyourtime.dev. Mit deinem eigenen Server öffnest du die Web-App im Browser deines Handys und legst sie auf den Startbildschirm.",
    },
  },

  newsletter: {
    subscribe: {
      metaTitle: "Abonnieren",
      metaDescription: "Abonniere den Newsletter.",
      title: "Abonnieren",
      intro:
        "Trag unten deine E-Mail-Adresse ein. Wir schicken dir einen Bestätigungslink, um die Adresse zu prüfen. Auf die Liste kommst du erst, wenn du ihn anklickst.",
    },
    form: {
      emailLabel: "E-Mail-Adresse",
      placeholder: "du@beispiel.de",
      submit: "Abonnieren",
      submitting: "Wird gesendet …",
      cadence: "Regelmäßig eine E-Mail. Jede Ausgabe enthält einen Link zum Abbestellen.",
      invalidEmail: "Das sieht nicht nach einer E-Mail-Adresse aus.",
      rateLimited: "Zu viele Anfragen. Warte bitte eine Minute.",
      sendFailed: "Die Bestätigungs-E-Mail konnte nicht gesendet werden. Versuch es noch einmal.",
      generic: "Etwas ist schiefgelaufen. Versuch es noch einmal.",
      network: "Netzwerkfehler. Versuch es noch einmal.",
      successTitle: "Schau in dein Postfach.",
      successBody:
        "Tipp auf den Bestätigungslink, dann ist es erledigt. Wenn nichts ankommt, sieh im Spam-Ordner nach.",
      alreadyTitle: "Du stehst schon auf der Liste.",
      alreadyBody: "Diese Adresse ist bereits bestätigt. Du musst nichts weiter tun.",
    },
    confirmed: {
      metaTitle: "Abonnement bestätigt",
      title: "Du bist dabei.",
      confirmed: "Abonnement bestätigt.",
      cadence: "Die nächste Ausgabe kommt wie gewohnt. Jede E-Mail enthält einen Link zum Abbestellen.",
    },
    error: {
      metaTitle: "Problem mit dem Bestätigungslink",
      title: "Hm.",
      tryAgain: "Erneut versuchen",
      reasons: {
        missing: "Im Bestätigungslink fehlt das Token. Abonniere noch einmal.",
        malformed: "Der Bestätigungslink ist beschädigt. Abonniere noch einmal.",
        badSignature: "Der Bestätigungslink ist ungültig. Abonniere noch einmal.",
        expired: "Dieser Bestätigungslink ist abgelaufen. Abonniere noch einmal, dann bekommst du einen neuen.",
        listAddFailed: "Beim Eintragen in die Liste ist bei uns etwas schiefgelaufen. Versuch es noch einmal.",
        fallback: "Wir konnten dein Abonnement nicht bestätigen. Versuch es noch einmal.",
      },
    },
    backToSite: "Zurück zur Website",
  },
};
