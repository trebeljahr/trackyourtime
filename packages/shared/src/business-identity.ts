// Who issues an invoice and who it is addressed to.
//
// Both halves are free text the person typed, stored with one rule: a blank
// field is `null`, never `""`. That rule lives here so the server's writes,
// the import restore and the forms cannot disagree about what "empty" means —
// and so "this client has no billing details" is one comparison, not a walk
// over every field with a different idea of blank each time.
import {
  ELECTRONIC_ADDRESS_SCHEMES,
  INVOICE_FORMATS,
  TAX_CATEGORIES,
  isValidElectronicAddress,
  stripSpacesUpper,
  type ElectronicAddressScheme,
  type InvoiceFormat,
  type TaxCategory,
} from "./einvoice.js";
import type {
  BusinessProfile,
  BusinessProfileValues,
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

type ElectronicAddressInput = {
  electronicAddress?: TextInput;
  electronicAddressScheme?: ElectronicAddressScheme | null;
};

export type ClientBillingFields = PostalInput &
  ElectronicAddressInput & {
    reference?: TextInput;
    vatId?: TextInput;
    preferredFormat?: InvoiceFormat | null;
    defaultTaxCategory?: TaxCategory | null;
  };

export type BusinessProfileFields = PostalInput &
  ElectronicAddressInput & {
    phone?: TextInput;
    website?: TextInput;
    paymentDetails?: TextInput;
    paymentTermsDays?: number | null;
    invoiceFooter?: TextInput;
    vatId?: TextInput;
    taxNumber?: TextInput;
    registrationNumber?: TextInput;
    sellerIdentifier?: TextInput;
    contactName?: TextInput;
    iban?: TextInput;
    bic?: TextInput;
    bankName?: TextInput;
    accountHolder?: TextInput;
    smallBusiness?: boolean | null;
    smallBusinessNote?: TextInput;
    defaultTaxCategory?: TaxCategory | null;
    defaultTaxRate?: number | null;
  };

/** The client billing details of a client nobody filled in, field by field. */
export const EMPTY_CLIENT_BILLING: ClientBilling = Object.freeze({
  legalName: null,
  addressLines: [],
  postalCode: null,
  city: null,
  country: null,
  taxId: null,
  email: null,
  reference: null,
  vatId: null,
  electronicAddress: null,
  electronicAddressScheme: null,
  preferredFormat: null,
  defaultTaxCategory: null,
}) as ClientBilling;

/** Trimmed text, or `null` when nothing but whitespace was given. */
export function blankToNull(value: TextInput): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** An identifier with every space removed, upper case, or `null` when blank. */
function compactToNull(value: TextInput): string | null {
  if (typeof value !== "string") return null;
  const compact = stripSpacesUpper(value);
  return compact === "" ? null : compact;
}

const oneOf = <T extends string>(allowed: readonly T[], value: unknown): T | null =>
  typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : null;

/**
 * The electronic address pair: both set or both `null`, so no reader has to
 * decide what a value without its scheme means.
 */
function normalizeElectronicAddress(input: ElectronicAddressInput): {
  electronicAddress: string | null;
  electronicAddressScheme: ElectronicAddressScheme | null;
} {
  const address = blankToNull(input.electronicAddress);
  const scheme = oneOf(ELECTRONIC_ADDRESS_SCHEMES, input.electronicAddressScheme);
  return address !== null && scheme !== null
    ? { electronicAddress: address, electronicAddressScheme: scheme }
    : { electronicAddress: null, electronicAddressScheme: null };
}

function normalizeLines(lines: readonly string[] | null | undefined): string[] {
  return (lines ?? [])
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

type PostalValues = Pick<
  ClientBilling,
  "legalName" | "addressLines" | "postalCode" | "city" | "country" | "taxId" | "email"
>;

function normalizePostal(input: PostalInput): PostalValues {
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
    vatId: compactToNull(input.vatId),
    ...normalizeElectronicAddress(input),
    preferredFormat: oneOf(INVOICE_FORMATS, input.preferredFormat),
    defaultTaxCategory: oneOf(TAX_CATEGORIES, input.defaultTaxCategory),
  };
  return isIdentityEmpty(billing) ? null : billing;
}

/** Every business profile field with blanks collapsed. Never `null`. */
export function normalizeBusinessProfile(
  input: BusinessProfileFields | null | undefined,
): BusinessProfileValues {
  const source = input ?? {};
  return {
    ...normalizeIssuer(source),
    smallBusinessNote: blankToNull(source.smallBusinessNote),
    defaultTaxCategory: oneOf(TAX_CATEGORIES, source.defaultTaxCategory),
    defaultTaxRate:
      typeof source.defaultTaxRate === "number" && Number.isFinite(source.defaultTaxRate)
        ? source.defaultTaxRate
        : null,
  };
}

/**
 * The issuer half of a profile — every value that is a fact about the issuer,
 * none of the defaults that only steer a new invoice. Reads a stored snapshot
 * as well as a profile; keys an older snapshot lacks read as `null` / `false`.
 */
export function normalizeIssuer(input: BusinessProfileFields | null | undefined): InvoiceIssuer {
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
    vatId: compactToNull(source.vatId),
    taxNumber: blankToNull(source.taxNumber),
    registrationNumber: blankToNull(source.registrationNumber),
    sellerIdentifier: blankToNull(source.sellerIdentifier),
    contactName: blankToNull(source.contactName),
    ...normalizeElectronicAddress(source),
    iban: compactToNull(source.iban),
    bic: compactToNull(source.bic),
    bankName: blankToNull(source.bankName),
    accountHolder: blankToNull(source.accountHolder),
    smallBusiness: source.smallBusiness === true,
  };
}

/**
 * True when not one field carries a value. `false` counts as no value, so a
 * profile whose only "value" is an untouched checkbox is still empty.
 */
export function isIdentityEmpty(value: object): boolean {
  return Object.values(value).every((field) =>
    Array.isArray(field) ? field.length === 0 : field === null || field === false,
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
  const issuer = normalizeIssuer(profile);
  return isIdentityEmpty(issuer) ? null : withDefaultElectronicAddress(issuer);
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
  if (!normalized) return null;
  const { preferredFormat: _format, defaultTaxCategory: _category, ...party } = normalized;
  // A client whose only billing values are defaults has nothing to address.
  if (isIdentityEmpty(party)) return null;
  return withDefaultElectronicAddress({ name: clientName, ...party });
}

/** A stored recipient snapshot with blanks collapsed; keeps the name. */
export function normalizeRecipient(
  input: ClientBillingFields & { name: string },
): InvoiceRecipient {
  return {
    name: input.name,
    ...normalizePostal(input),
    reference: blankToNull(input.reference),
    vatId: compactToNull(input.vatId),
    ...normalizeElectronicAddress(input),
  };
}

/**
 * A party's electronic address, defaulted from its email when none was
 * entered: `electronicAddress = email`, scheme `EM`. Applied once, when a
 * snapshot is taken, so the XML reads the snapshot and derives nothing and a
 * fill copies the defaulted pair too. Pure.
 *
 * Only an email that passes the same check as a typed `EM` address: `email`
 * is free text, and "accounts (ask Anna)" must not ship as the delivery
 * address. Such a party keeps no address, and XRechnung then names the
 * missing field with a link to it.
 */
export function withDefaultElectronicAddress<
  T extends {
    email: string | null;
    electronicAddress: string | null;
    electronicAddressScheme: ElectronicAddressScheme | null;
  },
>(party: T): T {
  if (party.electronicAddress !== null || party.email === null) return party;
  if (!isValidElectronicAddress("EM", party.email)) return party;
  return { ...party, electronicAddress: party.email, electronicAddressScheme: "EM" };
}

/**
 * The stored values overlaid with every key of `input` that is not
 * `undefined`. A key left out keeps what is stored and `null` clears it, so a
 * stale tab, an older export file or an integrator on an older API version
 * cannot erase a field they never knew about.
 */
export function mergeIdentityInput<T extends object>(stored: T, input: Partial<T>): T {
  const merged: T = { ...stored };
  for (const key of Object.keys(input) as (keyof T)[]) {
    const value = input[key];
    if (value !== undefined) merged[key] = value as T[keyof T];
  }
  return merged;
}

/** BT-44: the recipient's registered name, falling back to its display name. */
export function recipientLegalName(recipient: Pick<InvoiceRecipient, "legalName" | "name">): string {
  return recipient.legalName ?? recipient.name;
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
