/**
 * English `settings` messages — the SOURCE catalog for Settings (every tab), profile, devices, API tokens, webhooks, import/export panels, account deletion.
 *
 * Add keys here first (grouped by component or screen, camelCase), then the
 * same keys in ../de/settings.ts: `tsc` fails until both agree. ICU syntax:
 * `{name}`, `{count, plural, one {# entry} other {# entries}}`, `<b>…</b>`
 * with `t.rich`. Words every screen uses are already in `common`.
 */
export const settings = {
  foreignQueue: {
    leftTitle: "Unsynced data for {workspace}",
    leftWorkspace: "a workspace you left",
    leftDescription: "{count, plural, one {# change} other {# changes}} queued on this device in {workspace}, which your account no longer belongs to. They are not sent to any other workspace. Ask an owner to add you back to sync them, or discard them here.",
    inWorkspace: "in {workspace}",
    confirmLeft: "This deletes work tracked in {workspace} that no server has ever received. It cannot be recovered. Ask an owner to add you back instead if it should be kept.",
  },
  language: {
    title: "Language",
    description: "Saved to your account. “System” follows the language of each device.",
    /** Each option is written in its own language, so it can be found by someone who cannot read the current one. */
    system: "System",
    en: "English",
    de: "Deutsch",
    pseudo: "Pseudo (dev only)",
  },
  businessProfile: {
    title: "Business profile",
    description: "Who issues your invoices. A new invoice copies these details; invoices you already created keep the details they were created with.",
    legalName: "Legal name",
    addressLine: "Address line {line}",
    postalCode: "Postal code",
    city: "City",
    country: "Country code",
    countryHint: "Two letters, for example DE or GB.",
    taxId: "Tax ID",
    email: "Email",
    phone: "Phone",
    website: "Website",
    paymentDetails: "Payment details",
    paymentDetailsHint: "Bank account or payment link. The invoice prints this text as you write it.",
    paymentTermsDays: "Payment terms in days",
    paymentTermsHint: "Sets the suggested due date of a new invoice. Leave empty for no terms.",
    invoiceFooter: "Invoice footer",
    save: "Save business profile",
    saved: "Business profile saved.",
    saveFailed: "Could not save the business profile.",
    forbidden: "Only an owner or admin can change the business profile.",
    hiddenByRole: "Your workspace role cannot see the business profile. Ask an owner or admin of this workspace.",
    loadFailed: "Could not load the business profile.",
    invalidTerms: "Enter a whole number of days from 0 to 365.",
    invalidCountry: "Enter a two-letter country code.",
  },
} as const;
