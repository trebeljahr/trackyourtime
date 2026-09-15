import {
  EINVOICE_ISSUE_CODES,
  EU_COUNTRY_CODES,
  bicInput,
  ibanInput,
  isValidElectronicAddress,
  lineTaxSchema,
  vatIdInput,
  withDefaultElectronicAddress,
  type BusinessProfile,
  type ClientBilling,
  type EinvoiceFixLocation,
  type EinvoiceIssue,
  type ElectronicAddressScheme,
  type LineTax,
  type TaxCategory,
} from "@starter/shared";

/*
 * Everything the e-invoice screens decide without a DOM.
 *
 * Validation here never has a regex of its own: identifiers run the SAME zod
 * pieces the server's schemas are built from (`vatIdInput`, `ibanInput`,
 * `bicInput`, `isValidElectronicAddress`), so the form and the server cannot
 * disagree about what a valid VAT ID or IBAN is.
 */

// ── identifier fields ────────────────────────────────────────────────

export type FieldErrorKey =
  | "vatId"
  | "iban"
  | "ibanChecksum"
  | "bic"
  | "electronicAddress"
  | "leitwegId"
  | "rate";

/** A value ready to send (compact, or null when blank), or the error to show inline. */
export type FieldCheck =
  | { ok: true; value: string | null }
  | { ok: false; errorKey: FieldErrorKey };

export type IdentifierField = "vatId" | "iban" | "bic";

/**
 * `maxLength` of the inputs for identifiers the server stores compact.
 *
 * These are limits for what a person pastes, spaces and dots included. The
 * shared `IDENTITY_LIMITS.vatId` (20) counts the compact form, so using it as
 * an input's maxLength would cut "NL 8594 3567 5B01" to a shorter id that
 * still parses, and save the wrong one without a word. Each stays within what
 * the shared schema accepts before compaction (limit + 20).
 */
export const IDENTIFIER_INPUT_MAX: Readonly<Record<IdentifierField, number>> = {
  vatId: 32,
  iban: 42,
  bic: 14,
};

const IDENTIFIER_SCHEMAS = { vatId: vatIdInput, iban: ibanInput, bic: bicInput } as const;

/** Check one identifier against its shared schema. Blank means "clear" (null). */
export function checkIdentifier(field: IdentifierField, raw: string): FieldCheck {
  if (raw.trim() === "") return { ok: true, value: null };
  const parsed = IDENTIFIER_SCHEMAS[field].safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data ?? null };
  if (field !== "iban") return { ok: false, errorKey: field };
  // The shape passes and the mod-97 refine fails: a typo, not a non-IBAN.
  const compact = raw.replace(/\s+/g, "").toUpperCase();
  return {
    ok: false,
    errorKey: /^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(compact) ? "ibanChecksum" : "iban",
  };
}

/** BT-34 / BT-49: the value against its scheme. Blank means "no address". */
export function checkElectronicAddress(
  scheme: ElectronicAddressScheme,
  raw: string,
): FieldCheck {
  const value = raw.trim();
  if (value === "") return { ok: true, value: null };
  if (isValidElectronicAddress(scheme, value)) return { ok: true, value };
  return { ok: false, errorKey: scheme === "0204" ? "leitwegId" : "electronicAddress" };
}

/** "DE02 1203 0000 0000 2020 51": groups of four, for display only. */
export function formatIbanForDisplay(iban: string | null): string {
  if (!iban) return "";
  return iban.replace(/\s+/g, "").replace(/(.{4})(?=.)/g, "$1 ");
}

export function isEuCountry(code: string | null): boolean {
  return code !== null && EU_COUNTRY_CODES.includes(code.toUpperCase());
}

// ── VAT choice ───────────────────────────────────────────────────────

/** The tax control's value. "Scustom" carries the typed rate; "unset" = no category (legacy path). */
export type TaxChoice =
  | { kind: "S19" }
  | { kind: "S7" }
  | { kind: "Scustom"; rate: string }
  | { kind: "Z" }
  | { kind: "E" }
  | { kind: "AE" }
  | { kind: "O" }
  | { kind: "unset" };

export type TaxChoiceKind = TaxChoice["kind"];

/** German presets for display only. The server never assumes either. */
export const STANDARD_RATE = 19;
export const REDUCED_RATE = 7;

export function lineTaxToTaxChoice(tax: LineTax | null): TaxChoice {
  if (tax === null) return { kind: "unset" };
  if (tax.category !== "S") return { kind: tax.category };
  if (tax.rate === STANDARD_RATE) return { kind: "S19" };
  if (tax.rate === REDUCED_RATE) return { kind: "S7" };
  return { kind: "Scustom", rate: String(tax.rate) };
}

/** The choice as a `LineTax`, checked by the shared schema. `unset` is `null`. */
export function taxChoiceToLineTax(
  choice: TaxChoice,
): { ok: true; tax: LineTax | null } | { ok: false; errorKey: "rate" } {
  switch (choice.kind) {
    case "unset":
      return { ok: true, tax: null };
    case "S19":
      return { ok: true, tax: { category: "S", rate: STANDARD_RATE } };
    case "S7":
      return { ok: true, tax: { category: "S", rate: REDUCED_RATE } };
    case "Scustom": {
      const trimmed = choice.rate.trim().replace(",", ".");
      const rate = trimmed === "" ? Number.NaN : Number(trimmed);
      if (!Number.isFinite(rate)) return { ok: false, errorKey: "rate" };
      const parsed = lineTaxSchema.safeParse({ category: "S", rate });
      return parsed.success ? { ok: true, tax: parsed.data } : { ok: false, errorKey: "rate" };
    }
    default:
      return { ok: true, tax: { category: choice.kind, rate: 0 } };
  }
}

/** Two choices mean the same tax (a custom "19" equals the 19 % preset). */
export function sameTaxChoice(a: TaxChoice, b: TaxChoice): boolean {
  const left = taxChoiceToLineTax(a);
  const right = taxChoiceToLineTax(b);
  if (!left.ok || !right.ok) return a.kind === b.kind;
  if (left.tax === null || right.tax === null) return left.tax === right.tax;
  return left.tax.category === right.tax.category && left.tax.rate === right.tax.rate;
}

/** Categories that need BT-120 text on the invoice. */
export function needsExemptionNote(category: TaxCategory): category is "E" | "AE" | "O" {
  return category === "E" || category === "AE" || category === "O";
}

/** Message key (under `tax.hint`) shown under the control, if any. */
export function taxChoiceHintKey(choice: TaxChoice): "AE" | "O" | "Z" | null {
  return choice.kind === "AE" || choice.kind === "O" || choice.kind === "Z" ? choice.kind : null;
}

/**
 * The category a client usually needs, from the countries alone — offered as
 * a one-click suggestion, never set silently. AE needs the buyer's VAT ID.
 */
export function suggestClientTaxCategory(
  sellerCountry: string | null,
  buyerCountry: string | null,
  hasVatId: boolean,
): "AE" | "O" | null {
  if (sellerCountry === null || buyerCountry === null) return null;
  const seller = sellerCountry.toUpperCase();
  const buyer = buyerCountry.toUpperCase();
  if (seller === "" || buyer === "" || seller === buyer) return null;
  if (isEuCountry(seller) && isEuCountry(buyer)) return hasVatId ? "AE" : null;
  if (isEuCountry(seller) && !isEuCountry(buyer)) return "O";
  return null;
}

// ── issues and deep links ────────────────────────────────────────────

const FIX_ORDER: readonly EinvoiceFixLocation[] = ["businessProfile", "clientBilling", "invoice"];

/** `"businessProfile.postalCode"` → `"postalCode"`; the input a deep link focuses. */
export function issueLeaf(field: string): string {
  const dot = field.indexOf(".");
  return dot === -1 ? field : field.slice(dot + 1);
}

/** Where a fix for this location lives, focused on `field` (main's model key). */
export function fixHref(
  fixIn: EinvoiceFixLocation,
  field: string,
  from: { invoiceId: string; clientId?: string | null },
): string | null {
  const leaf = encodeURIComponent(field);
  const back = `from=invoice:${encodeURIComponent(from.invoiceId)}`;
  switch (fixIn) {
    case "businessProfile":
      return `/app/settings?tab=billing&field=${leaf}&${back}`;
    case "clientBilling":
      return from.clientId
        ? `/app/clients?billing=${encodeURIComponent(from.clientId)}&field=${leaf}&${back}`
        : "/app/clients";
    case "invoice":
      return null;
  }
}

/** Deep link for an issue. null for `invoice` issues, which are handled in place. */
export function issueHref(issue: EinvoiceIssue, from: { invoiceId: string }): string | null {
  return fixHref(issue.fixIn, issueLeaf(issue.field), {
    invoiceId: from.invoiceId,
    clientId: issue.clientId ?? null,
  });
}

/** Fixed group order (profile, client, invoice); the server's order inside each group. */
export function groupIssues(
  issues: readonly EinvoiceIssue[],
): Array<{ fixIn: EinvoiceFixLocation; issues: EinvoiceIssue[] }> {
  return FIX_ORDER.map((fixIn) => ({
    fixIn,
    issues: issues.filter((issue) => issue.fixIn === fixIn),
  })).filter((group) => group.issues.length > 0);
}

const KNOWN_CODES: ReadonlySet<string> = new Set(EINVOICE_ISSUE_CODES);

export function isKnownIssueCode(code: string): code is EinvoiceIssue["code"] {
  return KNOWN_CODES.has(code);
}

/** 1-based line number an issue addresses (`invoice.lineItems[2].taxRate` → 3), or null. */
export function issueLineNumber(issue: EinvoiceIssue): number | null {
  const match = /lineItems\[(\d+)\]/.exec(issue.field);
  return match ? Number(match[1]) + 1 : null;
}

/** Codes whose server sentence carries figures: both totals, or "2 of 5 lines". */
const FIGURE_CODES: ReadonlySet<string> = new Set(["TOTALS_MISMATCH", "LINE_TAX_MISSING"]);

/**
 * Whether the server's sentence says more than the catalog text for its code:
 * it names one line, quotes a stored value ("XX" is not a country code, the
 * legacy tax ID to move), or states figures. The catalog text is per code and
 * cannot.
 */
export function serverMessageIsMorePrecise(issue: EinvoiceIssue): boolean {
  return (
    issueLineNumber(issue) !== null ||
    issue.message.includes('"') ||
    FIGURE_CODES.has(issue.code)
  );
}

/**
 * What an issue row says. English readers get the server's own sentence
 * whenever it is more precise; other languages get the catalog text, with the
 * line number kept, since an English sentence in a German screen is worse
 * than a shorter German one. A code this build does not know always shows the
 * server's sentence.
 */
export function issueDisplayText(
  issue: EinvoiceIssue,
  language: string,
  catalogText: (code: EinvoiceIssue["code"]) => string,
  withLine: (line: number, text: string) => string,
): string {
  if (!isKnownIssueCode(issue.code)) return issue.message;
  if (language === "en" && serverMessageIsMorePrecise(issue) && issue.message.trim() !== "") {
    return issue.message;
  }
  const text = catalogText(issue.code);
  const line = issueLineNumber(issue);
  return line === null ? text : withLine(line, text);
}

const SAFE_TOKEN = /^[A-Za-z0-9_-]{1,64}$/;

const safe = (value: string | null): string | null =>
  value !== null && SAFE_TOKEN.test(value) ? value : null;

/**
 * `?field=`, `?billing=` and `?from=invoice:<id>`. Strict on purpose: `field`
 * becomes a CSS attribute selector, so anything but `[A-Za-z0-9_-]` is dropped.
 */
export function parseDeepLink(search: string): {
  field: string | null;
  billingClientId: string | null;
  fromInvoiceId: string | null;
} {
  const params = new URLSearchParams(search);
  const from = params.get("from");
  const fromInvoiceId = from?.startsWith("invoice:") ? safe(from.slice("invoice:".length)) : null;
  return {
    field: safe(params.get("field")),
    billingClientId: safe(params.get("billing")),
    fromInvoiceId,
  };
}

/** The invoices screen with one invoice selected. */
export function invoiceHref(invoiceId: string): string {
  return `/app/invoices?invoice=${encodeURIComponent(invoiceId)}`;
}

// ── fill dialog ──────────────────────────────────────────────────────

/** Fill-path label keys under `fill.fieldLabels`. Keys cannot contain ".", so paths are flattened. */
export const FILL_FIELD_LABEL_KEYS = [
  "issuer",
  "recipient",
  "issuerLegalName",
  "issuerAddressLines",
  "issuerPostalCode",
  "issuerCity",
  "issuerCountry",
  "issuerTaxId",
  "issuerEmail",
  "issuerPhone",
  "issuerWebsite",
  "issuerPaymentDetails",
  "issuerInvoiceFooter",
  "issuerVatId",
  "issuerTaxNumber",
  "issuerRegistrationNumber",
  "issuerSellerIdentifier",
  "issuerContactName",
  "issuerElectronicAddress",
  "issuerIban",
  "issuerBic",
  "issuerBankName",
  "issuerAccountHolder",
  "recipientLegalName",
  "recipientAddressLines",
  "recipientPostalCode",
  "recipientCity",
  "recipientCountry",
  "recipientTaxId",
  "recipientEmail",
  "recipientReference",
  "recipientVatId",
  "recipientElectronicAddress",
  "lineTax",
  "taxBreakdown",
  "exemptionReason",
  "paymentTerms",
] as const;
export type FillFieldLabelKey = (typeof FILL_FIELD_LABEL_KEYS)[number];

const LABEL_KEYS: ReadonlySet<string> = new Set(FILL_FIELD_LABEL_KEYS);

const capitalise = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

/**
 * `"issuer"` → `issuer`; `"recipient.postalCode"` → `recipientPostalCode`;
 * `"lineItems[*].taxCategory"` → `lineTax`. Unknown → null (the raw path is shown).
 */
export function fillFieldLabelKey(path: string): FillFieldLabelKey | null {
  if (path.startsWith("lineItems")) return "lineTax";
  if (/^taxBreakdown\[\d+\]\.exemptionReason$/.test(path)) return "exemptionReason";
  const [party, key, ...rest] = path.split(".");
  if (rest.length > 0 || party === undefined) return null;
  const flat = key === undefined ? party : `${party}${capitalise(key)}`;
  return LABEL_KEYS.has(flat) ? (flat as FillFieldLabelKey) : null;
}

export type FillSource = "profile" | "client" | "invoice";

/** Which party a fill path copies from, and the model key its edit link focuses. */
export function fillPathTarget(
  path: string,
): { source: FillSource; fixIn: EinvoiceFixLocation; field: string } | null {
  const [party, key] = path.split(".");
  if (party === "issuer") {
    return { source: "profile", fixIn: "businessProfile", field: key ?? "legalName" };
  }
  if (party === "recipient") {
    return { source: "client", fixIn: "clientBilling", field: key ?? "legalName" };
  }
  if (path === "paymentTerms") return { source: "invoice", fixIn: "invoice", field: "paymentTerms" };
  return null;
}

const joinLines = (lines: ReadonlyArray<string | null | undefined>, separator = "\n"): string | null => {
  const kept = lines.filter((line): line is string => typeof line === "string" && line.trim() !== "");
  return kept.length > 0 ? kept.join(separator) : null;
};

type PartyValues = {
  legalName: string | null;
  addressLines: readonly string[];
  postalCode: string | null;
  city: string | null;
  country: string | null;
  vatId: string | null;
};

const partyBlock = (party: PartyValues, fallbackName: string | null): string | null =>
  joinLines([
    party.legalName ?? fallbackName,
    ...party.addressLines,
    joinLines([party.postalCode, party.city], " "),
    party.country,
    party.vatId,
  ]);

const leafText = (record: Record<string, unknown>, key: string): string | null => {
  const value = record[key];
  if (Array.isArray(value)) return joinLines(value.map(String));
  return typeof value === "string" ? value : null;
};

/**
 * The value a fill path WILL copy, from today's profile or client billing —
 * with the electronic address defaulted from the email exactly as the
 * snapshot does it. `value: null` means there is nothing to copy (or the
 * client is gone); null overall means the path is not a copied value.
 */
export function fillSourceValue(
  path: string,
  profile: BusinessProfile,
  clientBilling: ClientBilling | null,
  clientName: string,
): { source: FillSource; value: string | null } | null {
  const target = fillPathTarget(path);
  if (target === null || target.source === "invoice") return null;
  const key = path.includes(".") ? target.field : null;
  if (target.source === "profile") {
    const issuer = withDefaultElectronicAddress(profile);
    if (key === null) return { source: "profile", value: partyBlock(issuer, null) };
    return { source: "profile", value: leafText(issuer, key) };
  }
  if (clientBilling === null) return { source: "client", value: null };
  const recipient = withDefaultElectronicAddress(clientBilling);
  if (key === null) return { source: "client", value: partyBlock(recipient, clientName) };
  if (key === "legalName") return { source: "client", value: recipient.legalName ?? clientName };
  return { source: "client", value: leafText(recipient, key) };
}
