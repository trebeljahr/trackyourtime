import type { Translation } from "@starter/shared";

import type { settings as source } from "../en/settings";

/** German `settings`. Terms follow i18n/GLOSSARY.de.md; voice is „du“. */
export const settings: Translation<typeof source> = {
  foreignQueue: {
    leftTitle: "Nicht synchronisierte Daten für {workspace}",
    leftWorkspace: "einen verlassenen Arbeitsbereich",
    leftDescription: "{count, plural, one {# Änderung} other {# Änderungen}} auf diesem Gerät in {workspace} in die Warteschlange gestellt. Dein Konto gehört nicht mehr dazu. Sie werden an keinen anderen Arbeitsbereich gesendet. Bitte einen Inhaber, dich wieder hinzuzufügen, um sie zu synchronisieren, oder verwirf sie hier.",
    inWorkspace: "in {workspace}",
    confirmLeft: "Damit löschst du in {workspace} erfasste Arbeit, die kein Server je erhalten hat. Sie lässt sich nicht wiederherstellen. Bitte stattdessen einen Inhaber, dich wieder hinzuzufügen, wenn sie erhalten bleiben soll.",
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
  },
};
