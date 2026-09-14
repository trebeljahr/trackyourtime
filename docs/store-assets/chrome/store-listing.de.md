# Chrome Web Store listing — German (de)

Draft for the German localisation of the Chrome Web Store listing. The
English listing of record is `tracktime-store-copy.md` §5 in the project vault;
this is not a word-for-word translation of it, but the same claims, rewritten
for a German reader to the house copy rules and the German glossary
(`packages/client/src/i18n/GLOSSARY.de.md`: du, „Kunde“, „Tätigkeit“,
„Schlagwort“, „abrechenbar“, „Eintrag“).

Reader, in one sentence: a German-speaking freelancer who works in the browser
all day, bills by the hour, and forgets to start the timer or to stop it.

## Before submitting

- **The popup must actually speak German.** `messages/de/popup.ts` and
  `messages/de/background.ts` are translated (`packages/extension/src/i18n/`).
  Open a production build with the account language set to „Deutsch“ and check
  every screen before this listing goes live. A German listing for a popup
  that renders English is a claim the reader disproves on the first click.
- **Screenshots.** `screenshot-*.png` beside this file are English captures.
  Capture German ones (account language „Deutsch“) for the German listing, or
  leave the English ones and drop the „Sprache“ line from EINSTELLUNGEN.
- **Manifest.** `public/_locales/de/messages.json` already carries the German
  name and short description; Chrome shows them to a browser set to German.
  The short description below must stay identical to that file.
- Everything the English listing lists as a precondition (pinned
  `EXTENSION_KEY`, the production id in `TRUSTED_ORIGINS`) applies unchanged.

## Name — 75 character limit

> Track Your Time

The product name is never translated. The store's localized listing name may be
longer if the English one is; keep the two in step.

## Short description — 132 character limit

> Starte und stoppe deinen Track-Your-Time-Timer direkt in der Symbolleiste und sieh die laufende Zeit auf einen Blick.

(117 characters — identical to `extDescription` in `public/_locales/de/messages.json`.)

## Category

> Workflow & Planning

The category is chosen once for every language; the dashboard shows its own
German label for it. Nothing to translate here.

## Full description

Plain text, as the store renders it. Upper-case lines are section headings.

> Du arbeitest den ganzen Tag im Browser. Deine Zeiterfassung sollte nicht noch ein Tab sein, den du suchen musst. Mit Track Your Time startest du den Timer mit einem Klick in der Chrome-Symbolleiste, und das Symbol zeigt, wie lange er schon läuft.
>
> WAS DAS POP-UP KANN
> • Timer starten und stoppen, ohne einen Tab zu öffnen.
> • Zuletzt erfasste Arbeit mit einem Klick neu starten oder als Favorit anheften.
> • Zeit nachtragen, die du vergessen hast, und jeden Eintrag bearbeiten oder löschen.
> • Frühere Tage durchsehen und korrigieren, bevor du abrechnest.
>
> Ein Eintrag hat eine Beschreibung, ein Projekt, eine Tätigkeit, Schlagwörter und die Angabe, ob er abrechenbar ist. Projekte sind nach Kunden geordnet. Fehlt ein Projekt, eine Tätigkeit oder ein Schlagwort, legst du es direkt im Pop-up an. Es ist danach gleich ausgewählt.
>
> BESCHREIBUNGEN, DIE SICH VERVOLLSTÄNDIGEN
> Tipp die ersten Buchstaben, und das Pop-up schlägt Beschreibungen vor, die du schon benutzt hast, auch solche von vor sechs Monaten. Tab übernimmt den Vorschlag, Enter startet weiterhin den Timer. Mit ⌘ + Enter kommen Projekt, Tätigkeit, Schlagwörter und die Abrechenbarkeit gleich mit.
>
> KEINE ZWEITE ANMELDUNG
> Bist du in Chrome schon bei Track Your Time angemeldet, nutzt die Erweiterung diese Anmeldung. Kein zusätzliches Passwort, kein API-Token zum Kopieren. Bist du nicht angemeldet, meldest du dich direkt im Pop-up an.
>
> FUNKTIONIERT AUCH OHNE VERBINDUNG
> Starte und stoppe Timer, auch wenn das WLAN weg ist. Die Erweiterung speichert deine Änderungen auf diesem Computer und sendet sie der Reihe nach, sobald du wieder online bist. Meldest du dich ab, löscht sie Änderungen, die noch nicht gesendet sind. So landen deine Stunden nie im Konto der nächsten Person an diesem Computer.
>
> ÜBERALL AUF DEMSELBEN STAND
> Das Pop-up hält eine Live-Verbindung zum Server. Stoppst du einen Timer in der Web-App oder auf einem anderen Gerät, zeigt das Pop-up es sofort.
>
> EINSTELLUNGEN
> Sprache (Deutsch oder Englisch), Design, 12- oder 24-Stunden-Uhr, Dauerformat, Wochenbeginn, Währung, Standard-Stundensatz, Inaktivitätserkennung und eine maximale Eintragsdauer gegen vergessene Timer. Die Einstellungen gelten auch in der Web-App. Außerdem siehst du alle angemeldeten Geräte und kannst jedes davon abmelden.
>
> BERECHTIGUNGEN
> • storage: speichert deine Sitzung und noch nicht gesendete Änderungen auf diesem Computer.
> • cookies: liest die Anmeldung der Track-Your-Time-Web-App, damit du dich nur einmal anmeldest.
> • idle: merkt, dass du nicht am Computer bist, damit die Erweiterung dich fragen kann, was mit dieser Zeit passiert.
> • alarms: aktualisiert die Laufzeit am Symbol alle 30 Sekunden.
> • api.trackyourtime.dev: der einzige Server, mit dem die Erweiterung spricht. Die Seiten, die du besuchst, kann sie nicht lesen.
>
> WAS IN DER WEB-APP BLEIBT
> Berichte, Rechnungen, der Kalender und die Verwaltung deiner Kunden. Das Pop-up ist 380 Pixel breit, und ein Bericht passt da nicht hinein.
>
> EIGENER SERVER
> Die Version aus dem Chrome Web Store verbindet sich mit trackyourtime.dev. Für deinen eigenen Server baust du die Erweiterung aus dem Quellcode, mit der Adresse deines Servers. Wie das geht, zeigt die Anleitung zum Selbsthosten.
>
> OPEN SOURCE
> Track Your Time ist Open Source unter der AGPL-3.0: github.com/trebeljahr/trackyourtime. Die App kann noch keine Teammitglieder einladen.

## Screenshot captions

Same order as the English files in this directory.

1. `screenshot-1-timer` — „Starte und stoppe deinen Timer in der Symbolleiste“
2. `screenshot-2-autocomplete` — „Beschreibungen vervollständigen sich aus deiner bisherigen Arbeit“
3. `screenshot-3-entries` — „Bearbeite, wiederhole oder lösche jeden Eintrag“
4. `screenshot-4-web-app` — „Berichte und Rechnungen findest du einen Klick entfernt in der Web-App“

## Claims checked against the code (2026-09-14)

| Claim | Where it is true |
| --- | --- |
| Badge shows the running time | `packages/extension/src/background/badge.ts` |
| Quick start and pinned favorites | `popup/quick-start-list.tsx`, `background/favorites.ts` |
| Log past time, edit and delete entries, earlier days | `popup/entry-create-screen.tsx`, `popup/entry-detail-screen.tsx`, `popup/entries-screen.tsx` |
| Create project, client, task and tag in the popup, selected afterwards | `popup/project-picker.tsx`, `popup/use-created-row.ts` |
| Server-side description search, Tab / Enter / ⌘ Enter | `background/descriptions.ts`, `popup/description-field.tsx` |
| Suggestions reach back six months | `packages/server/src/services/entries/list.ts` (`DEFAULT_DESCRIPTION_DAYS = 180`) |
| Sign-in form in the popup | `popup/sign-in-screen.tsx` |
| Badge refreshed every 30 seconds | `background/index.ts` (`BADGE_PERIOD_MINUTES = 0.5`) |
| Reuses the web app's session cookie | `lib/web-session.ts` (`cookies` permission) |
| Offline queue, cleared on sign-out | `background/runtime.ts` (`getOfflineQueue().clear()` in `forgetSession`) |
| Live sync | `background/runtime.ts` (`createSyncClient`) |
| Settings listed, incl. language | `popup/settings/*.tsx` |
| Permissions and host | `packages/extension/manifest.config.ts` |
| No team invitations | the landing page's own statement, `components/marketing/pages/landing-page.tsx` |

Deliberately left out: any price, „kostenlos“, beta wording, install counts, and
any competing product.
