# German glossary and style guide

One English concept, one German word, everywhere: the web app, the browser
extension, invoices and email. A synonym "for variety" reads to a user as a
different thing. When a term is missing here, add it here first, then use it.

`common` (packages/client/src/i18n/messages/de/common.ts) already uses these
terms; it is the reference when in doubt.

## Voice

- **du**, never Sie. Track Your Time is an indie tool, and its English copy
  talks to one person directly. Capitalise du/dein only at the start of a
  sentence ("Prüfe deine Verbindung").
- Imperatives in the du form: "Melde dich an", "Wähle ein Projekt".
- Short, active sentences. No filler ("Bitte beachte, dass …").
- Error messages say what happened and what to do next, the same as English:
  "Der Server ist nicht erreichbar. Prüfe deine Verbindung und versuch es noch
  einmal."

## Terms

| English | German | Notes |
| --- | --- | --- |
| account | Konto | |
| active | aktiv | |
| amount | Betrag | |
| API token | API-Token | das Token |
| archive (verb) | archivieren | |
| archived | archiviert | |
| billable | abrechenbar | |
| non-billable | nicht abrechenbar | |
| budget | Budget | |
| calendar | Kalender | |
| client (customer) | Kunde | plural Kunden. Never "Client" — that word means software here |
| client app (Raycast, extension, phone) | App | "Browsererweiterung" for the extension |
| browser extension | Browsererweiterung | |
| currency | Währung | |
| dashboard | Übersicht | |
| date | Datum | |
| delete | löschen | |
| description | Beschreibung | |
| device | Gerät | |
| draft (invoice) | Entwurf | |
| due date | Fälligkeitsdatum | |
| duration | Dauer | |
| end (time) | Ende | |
| entry, time entry | Eintrag, Zeiteintrag | "Zeiteintrag" where the context is unclear |
| Entries (report view) | Einträge | the Reports switch; plural of "Eintrag" |
| export | exportieren / Export | |
| favorite | Favorit | |
| hourly rate | Stundensatz | |
| idle, idle detection | Inaktivität, Inaktivitätserkennung | "inaktiv" for the state |
| import | importieren / Import | |
| invoice | Rechnung | |
| invitation | Einladung | "zurückziehen" for cancel, never "stornieren" |
| issue date | Rechnungsdatum | |
| member | Mitglied | |
| offline queue | Offline-Warteschlange | |
| ownership (transfer) | Inhaberschaft (übertragen) | |
| paid | bezahlt | |
| password | Passwort | |
| project | Projekt | |
| rate | Satz | "Stundensatz" when it is per hour |
| recent (entries) | zuletzt verwendet | heading: "Zuletzt verwendet" |
| report | Bericht | |
| role | Rolle | owner = Inhaber, admin = Admin, member = Mitglied |
| running (timer) | läuft | "Timer läuft" |
| sent (invoice) | versendet | |
| session | Sitzung | |
| settings | Einstellungen | |
| sign in / sign out | anmelden / abmelden | nouns: Anmeldung, Abmeldung |
| sign up | registrieren | |
| start (time) | Beginn | the button is "Starten" |
| stop (button) | Stoppen | |
| sync, synced | Synchronisierung, synchronisiert | |
| tag | Schlagwort | plural Schlagwörter — see below |
| task | Tätigkeit | plural Tätigkeiten — see below |
| tax | Steuer | "USt." only on invoices, next to a rate |
| theme | Design | light = Hell, dark = Dunkel |
| time format | Zeitformat | |
| timer | Timer | the established German word in software; "Stoppuhr" reads as a toy |
| timesheet | Stundenzettel | |
| total | Gesamt | the invoice's final line is „Gesamtbetrag“ |
| Totals (report view) | Summen | the Reports switch; never „Übersicht“, which is dashboard |
| track (time) | erfassen | "Zeit erfassen"; the nav item /track is "Erfassen" |
| webhook | Webhook | |
| week starts on | Woche beginnt am | |
| weekly | wöchentlich | |
| workspace | Arbeitsbereich | |

### Added during extraction

| English | German | Notes |
| --- | --- | --- |
| approve / decline (device code) | bestätigen / ablehnen | not „zustimmen“: „Dem Code konnte nicht zugestimmt werden“ is not idiomatic, and the device page has no other confirm action |
| bill (verb), invoiced | abrechnen, abgerechnet | matches „abrechenbar“. An invoiced entry is „abgerechnet“, never „in einer Rechnung“; do not use „in Rechnung stellen“ |
| billing (settings tab, project column) | Abrechnung | Stripe subscription billing is „Zahlungen“ |
| breakdown (report) | Aufteilung | „Gruppieren nach“ for group by |
| bulk actions / bulk edit | Sammelaktionen / Sammelbearbeitung | |
| catalog (clients, projects, tasks and tags together) | Stammdaten | also the API scope „Stammdaten lesen“ |
| command palette | Befehlspalette | |
| Ctrl / Shift (shortcut hints) | Strg / Umschalt | ⌘ stays ⌘ |
| decimal hours, duration format | Dezimalstunden, Dauerformat | |
| delivery (webhook) | Zustellung | |
| endpoint, event, payload (webhooks) | Endpunkt, Ereignis, Payload | |
| estimate (project hours target) | Schätzung | |
| hosted version, self-host | gehostete Version, selbst hosten | guide: „Anleitung zum Selbsthosten“ |
| idle behaviours: ask / pause and resume / keep running / stop | Nachfragen / Pausieren und fortsetzen / Weiterlaufen lassen / Timer stoppen | away (state) = „abwesend“ |
| invoice language | Rechnungssprache | |
| invoice line, subtotal, tax rate | Position, Zwischensumme, Steuersatz | |
| limits (settings tab) | Limits | |
| Manage (nav section) | Verwalten | |
| maximum entry length (runaway limit) | maximale Eintragsdauer | not „Höchstdauer“ or „Obergrenze“ — the setting's own label, repeated wherever the limit is named |
| menu bar, toolbar, shortcut | Menüleiste, Symbolleiste, Tastenkürzel | |
| phone (the device) / mobile app (the product) | Handy / Mobil-App | |
| pin / unpin (quick starts) | anheften / nicht mehr anheften | not „lösen“, which also reads as *solve*; unpin is a tooltip and aria label, so its length costs nothing |
| privacy policy | Datenschutzerklärung | |
| queued (offline badge), unsynced | ausstehend, nicht synchronisiert | |
| quick start | Schnellstart | |
| revoke (token, device access) | widerrufen | signing a device out is „abmelden“ |
| runaway timer; cap / stop (runaway behaviours) | vergessener Timer; Kürzen (gekürzt) / Stoppen | |
| signing secret | Signaturschlüssel | |
| subscribe / unsubscribe (newsletter) | abonnieren / abbestellen | never „abmelden“, which is sign out |
| tracker bar | Timer-Leiste | |
| undo / redo | Rückgängig / Wiederholen | |
| weekly report | Wochenbericht | |
| invoice notes | Anmerkungen | the form field and the PDF use the same word |
| invoice PDF labels | Rechnungsempfänger, Rechnungsdatum, Fälligkeitsdatum, Leistungszeitraum, Zwischensumme, USt., Gesamtbetrag | no legal fields beyond what the English invoice prints |
| popup (extension) | Pop-up | Duden spelling, in the app, the marketing pages and the store listing |
| idle span („no input for 12 min“) | „{span} lang keine Eingabe“, „Bildschirm war {span} lang gesperrt“ | not „seit“, which says it is still going on |
| two-factor authentication, authenticator app, backup code | Zwei-Faktor-Authentifizierung, Authenticator-App, Backup-Code | the code on /login is „Bestätigungscode“; turn on / off = einschalten / ausschalten |
| verification link | Bestätigungslink | „E-Mail-Adresse bestätigen“ for verify your email |
| server, server address, my own server | Server, Serveradresse, Mein eigener Server | the build's own server is „Standard ({host})“; „Track Your Time cloud“ is a name and stays as it is |
| move (a workspace to another server) | umziehen, Umzug | „Auf einen anderen Server umziehen“; never „verschieben“, which reads as moving entries in time |
| activity capture (extension) | Aktivitätserfassung | „Aktivität wird erfasst“ for the running state |
| suggestion, accept, dismiss (activity) | Vorschlag, übernehmen, ausblenden | „ausblenden“ as in `common`; a dismissed suggestion is „ausgeblendet“, never „verworfen“ |
| rule (file a site under a project) | Regel | „{site} immer ablegen unter“ |

### Decisions worth arguing about

- **Tag → Schlagwort, not "Tag".** In a time tracker "Tag" is the word for
  *day* and appears on nearly every screen ("Heute", "pro Tag", day totals).
  "3 Tags" next to "3 Tage" is a misreading waiting to happen. "Label" would
  be an anglicism with a common German word available.
- **Task → Tätigkeit, not "Aufgabe".** A task here is a workspace-wide *kind of
  work* ("Design-Review", "Rechnungsstellung"), not a to-do item. "Aufgabe"
  suggests something to tick off.
- **Client → Kunde.** Grammatically masculine as a role noun; no gendered
  variants in UI labels ("Kunde", "Kunden").
- **Timer stays Timer.** Common German usage in apps; everything else is
  longer or less precise.

## Capitalisation and grammar

- Buttons and menu items: the infinitive verb, capitalised as German nouns and
  sentence starts are — "Speichern", "Timer starten", "Projekt löschen".
- Headings and labels: sentence case; nouns are capitalised as German requires,
  nothing else is ("Woche beginnt am", not "Woche Beginnt Am").
- Compounds with English or product names take a hyphen:
  "Track-Your-Time-Timer", "API-Token", "CSV-Datei", "E-Mail".
- Plurals always use ICU `plural`, even when German and English happen to
  share a form: `{count, plural, one {# Eintrag} other {# Einträge}}`.

- **Kunde is a weak noun.** Every case but the nominative singular is
  „Kunden“: „Kunden bearbeiten“, „Kunden löschen“, „Nach Kunden filtern“,
  „für den Kunden ‚{client}‘“, „Aufteilung nach Kunden“. „Kunde bearbeiten“
  is a grammar error, not a short form.
- **No sentence-initial „Sie“ for a plural antecedent.** „Sie bleiben
  erhalten“ after a list of changes reads as the formal address this app never
  uses. Repeat the noun: „Die Änderungen bleiben erhalten“.

## Typography

- Quotes: „deutsche Anführungszeichen“ (U+201E, U+201C), single ‚…‘ inside.
  Never "straight quotes" in German text.
- Ellipsis: a single "…" character, with a space before it when it stands for
  omitted words: "Wird geladen …".
- No-break space (U+00A0) between a number and its unit: "7,5 h", "25 %",
  "1.234,50 €". The formatting helpers in `i18n/format.ts` do this — do not
  hand-write units into messages; pass a formatted value instead.
- Dashes: spaced en dash " – " for a pause; en dash without spaces for ranges
  ("9:00–17:00").

## Numbers, dates and times

Never write these into a message by hand. `useFormat()` / `useFormatSettings()`
produce them from the locale.

- Decimal comma, dot for thousands: 1.234,50.
- Currency after the amount: 1.234,50 €.
- Dates: 21.08.2026 (numeric), 21. Aug. 2026 (medium), Fr., 21. Aug. (day
  label).
- Time: 24-hour, "14:05" — "Uhr" only in running text ("um 14:05 Uhr").
- Weeks start on Monday by default.
- Durations: "1:30:00", "1,50 h", "1 h 30 min".
