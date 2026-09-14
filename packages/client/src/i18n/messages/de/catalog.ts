import type { Translation } from "@starter/shared";

import type { catalog as source } from "../en/catalog";

/** German `catalog`. Terms follow i18n/GLOSSARY.de.md; voice is „du“. */
export const catalog: Translation<typeof source> = {
  clientBilling: {
    toggle: "Rechnungsdaten",
    toggleHint: "Was eine Rechnung unter „Rechnungsempfänger“ druckt. Alle Felder sind optional.",
    legalName: "Offizieller Name",
    addressLine: "Adresszeile {line}",
    postalCode: "Postleitzahl",
    city: "Ort",
    country: "Ländercode",
    taxId: "Steuernummer",
    email: "E-Mail für Rechnungen",
    reference: "Referenz",
    referenceHint: "Bestellnummer oder Kostenstelle des Kunden.",
    invalidCountry: "Gib einen zweistelligen Ländercode ein.",
  },
};
