# Chrome Web Store listing — German (de)

Draft for the German localisation of the Chrome Web Store listing. The
English listing of record is `tracktime-store-copy.md` §5 in the project vault;
this is not a word-for-word translation of it, but the same claims, rewritten
for a German reader to the house copy rules and the German glossary
(`packages/client/src/i18n/GLOSSARY.de.md`: du, „Kunde“, „Tätigkeit“,
„Schlagwort“, „abrechenbar“, „Eintrag“, „Arbeitsbereich“, „Mitglied“).

Reader, in one sentence: a German-speaking freelancer who works in the browser
all day, bills by the hour, and forgets to start the timer or to stop it.

## Before submitting

- **The popup must actually speak German.** `messages/de/popup.ts` and
  `messages/de/background.ts` are translated (`packages/extension/src/i18n/`).
  Open a production build with the account language set to „Deutsch“ and check
  every screen before this listing goes live. A German listing for a popup
  that renders English is a claim the reader disproves on the first click.
  Known gap: a two-factor account that uses the popup's own sign-in form gets
  core's English `TWO_FACTOR_UNSUPPORTED` sentence, which `popup/errors.ts`
  does not translate.
- **Screenshots.** `screenshot-*.png` beside this file are English captures.
  Capture German ones (account language „Deutsch“) for the German listing, or
  leave the English ones and drop the „Sprache“ line from EINSTELLUNGEN.
- **Manifest.** `public/_locales/de/messages.json` already carries the German
  name and short description; Chrome shows them to a browser set to German.
  The short description below must stay identical to that file.
- **`tabs` justification.** The dashboard asks why the extension declares the
  optional `tabs` permission. It is activity capture, requested from the click
  that turns it on (see BERECHTIGUNGEN). The data disclosures must cover the
  sites and, when switched on, page titles that capture keeps on the device.
- Everything the English listing lists as a precondition applies unchanged:
  the production build pins `STORE_EXTENSION_KEY` unless `EXTENSION_KEY`
  overrides it, and the hosted server must trust that id (`TRUST_STORE_APPS=true`
  or the id in `TRUSTED_ORIGINS`, set in Coolify).

## Name — 75 character limit

> Track Your Time

The product name is never translated. The store takes it from the manifest
(`extName` in `public/_locales/de/messages.json`), so it matches the English
listing by construction.

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
> VORSCHLÄGE FÜR VERGESSENE ZEIT
> Schaltest du in den Einstellungen die Aktivitätserfassung ein, merkt sich die Erweiterung, auf welcher Website du gerade bist. Für Zeit ohne Eintrag schlägt sie dir dann Einträge vor. Du übernimmst einen Vorschlag, bearbeitest ihn vorher oder blendest ihn aus. Mit einer Regel legst du eine Website immer unter demselben Projekt ab.
>
> Die Aktivität bleibt auf diesem Computer. Erst ein Vorschlag, den du übernimmst, geht als Eintrag an den Server. Die Aktivitätserfassung ist anfangs aus. Sie speichert nur den Namen der Website, außer du schaltest Seitentitel ausdrücklich ein. Ältere Aktivität löscht sie nach 14 Tagen, oder nach dem Zeitraum, den du einstellst. Inkognito-Tabs und Websites auf deiner Ausschlussliste erfasst sie nie.
>
> KEINE ZWEITE ANMELDUNG
> Bist du in Chrome schon bei Track Your Time angemeldet, nutzt die Erweiterung diese Anmeldung. Kein zusätzliches Passwort, kein API-Token zum Kopieren. Bist du nicht angemeldet, meldest du dich direkt im Pop-up an. Nutzt dein Konto die Zwei-Faktor-Authentifizierung, meldest du dich zuerst in der Web-App an. Das Formular im Pop-up kann den zweiten Faktor nicht abfragen.
>
> FUNKTIONIERT AUCH OHNE VERBINDUNG
> Starte und stoppe Timer, auch wenn das WLAN weg ist. Die Erweiterung speichert deine Änderungen auf diesem Computer und sendet sie der Reihe nach, sobald du wieder online bist. Meldest du dich ab, löscht sie Änderungen, die noch nicht gesendet sind. So landen deine Stunden nie im Konto der nächsten Person an diesem Computer.
>
> ÜBERALL AUF DEMSELBEN STAND
> Das Pop-up hält eine Live-Verbindung zum Server. Stoppst du einen Timer in der Web-App oder auf einem anderen Gerät, zeigt das Pop-up es sofort.
>
> MIT DEINEM TEAM
> In der Web-App lädst du Kolleginnen und Kollegen per E-Mail in deinen Arbeitsbereich ein, als Mitglied oder Admin. Jede Person sieht nur ihre eigene Zeit, bis du ihr die Zeit oder die Beträge der anderen freigibst. Das Pop-up zeigt jeder Person nur ihre eigenen Einträge.
>
> Bist du in mehreren Arbeitsbereichen, wählst du im Pop-up, in welchem du erfasst. Die Web-App behält dabei ihre eigene Auswahl. Eine Änderung ohne Verbindung landet in dem Arbeitsbereich, in dem du sie gemacht hast, auch wenn du danach wechselst.
>
> EINSTELLUNGEN
> Sprache (Deutsch oder Englisch), Design, 12- oder 24-Stunden-Uhr, Dauerformat, Inaktivitätserkennung und eine maximale Eintragsdauer gegen vergessene Timer. Sie gelten auch in der Web-App und auf deinen anderen Geräten. Wochenbeginn, Währung und Standard-Stundensatz gelten für den ganzen Arbeitsbereich, und nur Inhaber und Admins können sie ändern. Außerdem siehst du alle angemeldeten Geräte und kannst jedes davon abmelden.
>
> BERECHTIGUNGEN
> • storage: speichert deine Sitzung, noch nicht gesendete Änderungen und, falls eingeschaltet, deine Aktivität auf diesem Computer.
> • cookies: liest die Anmeldung der Track-Your-Time-Web-App, damit du dich nur einmal anmeldest.
> • idle: merkt, dass du nicht am Computer bist, damit die Erweiterung dich fragen kann, was mit dieser Zeit passiert.
> • alarms: aktualisiert die Laufzeit am Symbol alle 30 Sekunden.
> • tabs (optional): fragt Chrome erst, wenn du die Aktivitätserfassung einschaltest. Damit sieht die Erweiterung die Adresse und den Titel des aktiven Tabs. Den Inhalt einer Seite liest sie nie.
> • api.trackyourtime.dev: der Standardserver. Wählst du einen eigenen Server, fragt Chrome dich nach Zugriff auf genau diese eine Adresse.
>
> WAS IN DER WEB-APP BLEIBT
> Berichte, Rechnungen, der Kalender, die Verwaltung deiner Kunden und das Einladen von Mitgliedern. Das Pop-up ist 380 Pixel breit, und ein Bericht passt da nicht hinein.
>
> EIGENER SERVER
> Die Erweiterung aus dem Chrome Web Store funktioniert auch mit einem selbst gehosteten Track-Your-Time-Server. Wähle beim Anmelden „Mein eigener Server“ und gib seine Adresse ein. Wie du den Server einrichtest, zeigt die Anleitung zum Selbsthosten.
>
> OPEN SOURCE
> Track Your Time ist Open Source unter der AGPL-3.0: github.com/trebeljahr/trackyourtime.

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
| Activity capture off by default, hostnames only unless titles are switched on, 14-day retention | `background/activity/settings.ts` (`DEFAULT_ACTIVITY_SETTINGS`, `DEFAULT_RETENTION_DAYS = 14`) |
| Activity stays on the device, accept creates an entry | `background/activity/store.ts` (IndexedDB), `background/activity/suggestions.ts`, `popup/suggestions-screen.tsx` |
| Rules file a site under a project | `popup/suggestions-screen.tsx` (`suggestions.alwaysFile`) |
| Incognito tabs and excluded sites never recorded | `background/activity/capture.ts` (`tab.incognito`), `popup/settings/activity-section.tsx` |
| Sign-in form in the popup | `popup/sign-in-screen.tsx` |
| Popup form cannot complete two-factor | `packages/core/src/session-auth.ts` (`TWO_FACTOR_UNSUPPORTED`) |
| Badge refreshed every 30 seconds | `background/index.ts` (`BADGE_PERIOD_MINUTES = 0.5`) |
| Reuses the web app's session cookie | `lib/web-session.ts` (`cookies` permission) |
| Offline queue, cleared on sign-out | `background/runtime.ts` (`getOfflineQueue().clear()` in `forgetSession`) |
| Live sync | `background/runtime.ts` (`createSyncClient`) |
| Invite by email as member or admin, colleagues' time and money hidden until granted | `packages/client/src/components/members/`, `packages/server/src/services/membership/` |
| Popup lists only the person's own entries | `background/entries.ts` (`ownOnly`) |
| Workspace picker, independent of the web app; offline rows keep their workspace | `popup/workspace-bar.tsx`, `lib/workspace-choice.ts`, `QueuedMutation.workspaceId` |
| Settings listed, incl. language; which are workspace-wide and owner/admin only | `popup/settings/*.tsx`, `packages/server/src/trpc/routers/settings.ts` (`WORKSPACE_FIELDS`) |
| Permissions, optional `tabs`, per-host access for another server | `packages/extension/manifest.config.ts`, `lib/server-access.ts` |
| Store build works with a self-hosted server | `popup/server-picker.tsx`; `docker-compose.selfhost.yml` defaults `TRUST_STORE_APPS` to `true` |

Deliberately left out: any price, „kostenlos“, beta wording, install counts, and
any competing product.
