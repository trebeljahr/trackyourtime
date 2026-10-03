import { z } from "zod";
import type { Invoice } from "./types.js";

export type InvoicePayment = {
  requestId: string;
  kind: "payment" | "reversal" | "refund";
  /** Integer invoice units from currencyScale; never floating point arithmetic. */
  amountMinor: number;
  at: string;
  recordedAt: string;
  by: string;
  note: string;
  reverses?: string;
};
export type InvoiceCreditSnapshot = Pick<
  Invoice,
  | "clientId"
  | "clientName"
  | "currency"
  | "lineItems"
  | "subtotal"
  | "taxRate"
  | "taxAmount"
  | "total"
  | "issuer"
  | "recipient"
  | "taxBreakdown"
  | "locale"
  | "from"
  | "to"
  | "groupBy"
>;
export type InvoiceCredit = {
  requestId: string;
  number: string;
  originalNumber: string;
  reason: string;
  at: string;
  by: string;
  snapshot: InvoiceCreditSnapshot;
  replacementId?: string;
};
export type InvoiceReminders = {
  enabled: boolean;
  recipient: string;
  timezone: string;
  consentAt: string;
  consentBy: string;
  sentDays: number[];
  skippedDays?: number[];
  lastOutcome?: "sent" | "failed" | "cancelled";
  lastAttemptAt?: string;
  /** Stable refusal code, never provider messages or credentials. */
  failure?: string;
  claim?: { token: string; until: string; day: number };
};
export type InvoiceFollowThrough = {
  payments?: InvoicePayment[];
  /** Settled opening balance for a legacy paid row, with no invented payment date. */
  legacySettledMinor?: number;
  credit?: InvoiceCredit;
  reminders?: InvoiceReminders;
};
export type InvoiceBalance = {
  totalMinor: number;
  paidMinor: number;
  outstandingMinor: number;
  refundDueMinor: number;
  overdueDays: number;
  legacySettled: boolean;
};

export function currencyScale(currency: string): number {
  // Historical invoice lines/totals use hundredths even for JPY. Keep that
  // precision rather than changing an issued amount; retain finer ISO precision.
  return Math.max(
    100,
    10 **
      new Intl.NumberFormat("en", {
        style: "currency",
        currency,
      }).resolvedOptions().maximumFractionDigits!,
  );
}
/** Exact decimal input; reject excess precision instead of quietly rounding a payment. */
export function moneyMinor(amount: string, currency: string): number {
  const scale = currencyScale(currency);
  const digits = Math.log10(scale);
  if (!/^\d+(?:[.,]\d+)?$/.test(amount))
    throw new Error("invoice-payment-amount");
  const [whole = "", fraction = ""] = amount.replace(",", ".").split(".");
  if (fraction.length > digits && /[1-9]/.test(fraction.slice(digits)))
    throw new Error("invoice-payment-precision");
  const value =
    BigInt(whole) * BigInt(scale) +
    BigInt(fraction.slice(0, digits).padEnd(digits, "0") || "0");
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("invoice-payment-amount");
  return Number(value);
}
export function invoiceDay(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}
export function invoiceBalance(
  invoice: Pick<
    Invoice,
    "total" | "currency" | "status" | "dueDate" | "followThrough" | "timezone"
  >,
  now = new Date(),
): InvoiceBalance {
  const f = invoice.followThrough;
  // Stored totals predate exact decimal payment input. Use the existing invoice
  // rounding boundary; binary tails (0.1 + 0.2) must not break a list read.
  const rounded = Math.round(invoice.total * currencyScale(invoice.currency));
  const totalMinor = Number.isSafeInteger(rounded) ? Math.max(0, rounded) : 0;
  const legacySettled =
    f?.legacySettledMinor !== undefined ||
    (invoice.status === "paid" && f?.payments === undefined);
  let paidMinor = f?.legacySettledMinor ?? (legacySettled ? totalMinor : 0);
  const entries = new Map<string, InvoicePayment>();
  for (const payment of f?.payments ?? []) {
    const reversed = payment.reverses
      ? entries.get(payment.reverses)
      : undefined;
    const increases =
      payment.kind === "payment" ||
      (payment.kind === "reversal" && reversed?.kind === "refund");
    paidMinor += increases ? payment.amountMinor : -payment.amountMinor;
    entries.set(payment.requestId, payment);
  }
  const outstandingMinor = f?.credit ? 0 : Math.max(0, totalMinor - paidMinor);
  const day = invoiceDay(now, invoice.timezone ?? "UTC");
  // Invoice dates are date-only snapshots encoded at UTC midnight; timezone determines TODAY only.
  const elapsed = Math.floor(
    (Date.parse(day) - Date.parse(invoice.dueDate.slice(0, 10))) / 86_400_000,
  );
  return {
    totalMinor,
    paidMinor,
    outstandingMinor,
    refundDueMinor: f?.credit ? Math.max(0, paidMinor) : 0,
    overdueDays:
      invoice.status !== "draft" && outstandingMinor > 0
        ? Math.max(0, elapsed)
        : 0,
    legacySettled,
  };
}
export const REMINDER_DAYS = [1, 7, 14] as const;
export function nextReminderDay(
  invoice: Pick<
    Invoice,
    "total" | "currency" | "status" | "dueDate" | "followThrough" | "timezone"
  >,
  now: Date,
): number | null {
  const reminder = invoice.followThrough?.reminders;
  const balance = invoiceBalance(invoice, now);
  if (
    !reminder?.enabled ||
    invoice.followThrough?.credit ||
    invoice.status === "draft" ||
    balance.outstandingMinor === 0
  )
    return null;
  const due = [...REMINDER_DAYS]
    .reverse()
    .find((day) => balance.overdueDays >= day);
  if (
    due === undefined ||
    reminder.sentDays.includes(due) ||
    reminder.skippedDays?.includes(due)
  )
    return null;
  // One email after late opt-in/recovery; earlier stages are skipped, never replayed.
  return due;
}
const base = {
  id: z.string().min(1).max(100),
  originId: z.string().max(64).optional(),
};
export const invoicePaymentSchema = z.object({
  ...base,
  requestId: z.string().uuid(),
  kind: z.enum(["payment", "reversal", "refund"]),
  amount: z.string().min(1).max(40),
  at: z.string().datetime(),
  note: z.string().trim().max(500).default(""),
  reverses: z.string().uuid().optional(),
});
export const invoiceCreditSchema = z.object({
  ...base,
  requestId: z.string().uuid(),
  reason: z.string().trim().min(1).max(1000),
  replacement: z.boolean().default(false),
});
export const invoiceReminderSchema = z.object({
  ...base,
  enabled: z.boolean(),
  recipient: z.string().email().max(254),
  timezone: z
    .string()
    .max(100)
    .refine((value) => {
      try {
        invoiceDay(new Date(), value);
        return true;
      } catch {
        return false;
      }
    }),
});
