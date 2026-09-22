import { addDays, format, parseISO } from "date-fns";
import {
  lineKind,
  lineQuantity,
  lineUnit,
  type ExemptionNotes,
  type Invoice,
  type InvoiceLineItem,
  type InvoiceLineLike,
  type InvoiceStatus,
  type LineTax,
  type TaxBreakdownRow,
  type TaxCategory,
} from "@starter/shared";

import { translate } from "@/i18n/translate";

import type { ClientLocale } from "@/i18n/config";
import {
  DATE_STYLES,
  formatDate as formatLocaleDate,
  formatDecimal,
  formatNumber,
  intlLocale,
} from "@/i18n/format";
import { getActiveLocale } from "@/i18n/locale-store";
import { getTranslator } from "@/i18n/translator";

/**
 * Every display helper below takes the locale last and defaults it to the one
 * rendering now. Components pass `useLocale()`, so a language switch
 * re-renders their text; tests and plain callers read English.
 */
const reportsT = (locale: ClientLocale) => getTranslator(locale, "reports");

/**
 * The shapes and the rules the invoicing screens draw from.
 *
 * The router's own output types live behind `@starter/server/trpc`, which only
 * re-exports `AppRouter`, so — exactly as `components/catalog/types.ts` does —
 * the wire shapes are mirrored structurally here rather than imported. The
 * rules below are duplicated from the server ON PURPOSE and must stay in step
 * with it: the server is the authority, and every one of these functions only
 * decides what the UI is allowed to OFFER. Offering a move the server would
 * reject is a dead-end button; hiding one it would accept is a missing
 * feature. Both are caught by `types.test.ts`.
 */

/** An invoice exactly as `invoices.list` / `invoices.get` return it. */
export type InvoiceRow = Invoice;

export type InvoiceGroupBy = Invoice["groupBy"];

/** Mirrors the server's `InvoicePreview` — a dry run with nothing written. */
export type InvoicePreviewData = {
  clientId: string;
  clientName: string;
  groupBy: InvoiceGroupBy;
  lineItems: InvoiceLineItem[];
  subtotal: number;
  taxRate: number | null;
  taxAmount: number;
  total: number;
  currency: string;
  /** The entries that would be billed. Empty means there is nothing to bill. */
  entryIds: string[];
  suggestedNumber: string;
  /** Billable time in range carrying no rate — cannot be invoiced. */
  skippedMissingRate: number;
  /** Time in range already billed on an earlier invoice. */
  skippedInvoiced: number;
  /** One row per VAT category and rate; null when the lines carry no category. */
  taxBreakdown: TaxBreakdownRow[] | null;
  /** The category and rate per line that create would stamp; null = unresolved. */
  resolvedTax: { lines: Array<{ key: string } & LineTax> } | null;
  /** The exemption notes create would print, defaults resolved. */
  exemptionNotes: ExemptionNotes;
};

/** What `invoices.remove` resolves to. */
export type InvoiceRemoveResult = {
  deleted: boolean;
  releasedEntries: number;
};

/** One canonical cache key, so optimistic reads and invalidation agree. */
export const INVOICE_LIST_INPUT: Record<string, never> = {};

// ── status ───────────────────────────────────────────────────────────

export const INVOICE_STATUSES: readonly InvoiceStatus[] = [
  "draft",
  "sent",
  "paid",
];

/**
 * Mirror of the server's transition table (`routers/invoices.ts`).
 *
 * draft → sent → paid, plus one step back for the mistakes people actually
 * make. draft → paid and paid → draft are deliberately absent.
 */
const ALLOWED_TRANSITIONS: Record<InvoiceStatus, readonly InvoiceStatus[]> = {
  draft: ["draft", "sent"],
  sent: ["draft", "sent", "paid"],
  paid: ["sent", "paid"],
};

/**
 * The status changes the UI offers from `from` — the legal targets MINUS the
 * status it already has. Re-setting the current status is legal on the server
 * (a retried mutation must not fail) but is not a button anybody wants.
 */
export function statusTransitions(from: InvoiceStatus): InvoiceStatus[] {
  // A status a newer server added has no known transitions: offer none rather
  // than crash the invoice list.
  return (ALLOWED_TRANSITIONS[from] ?? []).filter((status) => status !== from);
}

/**
 * "Mark as sent" going forward, "Back to draft" going back — so a button that
 * walks the lifecycle backwards never reads like progress.
 */
export function statusActionLabel(
  from: InvoiceStatus,
  to: InvoiceStatus,
  locale: ClientLocale = getActiveLocale(),
): string {
  const forward = INVOICE_STATUSES.indexOf(to) > INVOICE_STATUSES.indexOf(from);
  const t = reportsT(locale);
  return forward
    ? t("invoices.markAs", { status: to })
    : t("invoices.backTo", { status: to });
}

/** The status as the badge names it: "draft" / „Entwurf“. */
export function statusLabel(
  status: InvoiceStatus,
  locale: ClientLocale = getActiveLocale(),
): string {
  // A status a newer server added has no message; its own word beats a key path.
  if (!(INVOICE_STATUSES as readonly string[]).includes(status)) return status;
  return reportsT(locale)(`invoices.status.${status}`);
}

export type BadgeTone = "default" | "secondary" | "outline" | "destructive";

/** Paid is the only status worth the loud badge. */
export function statusBadgeTone(status: InvoiceStatus): BadgeTone {
  switch (status) {
    case "paid":
      return "default";
    case "sent":
      return "secondary";
    case "draft":
      return "outline";
    default:
      return "outline";
  }
}

/**
 * Only a draft can be deleted.
 *
 * A sent or paid invoice is a record of something that left the building, and
 * deleting it leaves a hole in the numbering somebody has to explain. The
 * server refuses it outright; the UI must not offer the button.
 */
export function canDeleteInvoice(status: InvoiceStatus): boolean {
  return status === "draft";
}

// ── preview exclusions ───────────────────────────────────────────────

export type ExclusionNotice = {
  id: "missing-rate" | "already-invoiced";
  tone: "warning" | "info";
  message: string;
};

/**
 * Turn the counts the preview reports into sentences.
 *
 * Both numbers are surfaced rather than hidden. An invoice that quietly bills
 * less time than the user tracked is the bug this whole screen exists to
 * avoid, and the two reasons time drops out have opposite meanings:
 *
 *  - NO RATE is a warning. That work is billable, nobody has billed it, and
 *    this invoice will not either — it needs a rate before it can be.
 *  - ALREADY INVOICED is reassurance, not a problem. It is the double-billing
 *    guard doing its job, and saying so is what makes a second invoice over
 *    the same range legible instead of looking broken.
 */
export function exclusionNotices(
  preview: Pick<InvoicePreviewData, "skippedMissingRate" | "skippedInvoiced">,
  locale: ClientLocale = getActiveLocale(),
): ExclusionNotice[] {
  const notices: ExclusionNotice[] = [];
  const t = reportsT(locale);

  if (preview.skippedMissingRate > 0) {
    notices.push({
      id: "missing-rate",
      tone: "warning",
      message: t("invoices.notices.missingRate", {
        count: preview.skippedMissingRate,
      }),
    });
  }

  if (preview.skippedInvoiced > 0) {
    notices.push({
      id: "already-invoiced",
      tone: "info",
      message: t("invoices.notices.alreadyInvoiced", {
        count: preview.skippedInvoiced,
      }),
    });
  }

  return notices;
}

/** True when there is something to bill — the only state `create` accepts. */
export function previewIsBillable(
  preview: Pick<InvoicePreviewData, "entryIds"> | undefined,
): boolean {
  return (preview?.entryIds.length ?? 0) > 0;
}

/**
 * Why an empty preview is empty, in the user's terms.
 *
 * "Nothing to bill" alone is unhelpful when the reason is that it was all
 * billed last week — which is exactly the case a second invoice over the same
 * range hits.
 */
export function emptyPreviewReason(
  preview: Pick<InvoicePreviewData, "skippedMissingRate" | "skippedInvoiced">,
  locale: ClientLocale = getActiveLocale(),
): string {
  const t = reportsT(locale);
  if (preview.skippedInvoiced > 0 && preview.skippedMissingRate > 0) {
    return t("invoices.emptyReason.both");
  }
  if (preview.skippedInvoiced > 0) {
    return t("invoices.emptyReason.invoiced");
  }
  if (preview.skippedMissingRate > 0) {
    return t("invoices.emptyReason.missingRate");
  }
  return t("invoices.emptyReason.none");
}

// ── display ──────────────────────────────────────────────────────────

/**
 * Hours on an invoice are decimal, always two places — "3.00 h" / „3,00 h“,
 * not "3:00:00". A customer reconciles `hours × rate = amount` by eye, and
 * that only works if the quantity is the one the multiplication used.
 */
export function formatHours(
  hours: number,
  locale: ClientLocale = getActiveLocale(),
): string {
  return reportsT(locale)("invoices.hoursValue", {
    hours: formatDecimal(Number.isFinite(hours) ? hours : 0, locale, 2),
  });
}

/** Total decimal hours across the lines, for the summary row. A manual line has no seconds. */
export function totalHours(lineItems: readonly InvoiceLineItem[]): number {
  const seconds = lineItems.reduce((sum, line) => sum + line.seconds, 0);
  return Math.round((seconds / 3600) * 100) / 100;
}

/** True once any line was typed rather than rolled up from time: the table then names every unit. */
export function hasManualLines(lineItems: readonly Pick<InvoiceLineItem, "kind">[]): boolean {
  return lineItems.some((line) => lineKind(line) === "manual");
}

/**
 * "2.00 days" / „2,00 Tage“ — a line's quantity with its unit, two places
 * like `formatHours`, so `quantity × price = amount` reconciles by eye.
 */
export function formatQuantity(
  line: InvoiceLineLike,
  locale: ClientLocale = getActiveLocale(),
): string {
  const quantity = lineQuantity(line);
  return reportsT(locale)("invoices.quantityValue", {
    quantity: formatDecimal(Number.isFinite(quantity) ? quantity : 0, locale, 2),
    count: quantity,
    unit: lineUnit(line),
  });
}

/** True when the preview has anything on it at all — time lines or manual ones. */
export function previewHasLines(
  preview: Pick<InvoicePreviewData, "lineItems"> | undefined,
): boolean {
  return (preview?.lineItems.length ?? 0) > 0;
}

/** "Tax (19%)" / "No tax" — the tax line's own label. */
export function taxLabel(
  taxRate: number | null,
  locale: ClientLocale = getActiveLocale(),
): string {
  const t = reportsT(locale);
  if (taxRate === null || !Number.isFinite(taxRate)) return t("invoices.noTax");
  return t("invoices.tax", {
    rate: formatNumber(taxRate / 100, locale, {
      style: "percent",
      maximumFractionDigits: 4,
    }),
  });
}

/**
 * "VAT 19 %", "Exempt", "Reverse charge" — a breakdown row's own label, in the
 * UI language. The rate is shown only for the standard category.
 */
export function taxCategoryLabel(category: TaxCategory, rate: number): string {
  const t = translate("einvoice");
  if (category === "S") {
    const shown = Number.isInteger(rate) ? String(rate) : String(Math.round(rate * 100) / 100);
    return t("lines.breakdown.S", { rate: shown });
  }
  return t(`lines.breakdown.${category}`);
}

/** True when the lines do not all share one category and rate (the detail then shows a VAT column). */
export function linesHaveMixedTax(lineItems: readonly InvoiceLineItem[]): boolean {
  const keys = new Set(
    lineItems.map((line) => (line.taxCategory === undefined ? "none" : `${line.taxCategory}:${line.taxRate ?? 0}`)),
  );
  return keys.size > 1;
}

// ── dates ────────────────────────────────────────────────────────────

/** Local "YYYY-MM-DD" — never `toISOString()`, which shifts across zones. */
export const toDateKey = (date: Date): string => format(date, "yyyy-MM-dd");

/** Shift a "YYYY-MM-DD" key by whole days, staying in local calendar terms. */
export function shiftDateKey(dateKey: string, days: number): string {
  const parsed = parseISO(dateKey.slice(0, 10));
  if (Number.isNaN(parsed.getTime())) return dateKey;
  return toDateKey(addDays(parsed, days));
}

/** Net-14 by default: today's issue date, due a fortnight later. */
export const DEFAULT_PAYMENT_DAYS = 14;

export function defaultInvoiceDates(now: Date = new Date()): {
  issueDate: string;
  dueDate: string;
} {
  const issueDate = toDateKey(now);
  return { issueDate, dueDate: shiftDateKey(issueDate, DEFAULT_PAYMENT_DAYS) };
}

/**
 * Keep the due date at or after the issue date.
 *
 * Moving the issue date forward past the due date must drag the due date with
 * it — the server rejects `dueDate < issueDate`, and a form that lets you
 * build a request it will refuse is a form that wastes a round trip to say so.
 */
export function reconcileDueDate(issueDate: string, dueDate: string): string {
  return dueDate < issueDate
    ? shiftDateKey(issueDate, DEFAULT_PAYMENT_DAYS)
    : dueDate;
}

/** Why a tax field was refused; the form names it in the reader's language. */
export type TaxRateError = "notNumber" | "outOfRange";

/**
 * Parse the tax field.
 *
 * Empty means NO TAX LINE (null), which is not the same as 0% — a 0% line is
 * a deliberate statement and still prints. Anything unparseable or out of the
 * server's 0–100 range is rejected here so the mutation is never sent. A
 * decimal comma is accepted alongside the dot ("7,5"), since that is how half
 * the readers of a German UI type a fraction.
 */
export function parseTaxRate(
  raw: string,
): { ok: true; value: number | null } | { ok: false; error: TaxRateError } {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: null };

  const normalised = /^[+-]?\d*,\d+$/.test(trimmed) ? trimmed.replace(",", ".") : trimmed;
  const value = Number(normalised);
  if (!Number.isFinite(value)) {
    return { ok: false, error: "notNumber" };
  }
  if (value < 0 || value > 100) {
    return { ok: false, error: "outOfRange" };
  }
  return { ok: true, value };
}

/** "1–31 Aug 2026" for the billed range, from ISO instants or date keys. */
export function formatRange(
  from: string,
  to: string,
  locale: ClientLocale = getActiveLocale(),
): string {
  const parse = (value: string): Date | null => {
    const date = new Date(value.length === 10 ? `${value}T00:00:00` : value);
    return Number.isNaN(date.getTime()) ? null : date;
  };
  const start = parse(from);
  const end = parse(to);
  if (!start || !end) return `${from} – ${to}`;
  // The stored `to` is the EXCLUSIVE upper bound (midnight of the day after),
  // so the last billed day is the day before it.
  const lastDay = addDays(end, -1);
  const inclusiveEnd = lastDay.getTime() < start.getTime() ? end : lastDay;
  const formatter = new Intl.DateTimeFormat(intlLocale(locale), DATE_STYLES.medium);
  try {
    return formatter.formatRange(start, inclusiveEnd);
  } catch {
    return `${formatter.format(start)} – ${formatter.format(inclusiveEnd)}`;
  }
}

/** "21 Aug 2026" / „21. Aug. 2026“ for a single ISO date. */
export function formatDate(
  iso: string,
  locale: ClientLocale = getActiveLocale(),
): string {
  const date = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  return Number.isNaN(date.getTime()) ? iso : formatLocaleDate(date, locale, "medium");
}

/** The date input's "YYYY-MM-DD" form of a stored ISO instant. */
export function toDateInputValue(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso.slice(0, 10) : toDateKey(date);
}
