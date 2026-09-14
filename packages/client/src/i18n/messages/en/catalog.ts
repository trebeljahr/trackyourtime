/**
 * English `catalog` messages — the SOURCE catalog for clients, projects, tasks and tags screens, pickers and dialogs.
 *
 * Add keys here first (grouped by component or screen, camelCase), then the
 * same keys in ../de/catalog.ts: `tsc` fails until both agree. ICU syntax:
 * `{name}`, `{count, plural, one {# entry} other {# entries}}`, `<b>…</b>`
 * with `t.rich`. Words every screen uses are already in `common`.
 */
export const catalog = {
  clientBilling: {
    toggle: "Billing details",
    toggleHint: "What an invoice prints under “Billed to”. All fields are optional.",
    legalName: "Legal name",
    addressLine: "Address line {line}",
    postalCode: "Postal code",
    city: "City",
    country: "Country code",
    taxId: "Tax ID",
    email: "Billing email",
    reference: "Reference",
    referenceHint: "The client’s purchase order or cost centre.",
    invalidCountry: "Enter a two-letter country code.",
  },
} as const;
