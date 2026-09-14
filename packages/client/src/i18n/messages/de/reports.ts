import type { Translation } from "@starter/shared";

import type { reports as source } from "../en/reports";

/** German `reports`. Terms follow i18n/GLOSSARY.de.md; voice is „du“. */
export const reports: Translation<typeof source> = {
  invoiceIdentity: {
    profileMissing: "Dein Unternehmensprofil hat keine Adresse, also nennt diese Rechnung keinen Aussteller.",
    profileLink: "Unternehmensprofil vervollständigen",
    clientMissing: "{client} hat keine Rechnungsadresse, also zeigt diese Rechnung nur den Kundennamen.",
    clientLink: "Rechnungsdaten ergänzen",
    dueFromTerms: "Fälligkeitsdatum aus deinem Zahlungsziel von {days, plural, one {# Tag} other {# Tagen}}.",
  },
};
