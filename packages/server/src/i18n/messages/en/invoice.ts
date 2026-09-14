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
    rate: "Rate",
    amount: "Amount",
  },
  noLines: "No billable time in this range.",
  subtotal: "Subtotal ({currency})",
  /** `rate` is a formatted number without its percent sign. */
  tax: "Tax ({rate}%)",
  total: "Total ({currency})",
  notes: "Notes",
  paymentDetails: "Payment details",
  dueBy: "Payable by {date}.",
  dueWithinTerms:
    "{days, plural, =0 {Payable on receipt, by {date}.} one {Payable within # day, by {date}.} other {Payable within # days, by {date}.}}",
} as const;
