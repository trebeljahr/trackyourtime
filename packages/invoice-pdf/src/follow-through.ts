/**
 * The pure payment-ledger and credit-note rules, moved here from the server's
 * `services/invoice-follow-through.ts` so an encrypted workspace applies the
 * same rules on the device. A refusal is an `InvoiceRefusalError` carrying the
 * stable code; the server turns it into PRECONDITION_FAILED.
 */
import {
  currencyScale,
  invoiceBalance,
  invoiceDay,
  moneyMinor,
  type InvoiceCredit,
  type InvoiceCreditSnapshot,
  type InvoiceFollowThrough,
  type InvoicePayment,
  type Invoice as InvoiceWire,
} from "@starter/shared";

/** A stable refusal code (`invoice-payment-invalid`, …) the client translates. */
export class InvoiceRefusalError extends Error {
  constructor(message: string) { super(message); this.name = "InvoiceRefusalError"; }
}

export type PaymentCommand = {
  requestId: string;
  kind: InvoicePayment["kind"];
  amount: string;
  at: string;
  note: string;
  reverses?: string;
};
export function appendInvoicePayment(
  wire: InvoiceWire,
  input: PaymentCommand,
  by: string,
  now: Date,
): InvoiceFollowThrough {
  const f = structuredClone(wire.followThrough ?? {});
  let amountMinor: number;
  try {
    amountMinor = moneyMinor(input.amount, wire.currency);
  } catch {
    throw new InvoiceRefusalError("invoice-payment-amount");
  }
  const prior = f.payments?.find((p) => p.requestId === input.requestId);
  if (prior) {
    if (
      prior.kind !== input.kind ||
      prior.amountMinor !== amountMinor ||
      prior.at !== input.at ||
      prior.note !== input.note ||
      prior.reverses !== input.reverses
    )
      throw new InvoiceRefusalError("invoice-request-reused");
    return f;
  }
  if (
    wire.status === "draft" ||
    !Number.isSafeInteger(amountMinor) ||
    amountMinor <= 0 ||
    !Number.isFinite(Date.parse(input.at)) ||
    input.at.slice(0, 10) > invoiceDay(now, wire.timezone ?? "UTC")
  )
    throw new InvoiceRefusalError("invoice-payment-invalid");
  const balance = invoiceBalance(wire, now);
  if (!balance.available) throw new InvoiceRefusalError("invoice-balance-unavailable");
  if (
    !Number.isSafeInteger(Math.round(wire.total * currencyScale(wire.currency)))
  )
    throw new InvoiceRefusalError("invoice-payment-amount");
  if (balance.legacySettled && f.legacySettledMinor === undefined)
    f.legacySettledMinor = balance.totalMinor;
  if (
    input.kind === "payment" &&
    (f.credit || input.reverses || amountMinor > balance.outstandingMinor)
  )
    throw new InvoiceRefusalError("invoice-payment-overpayment");
  if (
    input.kind === "refund" &&
    (!f.credit || input.reverses || amountMinor > balance.refundDueMinor)
  )
    throw new InvoiceRefusalError("invoice-refund-invalid");
  if (input.kind === "reversal") {
    const target = f.payments?.find(
      (p) => p.requestId === input.reverses && p.kind !== "reversal",
    );
    if (
      !target ||
      amountMinor !== target.amountMinor ||
      (target.kind === "payment"
        ? amountMinor > balance.paidMinor
        : !f.credit || balance.paidMinor + amountMinor > balance.totalMinor) ||
      f.payments?.some((p) => p.reverses === target.requestId)
    )
      throw new InvoiceRefusalError("invoice-reversal-invalid");
  }
  const { amount: _amount, ...command } = input;
  f.payments = [
    ...(f.payments ?? []),
    { ...command, amountMinor, recordedAt: now.toISOString(), by },
  ];
  // Hard cap prevents unbounded growth towards MongoDB's document limit.
  if (f.payments.length > 2000) throw new InvoiceRefusalError("invoice-ledger-full");
  return f;
}
export function creditSnapshot(wire: InvoiceWire): InvoiceCreditSnapshot {
  const {
    clientId,
    clientName,
    currency,
    lineItems,
    subtotal,
    taxRate,
    taxAmount,
    total,
    issuer,
    recipient,
    taxBreakdown,
    locale,
    from,
    to,
    groupBy,
  } = wire;
  return structuredClone({
    clientId,
    clientName,
    currency,
    lineItems,
    subtotal,
    taxRate,
    taxAmount,
    total,
    issuer,
    recipient,
    taxBreakdown,
    locale,
    from,
    to,
    groupBy,
  });
}
/** A credit is embedded in its immutable original: no two-document accounting commit. */
export function creditInvoice(
  wire: InvoiceWire,
  input: { requestId: string; reason: string; replacement: boolean },
  by: string,
  now: Date,
  /** The replacement draft's id: an ObjectId on the server, a UUID in an encrypted workspace. */
  newReplacementId: () => string = () => crypto.randomUUID(),
): InvoiceFollowThrough {
  const f = structuredClone(wire.followThrough ?? {});
  if (f.credit) {
    if (
      f.credit.requestId !== input.requestId ||
      f.credit.reason !== input.reason ||
      Boolean(f.credit.replacementId) !== input.replacement
    )
      throw new InvoiceRefusalError("invoice-already-credited");
    return f;
  }
  if (wire.status === "draft")
    throw new InvoiceRefusalError("invoice-credit-issued-only");
  const balance = invoiceBalance(wire, now);
  if (!balance.available) throw new InvoiceRefusalError("invoice-balance-unavailable");
  if (
    !Number.isSafeInteger(Math.round(wire.total * currencyScale(wire.currency)))
  )
    throw new InvoiceRefusalError("invoice-payment-amount");
  if (balance.legacySettled && f.legacySettledMinor === undefined)
    f.legacySettledMinor = balance.totalMinor;
  f.credit = {
    requestId: input.requestId,
    number: `CN-${wire.number}`,
    originalNumber: wire.number,
    reason: input.reason,
    at: now.toISOString(),
    issueDate: invoiceDay(now, wire.timezone ?? "UTC"),
    by,
    snapshot: creditSnapshot(wire),
    ...(input.replacement
      ? { replacementId: newReplacementId() }
      : {}),
  };
  return f;
}
/** Older credits keep their original UTC date; never reinterpret them in a new timezone. */
export function creditIssueDate(
  credit: Pick<InvoiceCredit, "issueDate" | "at">,
): string {
  return credit.issueDate ?? credit.at.slice(0, 10);
}
