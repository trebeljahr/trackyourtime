/**
 * The invoice generator's data model, off the network.
 *
 * The public `/invoice-generator/` page is a form; this turns that form into
 * the exact `Invoice` wire object `invoices.create` would store, so the same
 * `@starter/invoice-pdf` renderer draws the same document a signed-in user
 * gets. Nothing here touches the DOM, the clock beyond a passed-in timestamp,
 * or the network — it is pure, so the mapping and the totals are unit-tested
 * without a browser and the draft round-trips through `localStorage` with the
 * storage layer stubbed.
 *
 * The arithmetic is not re-implemented: line amounts come from
 * `manualLineAmount` and the VAT breakdown and totals from
 * `computeEn16931Totals`, the same functions the server bills tracked time
 * with. A line the form has not finished (a blank price, a rate the schema
 * refuses) is left out of the built invoice, so a half-typed row never makes
 * the totals or the PDF disagree with the amount on screen.
 */
import {
  type Invoice,
  type InvoiceLineItem,
  type InvoiceLineUnit,
  type Locale,
  type TaxCategory,
  DEFAULT_EXEMPTION_NOTES,
  INVOICE_LINE_UNITS,
  TAX_CATEGORIES,
  ZERO_RATE_TAX_CATEGORIES,
  isManualLineKey,
  issuerSnapshot,
  manualLineAmount,
  manualLineQuantitySchema,
  manualLineUnitPriceSchema,
  recipientSnapshot,
  vatRateSchema,
} from "@starter/shared";
import type { RenderableInvoiceLogo } from "@starter/invoice-pdf/invoice-pdf";
import { computeEn16931Totals, type TaxedLine } from "@starter/invoice-pdf/totals";

/** The issuer half of the form: who sends the invoice. Every field is free text. */
export type IssuerForm = {
  legalName: string;
  addressLines: string;
  postalCode: string;
  city: string;
  country: string;
  vatId: string;
  taxNumber: string;
  email: string;
  phone: string;
  paymentDetails: string;
  paymentTermsDays: string;
};

/** The recipient half: who the invoice is addressed to. */
export type RecipientForm = {
  name: string;
  legalName: string;
  addressLines: string;
  postalCode: string;
  city: string;
  country: string;
  vatId: string;
  reference: string;
  email: string;
};

/** One line the person types. Numbers are strings while editing. */
export type LineForm = {
  /** Stable within the form; the invoice key is derived from it. */
  id: string;
  label: string;
  quantity: string;
  unit: InvoiceLineUnit;
  unitPrice: string;
  taxCategory: TaxCategory;
  vatRate: string;
};

/** The logo, once a file is chosen: a data URL for the draft plus the raw bytes to render. */
export type LogoState = { dataUrl: string; bytes: number[] } | null;

/** The whole form. Serialised to a draft as-is (the logo as a data URL). */
export type InvoiceForm = {
  issuer: IssuerForm;
  recipient: RecipientForm;
  number: string;
  issueDate: string;
  dueDate: string;
  currency: string;
  lines: LineForm[];
  notes: string;
  footer: string;
  logo: LogoState;
};

/** A blank issuer. */
export const emptyIssuer = (): IssuerForm => ({
  legalName: "",
  addressLines: "",
  postalCode: "",
  city: "",
  country: "",
  vatId: "",
  taxNumber: "",
  email: "",
  phone: "",
  paymentDetails: "",
  paymentTermsDays: "",
});

/** A blank recipient. */
export const emptyRecipient = (): RecipientForm => ({
  name: "",
  legalName: "",
  addressLines: "",
  postalCode: "",
  city: "",
  country: "",
  vatId: "",
  reference: "",
  email: "",
});

/** A blank line, standard-rate VAT so the common case needs no picking. */
export const emptyLine = (id: string): LineForm => ({
  id,
  label: "",
  quantity: "1",
  unit: "hour",
  unitPrice: "",
  taxCategory: "S",
  vatRate: "19",
});

/**
 * The empty form: what the page prerenders and what the first client render
 * shows before the draft loads. One blank line, so the table is never empty.
 */
export const emptyForm = (): InvoiceForm => ({
  issuer: emptyIssuer(),
  recipient: emptyRecipient(),
  number: "",
  issueDate: "",
  dueDate: "",
  currency: "EUR",
  lines: [emptyLine("line-1")],
  notes: "",
  footer: "",
  logo: null,
});

/** The currencies the picker offers. A three-letter ISO 4217 code prints in the PDF. */
export const GENERATOR_CURRENCIES = [
  "EUR",
  "USD",
  "GBP",
  "CHF",
  "CAD",
  "AUD",
  "SEK",
  "NOK",
  "DKK",
  "PLN",
  "JPY",
] as const;

const blank = (value: string): string | null => {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
};

/** Free text split into address lines, blank lines dropped. */
const toAddressLines = (value: string): string[] =>
  value
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");

/** A number a field holds, or null when it is blank or not a finite number. */
const toNumber = (value: string): number | null => {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
};

/** A whole non-negative count of days, or null. */
const toDays = (value: string): number | null => {
  const parsed = toNumber(value);
  return parsed !== null && Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
};

/** One line, validated: the amount and its VAT, or null when the row is not complete. */
export type ValidLine = {
  key: string;
  label: string;
  quantity: number;
  unit: InvoiceLineUnit;
  unitPrice: number;
  amount: number;
  taxCategory: TaxCategory;
  taxRate: number;
};

/**
 * A form line as a valid, priced line — or null when it cannot bill yet: no
 * label, a quantity or price the shared schema refuses, or a VAT rate that
 * does not fit the chosen category. The category/rate rule is the server's
 * `lineTaxSchema`: the standard rate needs a rate above 0, every other
 * category is 0 %.
 */
export function validateLine(line: LineForm): ValidLine | null {
  const label = line.label.trim();
  if (label === "") return null;
  const quantity = toNumber(line.quantity);
  const unitPrice = toNumber(line.unitPrice);
  if (quantity === null || unitPrice === null) return null;
  if (!manualLineQuantitySchema.safeParse(quantity).success) return null;
  if (!manualLineUnitPriceSchema.safeParse(unitPrice).success) return null;

  const category = TAX_CATEGORIES.includes(line.taxCategory) ? line.taxCategory : "S";
  const rate = category === "S" ? (toNumber(line.vatRate) ?? -1) : 0;
  if (!vatRateSchema.safeParse(rate).success) return null;
  if (category === "S" && !(rate > 0)) return null;

  const unit = INVOICE_LINE_UNITS.includes(line.unit) ? line.unit : "hour";
  return {
    key: manualKey(line.id),
    label,
    quantity,
    unit,
    unitPrice,
    amount: manualLineAmount(quantity, unitPrice),
    taxCategory: category,
    taxRate: rate,
  };
}

/** A form line id → a manual line key the invoice model recognises. */
function manualKey(id: string): string {
  const suffix = id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "line";
  const key = `manual:${suffix}`;
  return isManualLineKey(key) ? key : "manual:line";
}

/** The lines of the form that are complete enough to bill, in order. */
export function validLines(form: InvoiceForm): ValidLine[] {
  return form.lines.map(validateLine).filter((line): line is ValidLine => line !== null);
}

/** The totals of the valid lines: the numbers shown live and stored on the invoice. */
export type GeneratorTotals = ReturnType<typeof computeEn16931Totals>;

export function computeTotals(lines: readonly ValidLine[], locale: Locale): GeneratorTotals {
  const taxed: TaxedLine[] = lines.map((line) => ({
    amount: line.amount,
    taxCategory: line.taxCategory,
    taxRate: line.taxRate,
  }));
  // Default the exemption texts for the exempt categories from the invoice's
  // language, exactly as the server does at create time; S and Z carry none.
  const notes: Partial<Record<TaxCategory, string | null>> = {};
  for (const category of ZERO_RATE_TAX_CATEGORIES) {
    if (category === "Z") continue;
    notes[category] = DEFAULT_EXEMPTION_NOTES[locale][category];
  }
  return computeEn16931Totals(taxed, notes);
}

/**
 * The `Invoice` wire object the form describes, ready for `renderInvoicePdf`.
 *
 * The scoping fields an invoice carries in the database (`workspaceId`,
 * `createdBy`, `clientId`, `entryIds`) are placeholders: nothing is stored,
 * and the renderer reads none of them. Every field the PDF draws — the
 * parties, the lines, the totals, the language — is built from the form.
 */
export function buildInvoice(
  form: InvoiceForm,
  locale: Locale,
  generatedAt: string,
): Invoice & { issuer: (Invoice["issuer"] & { logo?: RenderableInvoiceLogo | null }) | null } {
  const lines = validLines(form);
  const totals = computeTotals(lines, locale);
  const currency = form.currency.trim().toUpperCase() || "EUR";

  const lineItems: InvoiceLineItem[] = lines.map((line) => ({
    key: line.key,
    label: line.label,
    projectId: null,
    taskId: null,
    kind: "manual",
    seconds: 0,
    hours: 0,
    hourlyRate: line.unitPrice,
    currency,
    amount: line.amount,
    quantity: line.quantity,
    unit: line.unit,
    unitPrice: line.unitPrice,
    taxCategory: line.taxCategory,
    taxRate: line.taxRate,
  }));

  // The rate all lines share, or null — the same value the invoice model's
  // `taxRate` carries and the PDF falls back to when there is no breakdown.
  const rates = new Set(lines.map((line) => line.taxRate));
  const commonRate = rates.size === 1 ? [...rates][0]! : null;

  const issuer = issuerSnapshot({
    legalName: form.issuer.legalName,
    addressLines: toAddressLines(form.issuer.addressLines),
    postalCode: form.issuer.postalCode,
    city: form.issuer.city,
    country: form.issuer.country,
    vatId: form.issuer.vatId,
    taxNumber: form.issuer.taxNumber,
    email: form.issuer.email,
    phone: form.issuer.phone,
    paymentDetails: form.issuer.paymentDetails,
    paymentTermsDays: toDays(form.issuer.paymentTermsDays),
  });

  const clientName = blank(form.recipient.name) ?? "";
  const recipient = recipientSnapshot(clientName, {
    legalName: form.recipient.legalName,
    addressLines: toAddressLines(form.recipient.addressLines),
    postalCode: form.recipient.postalCode,
    city: form.recipient.city,
    country: form.recipient.country,
    vatId: form.recipient.vatId,
    reference: form.recipient.reference,
    email: form.recipient.email,
  });

  const logo: RenderableInvoiceLogo | null =
    form.logo && form.logo.bytes.length > 0
      ? { data: Uint8Array.from(form.logo.bytes) }
      : null;

  return {
    id: "invoice-generator",
    workspaceId: "",
    createdBy: "",
    number: blank(form.number) ?? "DRAFT",
    clientId: "",
    clientName: clientName || recipient?.name || "—",
    status: "draft",
    issueDate: isoDate(form.issueDate, generatedAt),
    dueDate: isoDate(form.dueDate, form.issueDate || generatedAt),
    from: null,
    to: null,
    groupBy: "project",
    lineItems,
    subtotal: totals.subtotal,
    taxRate: commonRate,
    taxAmount: totals.taxAmount,
    total: totals.total,
    currency,
    entryIds: [],
    notes: blank(form.notes),
    locale,
    issuer: issuer ? { ...issuer, logo } : null,
    recipient,
    taxBreakdown: totals.breakdown.length > 0 ? totals.breakdown : undefined,
    paymentTerms: null,
    createdAt: generatedAt,
    updatedAt: generatedAt,
  };
}

/**
 * The draft persistence, storage injected so this file stays DOM-free and the
 * round trip is unit-tested with a stub. The page hands over `localStorage`;
 * every call is wrapped, because a private window throws on it and the tool
 * has to keep working without a saved draft.
 */
export const DRAFT_STORAGE_KEY = "trackyourtime.invoice-generator.draft";

/** The subset of the Storage API the draft uses. */
export type DraftStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

/** A stored value is only adopted when it has the shape the form expects. */
/**
 * One stored line, shape-checked. Every field a `LineForm` reads must be a
 * string, or `validateLine` would throw on it (`.trim()` on a non-string) and
 * white-screen the page as it restores the draft. A line that does not match
 * is enough to reject the whole draft — the app only ever writes well-formed
 * lines, so a malformed one means the stored value is not ours to trust.
 */
function isLineForm(value: unknown): value is LineForm {
  if (typeof value !== "object" || value === null) return false;
  const line = value as Partial<LineForm>;
  return (
    typeof line.id === "string" &&
    typeof line.label === "string" &&
    typeof line.quantity === "string" &&
    typeof line.unit === "string" &&
    typeof line.unitPrice === "string" &&
    typeof line.taxCategory === "string" &&
    typeof line.vatRate === "string"
  );
}

export function isInvoiceForm(value: unknown): value is InvoiceForm {
  if (typeof value !== "object" || value === null) return false;
  const form = value as Partial<InvoiceForm>;
  return (
    typeof form.issuer === "object" &&
    form.issuer !== null &&
    typeof form.recipient === "object" &&
    form.recipient !== null &&
    Array.isArray(form.lines) &&
    form.lines.every(isLineForm)
  );
}

/** Save the form as the draft. A storage failure is swallowed. */
export function writeDraft(storage: DraftStorage, form: InvoiceForm): void {
  try {
    storage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(form));
  } catch {
    // Private window, full quota, or storage disabled: no draft, no crash.
  }
}

/** The saved draft, or null when there is none or it cannot be read or parsed. */
export function readDraft(storage: DraftStorage): InvoiceForm | null {
  try {
    const raw = storage.getItem(DRAFT_STORAGE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as unknown;
    return isInvoiceForm(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Forget the saved draft. A storage failure is swallowed. */
export function removeDraft(storage: DraftStorage): void {
  try {
    storage.removeItem(DRAFT_STORAGE_KEY);
  } catch {
    // Nothing to do — the caller resets the form state either way.
  }
}

/** A form date (`YYYY-MM-DD`) as an ISO datetime at UTC midnight, or a fallback. */
function isoDate(value: string, fallbackIso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) {
    const parsed = new Date(fallbackIso);
    return Number.isNaN(parsed.getTime())
      ? new Date().toISOString()
      : `${fallbackIso.slice(0, 10)}T00:00:00.000Z`;
  }
  return `${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`;
}
