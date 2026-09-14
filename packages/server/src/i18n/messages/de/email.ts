import type { Translation } from "@starter/shared";

import type { email as source } from "../en/email.js";

/** German `email`. Terms follow packages/client/src/i18n/GLOSSARY.de.md; voice is „du“. */
export const email: Translation<typeof source> = {
  invitation: {
    subject: "{inviter} hat dich zu {workspace} bei Track Your Time eingeladen",
    intro: "{inviter} hat dich eingeladen, {workspace} bei Track Your Time beizutreten.",
    action: "Einladung annehmen",
    expiry: "Der Link gilt {hours} Stunden. Wenn du diese E-Mail nicht erwartet hast, ignoriere sie.",
    someone: "Jemand",
    aWorkspace: "einem Arbeitsbereich",
  },
};
