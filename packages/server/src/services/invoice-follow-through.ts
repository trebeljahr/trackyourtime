import {
  invoiceNumberCandidates,
  nextInvoiceNumber,
} from "./invoice-number.js";
import { TRPCError } from "@trpc/server";
import { appendInvoicePayment as pureAppendInvoicePayment, creditInvoice as pureCreditInvoice, creditIssueDate, InvoiceRefusalError } from "@starter/invoice-pdf/follow-through";
import { Types } from "mongoose";
import {
  invoiceBalance,
  type InvoiceFollowThrough,
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

/**
 * The invoices that cannot be overdue at `now`, excluded in the database so
 * the overdue list does not fetch and project every invoice ever written.
 *
 * Only a superset of the overdue invoices remains: `invoiceBalance` still
 * decides, row by row. A row is excluded only when that rule provably gives
 * it no overdue days:
 * - a draft (`status !== "draft"` is required);
 * - a credited invoice (a truthy `credit` makes the outstanding balance 0);
 * - a paid invoice with no ledger: no `payments` and no `legacySettledMinor`
 *   is `legacySettled`, paid in full. That is every invoice marked paid by
 *   hand, since a status change is refused once payments exist;
 * - one due no earlier than a day from now. Overdue needs today, in the
 *   invoice's zone, to be past the due date's UTC day, and no zone is a day
 *   ahead of UTC.
 * A ledger that sums to the total is not excluded: deciding that would be a
 * second copy of the ledger arithmetic, free to drift from the first.
 *
 * `$nor` keeps a row whose field holds something unexpected: a missing
 * status, a `null` ledger or credit, a due date that is not a date.
 */
export function overdueCandidateFilter(now: Date): Record<string, unknown> {
  return {
    $nor: [
      { status: "draft" },
      { "followThrough.credit": { $type: "object" } },
      {
        status: "paid",
        "followThrough.payments": { $exists: false },
        "followThrough.legacySettledMinor": { $exists: false },
      },
      { dueDate: { $gte: new Date(now.getTime() + 86_400_000) } },
    ],
  };
}
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
/** Moved to `@starter/invoice-pdf/follow-through`; wrapped so a refusal stays PRECONDITION_FAILED. */
const refusing = <A extends unknown[], R>(rule: (...args: A) => R) => (...args: A): R => {
  try {
    return rule(...args);
  } catch (error) {
    if (error instanceof InvoiceRefusalError) throw invoiceRefusal(error.message);
    throw error;
  }
};
export type { PaymentCommand } from "@starter/invoice-pdf/follow-through";
export { creditSnapshot, creditIssueDate } from "@starter/invoice-pdf/follow-through";
export const appendInvoicePayment = refusing(pureAppendInvoicePayment);
export const creditInvoice = (...args: Parameters<typeof pureCreditInvoice>) =>
  refusing(pureCreditInvoice)(args[0], args[1], args[2], args[3], args[4] ?? (() => new Types.ObjectId().toString()));
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
