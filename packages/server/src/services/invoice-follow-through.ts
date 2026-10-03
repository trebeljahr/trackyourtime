import {
  invoiceNumberCandidates,
  nextInvoiceNumber,
} from "./invoice-number.js";
import { TRPCError } from "@trpc/server";
import { Types } from "mongoose";
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
import {
  Invoice,
  toClientInvoice,
  type InvoiceDocLike,
  type IInvoice,
} from "../models/Invoice.js";

export const invoiceRefusal = (message: string): TRPCError =>
  new TRPCError({ code: "PRECONDITION_FAILED", message });
export function revisionFilter(
  doc: Pick<IInvoice, "followThroughRevision">,
): Record<string, unknown> {
  return {
    followThroughRevision: doc.followThroughRevision ?? { $exists: false },
  };
}
export async function loadFollowThrough(
  id: string,
  workspaceId: string,
): Promise<InvoiceDocLike & { followThroughRevision?: number }> {
  if (!Types.ObjectId.isValid(id)) throw new TRPCError({ code: "NOT_FOUND" });
  const doc = await Invoice.findOne({
    _id: id,
    workspaceId,
    deleting: { $ne: true },
  }).lean();
  if (!doc) throw new TRPCError({ code: "NOT_FOUND" });
  return doc;
}
/** Read/compute/CAS is one-document atomic, including old rows with no revision. */
export async function changeFollowThrough(
  id: string,
  workspaceId: string,
  change: (wire: InvoiceWire, doc: InvoiceDocLike) => InvoiceFollowThrough,
): Promise<InvoiceWire> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const doc = await loadFollowThrough(id, workspaceId);
    const wire = toClientInvoice(doc);
    // Preserve internal claims while computing a mutation; the response mapper removes them.
    if (doc.followThrough)
      wire.followThrough = structuredClone(doc.followThrough);
    const next = change(wire, doc);
    const after = { ...wire, followThrough: next };
    const balance = invoiceBalance(after);
    if (!balance.available) throw invoiceRefusal("invoice-balance-unavailable");
    const status = next.credit
      ? wire.status
      : wire.status === "draft"
        ? "draft"
        : balance.outstandingMinor === 0 && !next.credit
          ? "paid"
          : "sent";
    const updated = await Invoice.findOneAndUpdate(
      {
        _id: id,
        workspaceId,
        deleting: { $ne: true },
        status: doc.status,
        updatedAt: doc.updatedAt,
        ...revisionFilter(doc),
      },
      {
        $set: { followThrough: next, status },
        $inc: { followThroughRevision: 1 },
      },
      { returnDocument: "after" },
    ).lean();
    if (updated) return toClientInvoice(updated);
  }
  throw new TRPCError({ code: "CONFLICT", message: "invoice-changed" });
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
    throw invoiceRefusal("invoice-payment-amount");
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
      throw invoiceRefusal("invoice-request-reused");
    return f;
  }
  if (
    wire.status === "draft" ||
    !Number.isSafeInteger(amountMinor) ||
    amountMinor <= 0 ||
    !Number.isFinite(Date.parse(input.at)) ||
    input.at.slice(0, 10) > invoiceDay(now, wire.timezone ?? "UTC")
  )
    throw invoiceRefusal("invoice-payment-invalid");
  const balance = invoiceBalance(wire, now);
  if (!balance.available) throw invoiceRefusal("invoice-balance-unavailable");
  if (
    !Number.isSafeInteger(Math.round(wire.total * currencyScale(wire.currency)))
  )
    throw invoiceRefusal("invoice-payment-amount");
  if (balance.legacySettled && f.legacySettledMinor === undefined)
    f.legacySettledMinor = balance.totalMinor;
  if (
    input.kind === "payment" &&
    (f.credit || input.reverses || amountMinor > balance.outstandingMinor)
  )
    throw invoiceRefusal("invoice-payment-overpayment");
  if (
    input.kind === "refund" &&
    (!f.credit || input.reverses || amountMinor > balance.refundDueMinor)
  )
    throw invoiceRefusal("invoice-refund-invalid");
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
      throw invoiceRefusal("invoice-reversal-invalid");
  }
  const { amount: _amount, ...command } = input;
  f.payments = [
    ...(f.payments ?? []),
    { ...command, amountMinor, recordedAt: now.toISOString(), by },
  ];
  // Hard cap prevents unbounded growth towards MongoDB's document limit.
  if (f.payments.length > 2000) throw invoiceRefusal("invoice-ledger-full");
  if (
    invoiceBalance({ ...wire, followThrough: f }, now).outstandingMinor === 0 &&
    f.reminders
  )
    f.reminders.enabled = false;
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
): InvoiceFollowThrough {
  const f = structuredClone(wire.followThrough ?? {});
  if (f.credit) {
    if (
      f.credit.requestId !== input.requestId ||
      f.credit.reason !== input.reason ||
      Boolean(f.credit.replacementId) !== input.replacement
    )
      throw invoiceRefusal("invoice-already-credited");
    return f;
  }
  if (wire.status === "draft")
    throw invoiceRefusal("invoice-credit-issued-only");
  const balance = invoiceBalance(wire, now);
  if (!balance.available) throw invoiceRefusal("invoice-balance-unavailable");
  if (
    !Number.isSafeInteger(Math.round(wire.total * currencyScale(wire.currency)))
  )
    throw invoiceRefusal("invoice-payment-amount");
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
      ? { replacementId: new Types.ObjectId().toString() }
      : {}),
  };
  if (f.reminders) f.reminders.enabled = false;
  return f;
}
/** Older credits keep their original UTC date; never reinterpret them in a new timezone. */
export function creditIssueDate(
  credit: Pick<InvoiceCredit, "issueDate" | "at">,
): string {
  return credit.issueDate ?? credit.at.slice(0, 10);
}
/** Retrying a correction repairs an interrupted draft creation without another credit. */
export async function ensureReplacement(
  original: InvoiceDocLike,
): Promise<void> {
  const credit = original.followThrough?.credit;
  if (!credit?.replacementId) return;
  const snapshot = credit.snapshot;
  if (
    await Invoice.exists({
      _id: credit.replacementId,
      workspaceId: original.workspaceId,
    })
  )
    return;
  const numbers = await Invoice.find({ workspaceId: original.workspaceId })
    .select("number")
    .lean();
  const issueDate = creditIssueDate(credit);
  const year = Number(issueDate.slice(0, 4));
  for (const number of invoiceNumberCandidates(
    nextInvoiceNumber(
      numbers.map((row) => row.number),
      year,
    ),
  )) {
    try {
      await Invoice.create({
        ...snapshot,
        issuer: original.issuer,
        _id: credit.replacementId,
        workspaceId: original.workspaceId,
        createdBy: credit.by,
        number,
        status: "draft",
        replacementFor: String(original._id),
        issueDate: new Date(issueDate),
        dueDate: new Date(issueDate),
        from: snapshot.from ? new Date(snapshot.from) : null,
        to: snapshot.to ? new Date(snapshot.to) : null,
        lineItems: snapshot.lineItems.map((line, index) => ({
          ...line,
          kind: "manual",
          key: `manual:${String(index).padStart(12, "0")}`,
          quantity: 1,
          unit: "piece",
          unitPrice: line.amount,
          seconds: 0,
          hours: 0,
          hourlyRate: line.amount,
        })),
        entryIds: [],
        notes: credit.reason,
        timezone: original.timezone,
      });
      return;
    } catch (error) {
      if (!(
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === 11000
      ))
        throw error;
      if (
        await Invoice.exists({
          _id: credit.replacementId,
          workspaceId: original.workspaceId,
        })
      )
        return;
    }
  }
  throw new TRPCError({
    code: "CONFLICT",
    message: "invoice-replacement-retry",
  });
}
