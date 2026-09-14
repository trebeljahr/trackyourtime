import type { Translation } from "@starter/shared";

import type { email as source } from "../en/email.js";

/** German `email`. Terms follow packages/client/src/i18n/GLOSSARY.de.md; voice is „du“. */
export const email: Translation<typeof source> = {
  passwordReset: {
    subject: "Passwort zurücksetzen",
    intro: "Öffne diesen Link, um dein Track-Your-Time-Passwort zurückzusetzen:",
    action: "Passwort zurücksetzen",
    ignore: "Wenn du das nicht angefordert hast, ignoriere diese E-Mail. Dein Passwort bleibt unverändert.",
  },
  verification: {
    subject: "E-Mail-Adresse bestätigen",
    intro: "Öffne diesen Link, um zu bestätigen, dass diese Adresse zu deinem Track-Your-Time-Konto gehört:",
    action: "E-Mail-Adresse bestätigen",
    ignore: "Wenn du kein Konto erstellt hast, ignoriere diese E-Mail.",
  },
  invitation: {
    subject: "{inviter} hat dich zu {workspace} bei Track Your Time eingeladen",
    intro: "{inviter} hat dich eingeladen, {workspace} bei Track Your Time beizutreten.",
    action: "Einladung annehmen",
    expiry: "Der Link gilt {hours} Stunden. Wenn du diese E-Mail nicht erwartet hast, ignoriere sie.",
    someone: "Jemand",
    aWorkspace: "einem Arbeitsbereich",
  },
  newsletterConfirmation: {
    subject: "Bestätige dein Abonnement · {siteName}",
    heading: "Bestätige dein Abonnement",
    lead: "Nur noch ein Klick, dann bekommst du {siteName}.",
    body: "Tippe auf die Schaltfläche unten, um diese Adresse zu bestätigen und das Abonnement abzuschließen. Der Link ist {days, plural, one {# Tag} other {# Tage}} gültig.",
    action: "Abonnement bestätigen",
    pasteUrl: "Oder kopiere diese URL in deinen Browser:",
    ignore: "Wenn du nichts abonniert hast, ignoriere diese E-Mail – ohne Klick wirst du nicht eingetragen. Der Link läuft nach {days, plural, one {# Tag} other {# Tagen}} ab.",
    defaultSiteName: "diesen Newsletter",
  },
  runawayReminder: {
    subject: "Dein Timer läuft seit {elapsed}",
    startedText: "Dein Timer „{name}“ wurde um {started} gestartet und läuft seit {elapsed}.",
    startedHtml: "Dein Timer {name} wurde um {started} gestartet und läuft seit {elapsed}.",
    untitled: "Ohne Titel",
    forgot: "Falls du vergessen hast, ihn zu stoppen, stoppe ihn jetzt oder korrigiere sein Ende.",
    pastLimit:
      "Damit ist deine maximale Eintragsdauer von {limit} überschritten. Stoppe ihn, lass ihn weiterlaufen oder korrigiere sein Ende.",
    open: "Timer öffnen",
    footer:
      "Du bekommst diese E-Mail einmal pro Timer. Wenn du diese E-Mails nicht mehr möchtest, schalte unter Einstellungen → Konto die E-Mail-Benachrichtigungen aus.",
  },
};
