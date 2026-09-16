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
Rewritten 2026-09-16 with the English listing: the product's positioning first
(free, open source, your data where you choose), no permission list (the Privacy
tab carries it).

> Track Your Time ist kostenlose Open-Source-Zeiterfassung für Freelancer und kleine Teams, die nach Stunden abrechnen. Diese Erweiterung legt den Timer in deine Chrome-Symbolleiste. Ein Klick startet ihn, und das Symbol zeigt, wie lange er schon läuft.
>
> KOSTENLOS, OHNE EINSCHRÄNKUNGEN
> Es gibt keine Bezahlversion, weder jetzt noch später, und keine Premium-Stufe. Jede Funktion steckt in jeder Installation, auch in der gehosteten Version. Der Code ist Open Source unter der AGPL-3.0 und entsteht öffentlich auf GitHub.
>
> DEINE DATEN LIEGEN, WO DU WILLST
> Eine Zeiterfassung weiß, wer deine Kunden sind, was du ihnen berechnest und wie du jeden Arbeitstag verbringst. Das liegt auf trackyourtime.dev oder auf einem Server, den du selbst betreibst. Es ist in beiden Fällen dieselbe App, und die Erweiterung funktioniert mit beiden: Wähle unter dem Anmeldeformular „Server wechseln“. Alles exportierst du jederzeit als JSON oder CSV.
>
> EIN TIMER, DER MITHÄLT
> Die Arbeit von heute ist meist die von gestern. Starte sie aus deinen letzten Einträgen neu, oder hefte an, was du jeden Tag machst. Tipp die ersten Buchstaben einer Beschreibung, und die Erweiterung schlägt vor, was du schon benutzt hast. Projekt und Schlagwörter vom letzten Mal kann sie gleich mit übernehmen.
>
> Bricht im Zug die Verbindung ab, erfasst du einfach weiter. Die Erweiterung speichert deine Änderungen und sendet sie, sobald du wieder online bist. Stoppst du hier einen Timer, zeigt die Web-App ihn sofort als gestoppt.
>
> Du bist in Chrome schon bei Track Your Time angemeldet? Dann nutzt die Erweiterung diese Anmeldung. Kein zusätzliches Passwort, kein API-Token zum Kopieren.
>
> DIE STUNDEN, DIE DU VERGESSEN HAST
> Trag die Zeit für einen Anruf nach, den du nicht gestoppt hast, oder korrigiere einen früheren Tag, bevor du abrechnest. Oder schalte die Aktivitätserfassung ein. Die Erweiterung merkt sich, welche Website du vor dir hattest, und schlägt Einträge für die Lücken in deinem Tag vor. Sie speichert den Namen der Website, nicht ihren Inhalt, und nichts verlässt deinen Computer, bevor du einen Vorschlag annimmst.
>
> VON DEN STUNDEN ZUR RECHNUNG
> Die Web-App macht aus deinen Stunden Berichte nach Kunde, Projekt, Tätigkeit oder Person. Rechnungen erstellt sie als PDF oder als E-Rechnung im Format ZUGFeRD oder XRechnung. Lade dein Team ein. Jede Person sieht nur ihre eigene Zeit, bis du mehr freigibst.
>
> Eine Einschränkung: Nutzt dein Konto die Zwei-Faktor-Authentifizierung, melde dich zuerst in Chrome in der Web-App an. Das Anmeldeformular im Pop-up kann den Code nicht abfragen.

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
