// Parallel entries vs. invoices: the overlap lock.
//
// An invoice bills an entry's EVEN SHARE of the time it shared with the same
// person's other entries (`invoiceParallelShares` in the invoices router).
// That share depends on which of the author's entries cover which part of the
// invoiced entry. So once an entry is on an invoice — draft or issued — any
// write that would change how another entry covers it is refused, exactly as
// editing the invoiced entry's own times already is. Otherwise a new entry
// laid over billed time would take a share of an hour the customer already
// paid for in full, and get billed again.
//
// What passes: anything that leaves every invoiced entry's coverage as it was
// — renaming, retagging, moving time that never touches invoiced time,
// stopping a running timer after the invoiced entry ended.
//
// Only explicit writes are guarded (create, update, delete, timer start, stop
// with an end, discard, bulk delete, import). The runaway guard's automatic
// cap and account deletion are not: refusing either would be worse than the
// drift, which can only lower a report's share of the invoiced entry.
import { TimeEntry } from "../../models/TimeEntry.js";
import { invoiceConflict } from "./errors.js";

/** An entry's interval; `end: null` is a running timer. */
export type GuardSpan = { start: Date; end: Date | null };
/** An invoiced entry's interval, in ms. */
export type InvoicedSpan = { startMs: number; endMs: number };

export const PARALLEL_INVOICED_REFUSAL =
  "This change would overlap time differently with an entry that is already on an invoice, " +
  "and that invoice billed its share of the overlap. Delete the invoice while it is still a draft " +
  "to release its time, then make the change.";

const endMsOf = (span: GuardSpan): number => (span.end === null ? Infinity : span.end.getTime());

const cover = (span: GuardSpan | null, invoiced: InvoicedSpan): string => {
  if (!span) return "";
  const from = Math.max(span.start.getTime(), invoiced.startMs);
  const to = Math.min(endMsOf(span), invoiced.endMs);
  return to > from ? `${from}-${to}` : "";
};

/**
 * Whether moving an entry from `before` to `after` (either `null`: created or
 * deleted) changes the part of any invoiced entry it covers. Pure; exported
 * for the unit tests and for batch callers that load the spans once.
 */
export const changesInvoicedCoverage = (
  before: GuardSpan | null,
  after: GuardSpan | null,
  invoiced: readonly InvoicedSpan[],
): boolean => invoiced.some((span) => cover(before, span) !== cover(after, span));

/** The author's invoiced entries in a workspace that overlap `[fromMs, toMs)`. */
export const loadInvoicedSpans = async (
  workspaceId: string,
  authorId: string,
  fromMs: number,
  toMs: number,
  excludeId?: string,
): Promise<InvoicedSpan[]> => {
  if (!(toMs > fromMs)) return [];
  const rows = await TimeEntry.find({
    workspaceId,
    authorId,
    invoiceId: { $ne: null },
    end: { $gt: new Date(fromMs) },
    ...(Number.isFinite(toMs) ? { start: { $lt: new Date(toMs) } } : {}),
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
  })
    .select("start end")
    .lean();
  return rows
    .filter((row): row is typeof row & { end: Date } => row.end !== null)
    .map((row) => ({ startMs: row.start.getTime(), endMs: row.end.getTime() }));
};

/**
 * Refuse (`CONFLICT`) a write that would change how the entry covers one of
 * its author's invoiced entries. `selfId` is the entry being written, whose
 * own invoice is guarded by `invoicedEntryEditRefusal` instead.
 */
export const assertInvoicedCoverageKept = async (
  workspaceId: string,
  authorId: string,
  selfId: string | null,
  before: GuardSpan | null,
  after: GuardSpan | null,
): Promise<void> => {
  const spans = [before, after].filter((span): span is GuardSpan => span !== null);
  if (spans.length === 0) return;
  if (
    before && after &&
    before.start.getTime() === after.start.getTime() &&
    endMsOf(before) === endMsOf(after)
  ) return;
  const fromMs = Math.min(...spans.map((span) => span.start.getTime()));
  const toMs = Math.max(...spans.map(endMsOf));
  const invoiced = await loadInvoicedSpans(workspaceId, authorId, fromMs, toMs, selfId ?? undefined);
  if (changesInvoicedCoverage(before, after, invoiced)) {
    throw invoiceConflict(PARALLEL_INVOICED_REFUSAL);
  }
};
