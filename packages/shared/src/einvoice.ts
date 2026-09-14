/**
 * EN 16931 e-invoicing: the vocabulary every surface shares.
 *
 * ZUGFeRD (EN 16931 profile) and XRechnung 3.0 are two serialisations of one
 * data model, so the categories, the issue codes and the field rules live here
 * once. The business profile and the client's billing details themselves are
 * main's `BusinessProfile` / `ClientBilling` (types.ts), extended with the
 * fields EN 16931 needs; this file only supplies their format checks.
 *
 * Imports only `zod` and `./locale.js`. `schemas.ts`, `types.ts` and
 * `business-identity.ts` import from here, never the reverse, so there is no
 * module cycle.
 */
import { z } from "zod";

import type { Locale } from "./locale.js";

const idString = z.string().min(1);
const originId = z.string().max(64).optional();

// ── categories, formats, profiles ────────────────────────────────────

/** UNCL5305 VAT category codes this app issues (BT-118 / BT-151). */
export const TAX_CATEGORIES = ["S", "Z", "E", "AE", "O"] as const;
export type TaxCategory = (typeof TAX_CATEGORIES)[number];
export const taxCategorySchema = z.enum(TAX_CATEGORIES);

/** Categories whose rate must be 0. S is the only one with a positive rate. */
export const ZERO_RATE_TAX_CATEGORIES = ["Z", "E", "AE", "O"] as const;
export type ZeroRateTaxCategory = (typeof ZERO_RATE_TAX_CATEGORIES)[number];
export const zeroRateTaxCategorySchema = z.enum(ZERO_RATE_TAX_CATEGORIES);

/** Categories that carry an exemption reason (BT-120). */
export const EXEMPTION_NOTE_CATEGORIES = ["E", "AE", "O"] as const;
export type ExemptionNoteCategory = (typeof EXEMPTION_NOTE_CATEGORIES)[number];

/** How a client prefers to receive invoices. `null` on the client means "pdf". */
export const INVOICE_FORMATS = ["pdf", "zugferd", "xrechnung"] as const;
export type InvoiceFormat = (typeof INVOICE_FORMATS)[number];
export const invoiceFormatSchema = z.enum(INVOICE_FORMATS);

/** The two validation/serialisation profiles. Only BT-24 and the rule set differ. */
export const EINVOICE_PROFILES = ["en16931", "xrechnung"] as const;
export type EinvoiceProfile = (typeof EINVOICE_PROFILES)[number];
export const einvoiceProfileSchema = z.enum(EINVOICE_PROFILES);

/** EAS codes accepted for BT-34 / BT-49. EM = email, 0204 = Leitweg-ID, 9930 = DE VAT, 0088 = GLN. */
export const ELECTRONIC_ADDRESS_SCHEMES = ["EM", "0204", "9930", "0088"] as const;
export type ElectronicAddressScheme = (typeof ELECTRONIC_ADDRESS_SCHEMES)[number];
export const electronicAddressSchemeSchema = z.enum(ELECTRONIC_ADDRESS_SCHEMES);

/** VATEX code written as BT-121, per category. null = none emitted. */
export const VATEX_CODES: Readonly<Record<TaxCategory, string | null>> = {
  S: null,
  Z: null,
  E: null,
  AE: "VATEX-EU-AE",
  O: "VATEX-EU-O",
};

/**
 * Default BT-120 texts, chosen by the invoice's language at create or fill and
 * then snapshotted. E is the § 19 UStG text and applies only to a small
 * business; any other exempt line needs a text the user writes.
 */
export const DEFAULT_EXEMPTION_NOTES: Readonly<
  Record<Locale, Readonly<Record<ExemptionNoteCategory, string>>>
> = {
  de: {
    E: "Kein Ausweis von Umsatzsteuer, da Kleinunternehmer gemäß § 19 UStG.",
    AE: "Steuerschuldnerschaft des Leistungsempfängers (Reverse Charge).",
    O: "Nicht im Inland steuerbare Leistung.",
  },
  en: {
    E: "No VAT is shown: small business exemption under § 19 UStG.",
    AE: "Reverse charge: VAT is payable by the recipient.",
    O: "Service not subject to German VAT.",
  },
};

/**
 * Maximum lengths of every identity field, keyed by main's field names, so the
 * forms, the zod schemas and the mongoose models use one number each.
 */
export const IDENTITY_LIMITS = {
  legalName: 200,
  addressLine: 200,
  postalCode: 20,
  city: 120,
  taxId: 60,
  email: 254,
  phone: 40,
  website: 200,
  paymentDetails: 1_000,
  reference: 120,
  invoiceFooter: 500,
  vatId: 20,
  taxNumber: 40,
  registrationNumber: 100,
  sellerIdentifier: 100,
  contactName: 120,
  electronicAddress: 200,
  iban: 42,
  bic: 11,
  bankName: 120,
  accountHolder: 200,
  smallBusinessNote: 500,
  exemptionNote: 500,
  paymentTerms: 500,
} as const;

// ── countries ──────────────────────────────────────────────────────

/** ISO 3166-1 alpha-2, all 249 officially assigned codes (BR-CL-14). */
export const COUNTRY_CODES: readonly string[] = [
  "AD", "AE", "AF", "AG", "AI", "AL", "AM", "AO", "AQ", "AR", "AS", "AT",
  "AU", "AW", "AX", "AZ", "BA", "BB", "BD", "BE", "BF", "BG", "BH", "BI",
  "BJ", "BL", "BM", "BN", "BO", "BQ", "BR", "BS", "BT", "BV", "BW", "BY",
  "BZ", "CA", "CC", "CD", "CF", "CG", "CH", "CI", "CK", "CL", "CM", "CN",
  "CO", "CR", "CU", "CV", "CW", "CX", "CY", "CZ", "DE", "DJ", "DK", "DM",
  "DO", "DZ", "EC", "EE", "EG", "EH", "ER", "ES", "ET", "FI", "FJ", "FK",
  "FM", "FO", "FR", "GA", "GB", "GD", "GE", "GF", "GG", "GH", "GI", "GL",
  "GM", "GN", "GP", "GQ", "GR", "GS", "GT", "GU", "GW", "GY", "HK", "HM",
  "HN", "HR", "HT", "HU", "ID", "IE", "IL", "IM", "IN", "IO", "IQ", "IR",
  "IS", "IT", "JE", "JM", "JO", "JP", "KE", "KG", "KH", "KI", "KM", "KN",
  "KP", "KR", "KW", "KY", "KZ", "LA", "LB", "LC", "LI", "LK", "LR", "LS",
  "LT", "LU", "LV", "LY", "MA", "MC", "MD", "ME", "MF", "MG", "MH", "MK",
  "ML", "MM", "MN", "MO", "MP", "MQ", "MR", "MS", "MT", "MU", "MV", "MW",
  "MX", "MY", "MZ", "NA", "NC", "NE", "NF", "NG", "NI", "NL", "NO", "NP",
  "NR", "NU", "NZ", "OM", "PA", "PE", "PF", "PG", "PH", "PK", "PL", "PM",
  "PN", "PR", "PS", "PT", "PW", "PY", "QA", "RE", "RO", "RS", "RU", "RW",
  "SA", "SB", "SC", "SD", "SE", "SG", "SH", "SI", "SJ", "SK", "SL", "SM",
  "SN", "SO", "SR", "SS", "ST", "SV", "SX", "SY", "SZ", "TC", "TD", "TF",
  "TG", "TH", "TJ", "TK", "TL", "TM", "TN", "TO", "TR", "TT", "TV", "TW",
  "TZ", "UA", "UG", "UM", "US", "UY", "UZ", "VA", "VC", "VE", "VG", "VI",
  "VN", "VU", "WF", "WS", "YE", "YT", "ZA", "ZM", "ZW",
];

const COUNTRY_CODE_SET: ReadonlySet<string> = new Set(COUNTRY_CODES);

/** True for an assigned ISO 3166-1 alpha-2 code, upper case. */
export function isCountryCode(value: string): boolean {
  return COUNTRY_CODE_SET.has(value);
}

/** EU-27 member states (ISO codes; Greece is "GR" here, "EL" only as a VAT prefix). */
export const EU_COUNTRY_CODES: readonly string[] = [
  "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR", "HR", "HU",
  "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK",
];

// ── field formats ────────────────────────────────────────────────────

/** Removes every whitespace character and upper-cases: "de 123 456 789" → "DE123456789". */
export function stripSpacesUpper(value: string): string {
  return value.replace(/\s+/g, "").toUpperCase();
}

/** BR-CO-09 shape: two-letter prefix, then 2–12 characters. */
export const VAT_ID_PATTERN = /^[A-Z]{2}[0-9A-Z+*.]{2,12}$/;
const IBAN_PATTERN = /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/;
const BIC_PATTERN = /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/;
const LEITWEG_PATTERN = /^[0-9A-Za-z-]{1,200}$/;
const GLN_PATTERN = /^\d{13}$/;

/** ISO 13616 mod-97 check. Expects the compact form (see {@link stripSpacesUpper}). */
export function isValidIban(iban: string): boolean {
  if (!IBAN_PATTERN.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const code = char.charCodeAt(0);
    // Letters count as two digits (A = 10 … Z = 35), digits as one.
    const digits = code >= 65 ? String(code - 55) : char;
    for (const digit of digits) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }
  return remainder === 1;
}

export function isValidVatId(value: string): boolean {
  return VAT_ID_PATTERN.test(value);
}

export function isValidBic(value: string): boolean {
  return BIC_PATTERN.test(value);
}

/** The value rule of each electronic address scheme (BT-34 / BT-49). */
export function isValidElectronicAddress(
  scheme: ElectronicAddressScheme,
  value: string,
): boolean {
  if (value.length === 0 || value.length > IDENTITY_LIMITS.electronicAddress) return false;
  switch (scheme) {
    case "EM":
      return z.email().safeParse(value).success;
    case "0204":
      return LEITWEG_PATTERN.test(value);
    case "9930":
      return VAT_ID_PATTERN.test(value);
    case "0088":
      return GLN_PATTERN.test(value);
  }
}

/**
 * A compact-formatted identifier field for a form: blank (or null, or absent)
 * is `null`; anything else is stripped of spaces, upper-cased and checked.
 */
const compactIdInput = (pattern: RegExp, message: string, max: number) =>
  z
    .string()
    .max(max + 20)
    .transform((value): string | null => {
      const compact = stripSpacesUpper(value);
      return compact === "" ? null : compact;
    })
    .pipe(z.string().max(max).regex(pattern, message).nullable())
    .nullish();

/** BT-31 / BT-48. */
export const vatIdInput = compactIdInput(
  VAT_ID_PATTERN,
  "VAT ID must start with a country prefix, e.g. DE123456789",
  IDENTITY_LIMITS.vatId,
);

/** BT-84, mod-97 checked. */
export const ibanInput = z
  .string()
  .max(IDENTITY_LIMITS.iban + 20)
  .transform((value): string | null => {
    const compact = stripSpacesUpper(value);
    return compact === "" ? null : compact;
  })
  .pipe(
    z
      .string()
      .max(IDENTITY_LIMITS.iban)
      .refine(isValidIban, "IBAN is not valid: check the country code and the check digits")
      .nullable(),
  )
  .nullish();

/** BT-86. */
export const bicInput = compactIdInput(
  BIC_PATTERN,
  "BIC must have 8 or 11 characters, e.g. BYLADEM1001",
  IDENTITY_LIMITS.bic,
);

/** VAT percent with at most 2 decimals (so cents × basis points stays an exact integer). */
export const vatRateSchema = z
  .number()
  .min(0)
  .max(100)
  .refine((rate) => Math.abs(Math.round(rate * 100) - rate * 100) < 1e-9, "At most 2 decimals");

/** Free text where blank means `null`. */
const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .transform((value): string | null => {
      const trimmed = value.trim();
      return trimmed === "" ? null : trimmed;
    })
    .nullish();

// ── cross-field rules ────────────────────────────────────────────────

/** One refusal of a cross-field rule, addressed to the input that must change. */
export type IdentityProblem = { path: string; message: string };

type TextLike = string | null | undefined;

const isBlank = (value: TextLike): boolean =>
  typeof value !== "string" || value.trim() === "";

/**
 * Electronic address pairing. With `partial`, a rule is checked only when the
 * keys it relates are both present — the merged row is checked again on save.
 */
export function electronicAddressProblems(
  value: { electronicAddress?: TextLike; electronicAddressScheme?: ElectronicAddressScheme | null },
  partial: boolean,
): IdentityProblem[] {
  if (isBlank(value.electronicAddress)) return [];
  const address = (value.electronicAddress as string).trim();
  if (value.electronicAddressScheme === undefined && partial) return [];
  if (!value.electronicAddressScheme) {
    return [
      {
        path: "electronicAddressScheme",
        message: "Choose the kind of electronic address (email, Leitweg-ID, VAT ID or GLN)",
      },
    ];
  }
  if (!isValidElectronicAddress(value.electronicAddressScheme, address)) {
    return [
      {
        path: "electronicAddress",
        message: electronicAddressMessage(value.electronicAddressScheme),
      },
    ];
  }
  return [];
}

function electronicAddressMessage(scheme: ElectronicAddressScheme): string {
  switch (scheme) {
    case "EM":
      return "The electronic address must be an email address";
    case "0204":
      return "A Leitweg-ID has only digits, letters and hyphens, e.g. 991-12345-06";
    case "9930":
      return "The electronic address must be a VAT ID, e.g. DE123456789";
    case "0088":
      return "A GLN has exactly 13 digits";
  }
}

/** Object-level refine used by the profile and client billing schemas (partial input). */
export function refineElectronicAddress(
  value: { electronicAddress?: TextLike; electronicAddressScheme?: ElectronicAddressScheme | null },
  ctx: z.RefinementCtx,
): void {
  addProblems(ctx, electronicAddressProblems(value, true));
}

/** The shape the business profile's e-invoice rules read. */
export type ProfileEinvoiceRuleInput = {
  electronicAddress?: TextLike;
  electronicAddressScheme?: ElectronicAddressScheme | null;
  smallBusiness?: boolean | null;
  defaultTaxCategory?: TaxCategory | null;
  defaultTaxRate?: number | null;
};

/**
 * The business profile's cross-field rules: electronic address pairing, a
 * default category that agrees with its rate, and a small business that
 * defaults to E. `partial` as in {@link electronicAddressProblems}.
 */
export function businessProfileProblems(
  value: ProfileEinvoiceRuleInput,
  partial: boolean,
): IdentityProblem[] {
  const problems = electronicAddressProblems(value, partial);
  const category = value.defaultTaxCategory;
  const rate = value.defaultTaxRate;
  const bothKnown = !partial || (category !== undefined && rate !== undefined);
  if (bothKnown && category === "S" && !(typeof rate === "number" && rate > 0)) {
    problems.push({
      path: "defaultTaxRate",
      message: "The standard rate needs a VAT rate above 0 %",
    });
  }
  if (bothKnown && category && category !== "S" && typeof rate === "number" && rate !== 0) {
    problems.push({
      path: "defaultTaxRate",
      message: "Only the standard rate has a VAT rate; every other category is 0 %",
    });
  }
  const smallKnown = !partial || (value.smallBusiness !== undefined && category !== undefined);
  if (smallKnown && value.smallBusiness === true && category && category !== "E") {
    problems.push({
      path: "defaultTaxCategory",
      message: "A small business under § 19 UStG invoices without VAT: use category E (exempt)",
    });
  }
  return problems;
}

/** Zod adapter for {@link businessProfileProblems} on a partial input. */
export function refineBusinessProfileEinvoice(
  value: ProfileEinvoiceRuleInput,
  ctx: z.RefinementCtx,
): void {
  addProblems(ctx, businessProfileProblems(value, true));
}

function addProblems(ctx: z.RefinementCtx, problems: readonly IdentityProblem[]): void {
  for (const problem of problems) {
    ctx.addIssue({ code: "custom", message: problem.message, path: [problem.path] });
  }
}

// ── per-line tax, breakdown, notes ───────────────────────────────────

/** S → rate > 0. Every other category → rate === 0. */
export const lineTaxSchema = z
  .object({ category: taxCategorySchema, rate: vatRateSchema })
  .refine((tax) => (tax.category === "S" ? tax.rate > 0 : tax.rate === 0), {
    message: "Standard rate needs a rate above 0; every other category is 0 %",
    path: ["rate"],
  });
export type LineTax = z.infer<typeof lineTaxSchema>;

/** BT-120 texts per category, as entered for one invoice. Blank is `null`. */
export const exemptionNotesSchema = z
  .object({
    E: optionalText(IDENTITY_LIMITS.exemptionNote),
    AE: optionalText(IDENTITY_LIMITS.exemptionNote),
    O: optionalText(IDENTITY_LIMITS.exemptionNote),
  })
  .partial();
export type ExemptionNotes = z.infer<typeof exemptionNotesSchema>;

/** One BG-23 row, stored on the invoice at creation. Amounts are 2-dp numbers (from integer cents). */
export type TaxBreakdownRow = {
  category: TaxCategory;
  /** Percent; 0 for Z/E/AE/O. */
  rate: number;
  /** BT-116. */
  basisAmount: number;
  /** BT-117. */
  taxAmount: number;
  /** BT-120. */
  exemptionReason: string | null;
  /** BT-121 ({@link VATEX_CODES}). */
  exemptionReasonCode: string | null;
};

/** Audit record of one attachEinvoiceData call. */
export type EinvoiceFill = {
  /** ISO datetime. */
  at: string;
  /** User id. */
  by: string;
  /** Dotted paths filled, e.g. "issuer", "recipient.postalCode", "lineItems[*].taxCategory". */
  fields: string[];
};

// ── issues ───────────────────────────────────────────────────────────

/** Where the user fixes an issue: the settings business profile, the client's billing details, or the invoice itself. */
export const EINVOICE_FIX_LOCATIONS = ["businessProfile", "clientBilling", "invoice"] as const;
export type EinvoiceFixLocation = (typeof EINVOICE_FIX_LOCATIONS)[number];

/** Every refusal, in the order validation reports them. */
export const EINVOICE_ISSUE_CODES = [
  "NO_LINES",
  "SELLER_SNAPSHOT_MISSING",
  "SELLER_LEGAL_NAME_MISSING",
  "SELLER_STREET_MISSING",
  "SELLER_POSTCODE_MISSING",
  "SELLER_CITY_MISSING",
  "SELLER_COUNTRY_MISSING",
  "SELLER_COUNTRY_INVALID",
  "SELLER_TAX_ID_UNCLASSIFIED",
  "SELLER_TAX_ID_MISSING",
  "SELLER_VAT_ID_REQUIRED",
  "SELLER_IDENTIFIER_REQUIRED",
  "SELLER_CONTACT_NAME_MISSING",
  "SELLER_CONTACT_PHONE_MISSING",
  "SELLER_CONTACT_EMAIL_MISSING",
  "SELLER_ELECTRONIC_ADDRESS_MISSING",
  "SELLER_IBAN_MISSING",
  "BUYER_SNAPSHOT_MISSING",
  "BUYER_STREET_MISSING",
  "BUYER_POSTCODE_MISSING",
  "BUYER_CITY_MISSING",
  "BUYER_COUNTRY_MISSING",
  "BUYER_COUNTRY_INVALID",
  "BUYER_VAT_ID_REQUIRED",
  "BUYER_REFERENCE_MISSING",
  "BUYER_ELECTRONIC_ADDRESS_MISSING",
  "LINE_TAX_MISSING",
  "LINE_TAX_RATE_INVALID",
  "CATEGORY_O_MIXED",
  "EXEMPTION_NOTE_MISSING",
  "CURRENCY_INVALID",
  "LINE_CURRENCY_MISMATCH",
  "LINE_AMOUNT_INCONSISTENT",
  "BREAKDOWN_MISMATCH",
  "TOTALS_MISMATCH",
] as const;
export type EinvoiceIssueCode = (typeof EINVOICE_ISSUE_CODES)[number];

/**
 * Codes no fill can resolve: the amounts, lines or a stored snapshot value are
 * frozen. The client hides the fix link for these and offers the plain PDF.
 */
export const UNFIXABLE_EINVOICE_ISSUE_CODES: ReadonlySet<EinvoiceIssueCode> = new Set<EinvoiceIssueCode>([
  "NO_LINES",
  "SELLER_COUNTRY_INVALID",
  "BUYER_COUNTRY_INVALID",
  "LINE_TAX_RATE_INVALID",
  "CATEGORY_O_MIXED",
  "CURRENCY_INVALID",
  "LINE_CURRENCY_MISMATCH",
  "LINE_AMOUNT_INCONSISTENT",
  "BREAKDOWN_MISMATCH",
  "TOTALS_MISMATCH",
]);

export type EinvoiceIssue = {
  code: EinvoiceIssueCode;
  /**
   * Dotted path of the exact input: "businessProfile.postalCode",
   * "clientBilling.reference", "invoice.lineItems[2].taxRate", "invoice.issuer".
   * After the first dot it is main's model key, which the client uses as the
   * `data-field` of the input to focus.
   */
  field: string;
  /** English sentence naming the field and where to fix it. The client may localise by `code`. */
  message: string;
  fixIn: EinvoiceFixLocation;
  /** EN 16931 / XRechnung / § UStG rule id, e.g. "BR-DE-15". */
  rule: string | null;
  /** Set when fixIn === "clientBilling", so the UI can link to that client. */
  clientId?: string;
};

export const einvoiceCheckSchema = z.object({ id: idString, profile: einvoiceProfileSchema });
export type EinvoiceCheckInput = z.infer<typeof einvoiceCheckSchema>;

export type TotalsMismatch = {
  stored: { subtotal: number; taxAmount: number; total: number };
  recomputed: { subtotal: number; taxAmount: number; total: number };
};

/** How line categories of an invoice can be filled. */
export type FillLineTax = "fixed" | "choose" | "none" | "inconsistent";

/** What attachEinvoiceData would do right now, from current profile and client data. */
export type EinvoiceFillPreview = {
  /** Same paths as {@link EinvoiceFill.fields}. */
  fields: string[];
  /**
   * "fixed" when a legacy invoice's taxRate > 0 (all S), "choose" when it is
   * 0 or null, "none" when every line already has a category, "inconsistent"
   * when only some do (nothing can be filled).
   */
  lineTax: FillLineTax;
  /** Set when lineTax === "fixed". */
  fixedTax: LineTax | null;
  /** Totals after the fill; non-null means attach will be refused. */
  mismatch: TotalsMismatch | null;
};

export type EinvoiceCheckResult = {
  /** issues.length === 0. */
  ready: boolean;
  /** Against the invoice as stored. */
  issues: EinvoiceIssue[];
  /** null when nothing can be filled. */
  fill: EinvoiceFillPreview | null;
  /** Issues left if the fill were applied (with lineTax "choose" assumed resolved). */
  issuesAfterFill: EinvoiceIssue[];
  /** From `Client.billing.preferredFormat`, for the default button. */
  preferredFormat: InvoiceFormat | null;
  /** A stored issued XML exists for this profile: the export serves it, and ready is true. */
  hasIssuedXml: boolean;
  /**
   * An issued XML exists for either profile. The snapshot is then final: a
   * fill would change the visible PDF around the stored XML, so `fill` is null
   * and attachEinvoiceData refuses with FILL_LOCKED_BY_ISSUED_XML.
   */
  fillLocked: boolean;
};

/**
 * Why attachEinvoiceData refused without issues. Carried in
 * `error.data.einvoiceFillRefusal`, so the client shows catalog text rather
 * than the server's English message.
 */
export const EINVOICE_FILL_REFUSAL_CODES = [
  /** An e-invoice was already issued from this snapshot. */
  "FILL_LOCKED_BY_ISSUED_XML",
  /** The invoice has a tax rate above 0, so no zero-rate category applies. */
  "FILL_CATEGORY_NOT_APPLICABLE",
  /** The 0 % lines need a category choice. */
  "FILL_CATEGORY_REQUIRED",
] as const;
export type EinvoiceFillRefusalCode = (typeof EINVOICE_FILL_REFUSAL_CODES)[number];

export const attachEinvoiceDataSchema = z.object({
  id: idString,
  /** Must be true: the user confirmed filling from CURRENT profile and client data. */
  confirm: z.literal(true),
  /** Required iff fill.lineTax === "choose". */
  zeroRateCategory: zeroRateTaxCategorySchema.optional(),
  exemptionNotes: exemptionNotesSchema.optional(),
  originId,
});
export type AttachEinvoiceDataInput = z.infer<typeof attachEinvoiceDataSchema>;

export const einvoiceExportSchema = z.object({ id: idString });
export type EinvoiceExportInput = z.infer<typeof einvoiceExportSchema>;

export type EinvoiceExportResult = {
  filename: string;
  base64: string;
  mimeType: "application/pdf" | "application/xml";
};
