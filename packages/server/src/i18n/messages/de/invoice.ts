import type { Translation } from "@starter/shared";

import type { invoice as source } from "../en/invoice.js";

/** German `invoice`. Terms follow packages/client/src/i18n/GLOSSARY.de.md; voice is „du“. */
export const invoice: Translation<typeof source> = {
  title: "Rechnung {number}",
  continued: "Rechnung {number} · Fortsetzung",
  footer: "Rechnung {number} · {client}",
  page: "Seite {page}",
  from: "Von",
  billedTo: "Rechnungsempfänger",
  taxId: "Steuernummer: {taxId}",
  vatId: "USt-IdNr.: {vatId}",
  taxNumber: "Steuernummer: {taxNumber}",
  registrationNumber: "Registernummer: {registrationNumber}",
  reference: "Referenz: {reference}",
  status: "Status",
  statusValue: "{status, select, draft {Entwurf} sent {versendet} paid {bezahlt} other {{status}}}",
  issueDate: "Rechnungsdatum",
  dueDate: "Fälligkeitsdatum",
  period: "Leistungszeitraum",
  periodRange: "{from} bis {to}",
  groupedBy: "Gruppiert nach",
  groupByValue: "{groupBy, select, project {Projekt} task {Tätigkeit} other {{groupBy}}}",
  amountsIn: "Beträge in {currency} · erstellt am {generatedAt}",
  columns: {
    description: "Beschreibung",
    hours: "Stunden",
    quantity: "Menge",
    rate: "Stundensatz",
    unitPrice: "Preis",
    amount: "Betrag",
  },
  quantityValue:
    "{quantity} {unit, select, hour {h} day {{count, plural, one {Tag} other {Tage}}} piece {Stk.} other {{unit}}}",
  noLines: "Keine abrechenbare Zeit in diesem Zeitraum.",
  subtotal: "Zwischensumme ({currency})",
  // No-break space between the number and its unit, per the glossary.
  tax: "USt. ({rate} %)",
  taxRow:
    "{category, select, S {USt. {rate} % auf {basis}} Z {Nullsatz (0 %) auf {basis}} E {Steuerfrei auf {basis}} AE {Reverse Charge auf {basis}} O {Nicht steuerbar auf {basis}} other {USt. {rate} % auf {basis}}}",
  vatNote: "Hinweis zur Umsatzsteuer",
  total: "Gesamtbetrag ({currency})",
  notes: "Anmerkungen",
  paymentDetails: "Zahlungsinformationen",
  iban: "IBAN: {iban}",
  bic: "BIC: {bic}",
  bank: "Bank: {bank}",
  accountHolder: "Kontoinhaber: {accountHolder}",
  dueBy: "Zahlbar bis zum {date}.",
  dueWithinTerms:
    "{days, plural, =0 {Zahlbar sofort nach Erhalt, bis zum {date}.} one {Zahlbar innerhalb von # Tag, bis zum {date}.} other {Zahlbar innerhalb von # Tagen, bis zum {date}.}}",
};
