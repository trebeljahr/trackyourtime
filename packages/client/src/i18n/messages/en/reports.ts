/**
 * English `reports` messages — the SOURCE catalog for reports (Totals and Entries), charts, budgets and invoices.
 *
 * Add keys here first (grouped by component or screen, camelCase), then the
 * same keys in ../de/reports.ts: `tsc` fails until both agree. ICU syntax:
 * `{name}`, `{count, plural, one {# entry} other {# entries}}`, `<b>…</b>`
 * with `t.rich`. Words every screen uses are already in `common`.
 */
export const reports = {
  invoiceIdentity: {
    profileMissing: "Your business profile has no address, so this invoice will not say who issued it.",
    profileLink: "Complete the business profile",
    clientMissing: "{client} has no billing address, so this invoice will show only the client name.",
    clientLink: "Add billing details",
    dueFromTerms: "Due date set from your payment terms of {days, plural, one {# day} other {# days}}.",
  },
} as const;
