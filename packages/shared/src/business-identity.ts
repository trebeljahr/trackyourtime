// Who issues an invoice and who it is addressed to.
//
// Both halves are free text the person typed, stored with one rule: a blank
// field is `null`, never `""`. That rule lives here so the server's writes,
// the import restore and the forms cannot disagree about what "empty" means —
// and so "this client has no billing details" is one comparison, not a walk
// over every field with a different idea of blank each time.
import type {
  BusinessProfile,
  ClientBilling,
  InvoiceIssuer,
  InvoiceRecipient,
} from "./types.js";

/** A possibly-blank text field as a form or an old export sends it. */
type TextInput = string | null | undefined;

type PostalInput = {
  legalName?: TextInput;
  addressLines?: readonly string[] | null;
  postalCode?: TextInput;
  city?: TextInput;
  country?: TextInput;
  taxId?: TextInput;
  email?: TextInput;
};

export type ClientBillingFields = PostalInput & { reference?: TextInput };

export type BusinessProfileFields = PostalInput & {
  phone?: TextInput;
  website?: TextInput;
  paymentDetails?: TextInput;
  paymentTermsDays?: number | null;
  invoiceFooter?: TextInput;
};

/** Trimmed text, or `null` when nothing but whitespace was given. */
export function blankToNull(value: TextInput): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function normalizeLines(lines: readonly string[] | null | undefined): string[] {
  return (lines ?? [])
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function normalizePostal(input: PostalInput): Omit<ClientBilling, "reference"> {
  const country = blankToNull(input.country);
  return {
    legalName: blankToNull(input.legalName),
    addressLines: normalizeLines(input.addressLines),
    postalCode: blankToNull(input.postalCode),
    city: blankToNull(input.city),
    country: country ? country.toUpperCase() : null,
    taxId: blankToNull(input.taxId),
    email: blankToNull(input.email),
  };
}

/**
 * A client's billing details with blanks collapsed, or `null` when nothing
 * is left — so a form cleared field by field stores the same thing as a
 * client that never had any.
 */
export function normalizeClientBilling(
  input: ClientBillingFields | null | undefined,
): ClientBilling | null {
  if (!input) return null;
  const billing: ClientBilling = {
    ...normalizePostal(input),
    reference: blankToNull(input.reference),
  };
  return isIdentityEmpty(billing) ? null : billing;
}

/** Every business profile field with blanks collapsed. Never `null`. */
export function normalizeBusinessProfile(
  input: BusinessProfileFields | null | undefined,
): InvoiceIssuer {
  const source = input ?? {};
  return {
    ...normalizePostal(source),
    phone: blankToNull(source.phone),
    website: blankToNull(source.website),
    paymentDetails: blankToNull(source.paymentDetails),
    paymentTermsDays:
      typeof source.paymentTermsDays === "number"
        ? source.paymentTermsDays
        : null,
    invoiceFooter: blankToNull(source.invoiceFooter),
  };
}

/** True when not one field carries a value. */
export function isIdentityEmpty(value: object): boolean {
  return Object.values(value).every((field) =>
    Array.isArray(field) ? field.length === 0 : field === null,
  );
}

/** The profile `settings.businessProfile` answers before the first save. */
export function emptyBusinessProfile(workspaceId: string): BusinessProfile {
  return { workspaceId, ...normalizeBusinessProfile(null), updatedAt: null };
}

/**
 * True when an identity has nothing a letter could be posted to: no street
 * line and no city. The invoice dialog warns on this rather than on "every
 * field blank", because a profile holding only a tax id still cannot be sent.
 */
export function isPostalAddressMissing(
  value: Pick<ClientBilling, "addressLines" | "city"> | null | undefined,
): boolean {
  return !value || (value.addressLines.length === 0 && value.city === null);
}

/**
 * The address as printed lines: street lines, then "postal code city", then
 * the country code. Blank parts are skipped rather than printed as gaps.
 */
export function formatPostalAddress(
  value: Pick<ClientBilling, "addressLines" | "postalCode" | "city" | "country">,
): string[] {
  const locality = [value.postalCode, value.city]
    .filter((part): part is string => part !== null)
    .join(" ");
  return [
    ...value.addressLines,
    ...(locality ? [locality] : []),
    ...(value.country ? [value.country] : []),
  ];
}

/**
 * The issuer snapshot copied onto a new invoice, or `null` when the profile
 * is empty — which renders exactly like an invoice from before profiles.
 */
export function issuerSnapshot(
  profile: BusinessProfileFields | null | undefined,
): InvoiceIssuer | null {
  const issuer = normalizeBusinessProfile(profile);
  return isIdentityEmpty(issuer) ? null : issuer;
}

/**
 * The recipient snapshot copied onto a new invoice. Always carries the name,
 * so it is `null` only when the client has no billing details at all — then
 * `clientName` alone is "Billed to", as it was before.
 */
export function recipientSnapshot(
  clientName: string,
  billing: ClientBillingFields | null | undefined,
): InvoiceRecipient | null {
  const normalized = normalizeClientBilling(billing);
  return normalized ? { name: clientName, ...normalized } : null;
}

/** A stored recipient snapshot with blanks collapsed; keeps the name. */
export function normalizeRecipient(
  input: ClientBillingFields & { name: string },
): InvoiceRecipient {
  return {
    name: input.name,
    ...normalizePostal(input),
    reference: blankToNull(input.reference),
  };
}

/**
 * The due date that payment terms suggest: the issue date plus that many
 * calendar days, counted in UTC so it does not move with the viewer's zone.
 * `YYYY-MM-DD` in, `YYYY-MM-DD` out; `null` when there are no terms.
 */
export function dueDateFromTerms(
  issueDate: string,
  paymentTermsDays: number | null | undefined,
): string | null {
  if (typeof paymentTermsDays !== "number") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(issueDate);
  if (!match) return null;
  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  date.setUTCDate(date.getUTCDate() + paymentTermsDays);
  return date.toISOString().slice(0, 10);
}
