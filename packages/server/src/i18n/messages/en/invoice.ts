/**
 * English `invoice` — the SOURCE catalog for the invoice PDF (services/invoice-pdf.ts): headings, column labels, totals, tax and due-date lines.
 *
 * Add keys here, then the same keys in ../de/invoice.ts (`tsc` enforces it). ICU
 * syntax as in the web client. Server text is rendered in a locale decided by
 * the DOCUMENT (an invoice's snapshotted `locale`, an email recipient's stored
 * preference), never by the request that happens to trigger it.
 *
 * Numbers, dates and percentages arrive already formatted (strings): a PDF
 * font has no glyph for some of the spaces `Intl` emits, so the renderer owns
 * formatting (services/pdf-format.ts) and the messages only place the result.
 */
export const invoice = {
  title: "Invoice {number}",
  continued: "Invoice {number} · continued",
  footer: "Invoice {number} · {client}",
  page: "Page {page}",
  from: "From",
  billedTo: "Billed to",
  taxId: "Tax ID: {taxId}",
  vatId: "VAT ID: {vatId}",
  taxNumber: "Tax number: {taxNumber}",
  registrationNumber: "Registration: {registrationNumber}",
  reference: "Your reference: {reference}",
  status: "Status",
  statusValue: "{status, select, draft {Draft} sent {Sent} paid {Paid} other {{status}}}",
  issueDate: "Issue date",
  dueDate: "Due date",
  period: "Period",
  periodRange: "{from} to {to}",
  groupedBy: "Grouped by",
  groupByValue: "{groupBy, select, project {Project} task {Task} other {{groupBy}}}",
  amountsIn: "Amounts in {currency} · generated {generatedAt}",
  columns: {
    description: "Description",
    hours: "Hours",
    /** Replaces "Hours" once a manual line is on the invoice; every cell then names its unit. */
    quantity: "Quantity",
    rate: "Rate",
    /** Replaces "Rate" beside "Quantity": the price of one unit. */
    unitPrice: "Price",
    amount: "Amount",
  },
  /**
   * A quantity with its unit: `quantity` is already formatted ("2.00"),
   * `count` is the same number for the plural, `unit` one of hour/day/piece.
   */
  quantityValue:
    "{quantity} {unit, select, hour {h} day {{count, plural, one {day} other {days}}} piece {{count, plural, one {pc} other {pcs}}} other {{unit}}}",
  noLines: "No billable time in this range.",
  subtotal: "Subtotal ({currency})",
  /** `rate` is a formatted number without its percent sign. */
  tax: "Tax ({rate}%)",
  /**
   * One row per VAT breakdown row. `rate` is a formatted number without its
   * percent sign; `basis` is the row's taxable amount (BT-116), already formatted.
   */
  taxRow:
    "{category, select, S {VAT {rate}% on {basis}} Z {Zero-rated (0%) on {basis}} E {VAT exempt on {basis}} AE {Reverse charge on {basis}} O {Not subject to VAT on {basis}} other {VAT {rate}% on {basis}}}",
  vatNote: "VAT note",
  total: "Total ({currency})",
  notes: "Notes",
  paymentDetails: "Payment details",
  iban: "IBAN: {iban}",
  bic: "BIC: {bic}",
  bank: "Bank: {bank}",
  accountHolder: "Account holder: {accountHolder}",
  dueBy: "Payable by {date}.",
  dueWithinTerms:
    "{days, plural, =0 {Payable on receipt, by {date}.} one {Payable within # day, by {date}.} other {Payable within # days, by {date}.}}",
} as const;
