/**
 * English `invoice` — the SOURCE catalog for the invoice PDF (services/invoice-pdf.ts): headings, column labels, totals, tax and due-date lines.
 *
 * Add keys here, then the same keys in ../de/invoice.ts (`tsc` enforces it). ICU
 * syntax as in the web client. Server text is rendered in a locale decided by
 * the DOCUMENT (an invoice's snapshotted `locale`, an email recipient's stored
 * preference), never by the request that happens to trigger it.
 */
export const invoice = {
} as const;
