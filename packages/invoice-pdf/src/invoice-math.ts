/**
 * The pure invoice rules — which entries are billable, how they roll into
 * lines, which status changes are legal, how a range is read. Moved here from
 * the server's invoices router so an encrypted workspace computes the same
 * invoice on the device that the server computes for a standard one.
 * No database, no tRPC, no Node.
 */
import { entryAmount, type InvoiceLineItem, type InvoiceStatus } from "@starter/shared";

const SECONDS_PER_HOUR = 3600;

/** A caller's mistake (bad range, bad date): BAD_REQUEST on the server. */
export class InvoiceInputError extends Error {
  constructor(message: string) { super(message); this.name = "InvoiceInputError"; }
}

export const roundCents = (value: number): number =>
  Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;

// ── the billable set (pure) ──────────────────────────────────────────

/**
 * One stopped, owner-scoped time entry as the invoicing code sees it. Built
 * from a `TimeEntry` document plus the project/task names needed for a label,
 * with no Mongoose types attached so the rules below stay testable.
 */
export type BillableCandidate = {
  id: string;
  projectId: string | null;
  projectName: string | null;
  taskId: string | null;
  taskName: string | null;
  /** Authoritative billed seconds — `durationSec`, written when it stopped. */
  seconds: number;
  /** SNAPSHOT taken when the entry stopped. Never a project's current rate. */
  hourlyRate: number | null;
  currency: string;
  /** Non-null once the entry has been billed on some invoice. */
  invoiceId: string | null;
};

/** A candidate that survived every check, with a rate proven to exist. */
export type BillableEntry = Omit<BillableCandidate, "hourlyRate"> & {
  hourlyRate: number;
};

export type BillableSelection = {
  billable: BillableEntry[];
  /**
   * Billable, un-invoiced time carrying NO rate. It cannot be billed — but
   * dropping it silently would invoice zero for work somebody did, so the
   * count travels to the UI as a warning.
   */
  skippedMissingRate: number;
  /** Entries excluded because they are already on another invoice. */
  skippedInvoiced: number;
  skippedApproval?: number;
  /** Every currency seen among the billable entries, in first-seen order. */
  currencies: string[];
};

/**
 * Split the candidates into what can be invoiced and what cannot.
 *
 * THE DOUBLE-BILLING GUARD STARTS HERE. An entry with a non-null `invoiceId`
 * has already been billed, and re-billing it is the worst bug this feature
 * can have — you have charged a customer twice for the same hour. The
 * database query already filters on it; this function checks again, because
 * defence in depth on the one rule that costs real money is cheap, and
 * because it makes the rule assertable in a unit test.
 *
 * Everything else that drops out:
 *  - a null (or non-finite) rate — see `skippedMissingRate`. A rate of `0` is
 *    a real, deliberate value ("this line is free") and IS billed;
 *  - a non-positive duration, which has nothing to bill and no warning worth
 *    raising.
 *
 * A RUNNING entry never reaches here at all: the query requires `end` to
 * exist, since you cannot bill an hour that is still being worked.
 */
export function selectBillableEntries(
  candidates: readonly BillableCandidate[],
): BillableSelection {
  const billable: BillableEntry[] = [];
  const currencies: string[] = [];
  let skippedMissingRate = 0;
  let skippedInvoiced = 0;

  for (const candidate of candidates) {
    if (candidate.invoiceId !== null && candidate.invoiceId !== undefined) {
      skippedInvoiced += 1;
      continue;
    }
    if (!Number.isFinite(candidate.seconds) || candidate.seconds <= 0) continue;
    if (
      candidate.hourlyRate === null ||
      candidate.hourlyRate === undefined ||
      !Number.isFinite(candidate.hourlyRate)
    ) {
      skippedMissingRate += 1;
      continue;
    }

    billable.push({ ...candidate, hourlyRate: candidate.hourlyRate });
    if (!currencies.includes(candidate.currency)) {
      currencies.push(candidate.currency);
    }
  }

  return { billable, skippedMissingRate, skippedInvoiced, currencies };
}

// ── grouping into lines (pure) ───────────────────────────────────────

export type InvoiceGroupBy = "project" | "task";

/** Untasked time inside a task-grouped invoice, kept per project. */
const NO_TASK_SUFFIX = ":none";

const groupBase = (
  entry: BillableEntry,
  groupBy: InvoiceGroupBy,
): { key: string; label: string; projectId: string | null; taskId: string | null;
} => {
  const projectLabel = entry.projectName ?? "No project";
  if (groupBy === "project") {
    return {
      key: entry.projectId ?? "none",
      label: projectLabel,
      projectId: entry.projectId,
      taskId: null,
    };
  }
  // Untasked entries from two different projects must not collapse into one
  // "No task" line, so the project id carries the key when the task id is
  // missing.
  return {
    key: entry.taskId ?? `${entry.projectId ?? "none"}${NO_TASK_SUFFIX}`,
    label: `${projectLabel} — ${entry.taskName ?? "No task"}`,
    projectId: entry.projectId,
    taskId: entry.taskId,
  };
};

/**
 * Roll the billable entries into invoice lines.
 *
 * ONE LINE PER (GROUP, RATE) — NOT ONE LINE PER GROUP. Rates are snapshotted
 * per entry, so a project whose rate went from 80 to 95 mid-range holds
 * entries at both. Averaging them into a single "87.50/h" line would print a
 * rate that was never agreed for any of that work, and the customer cannot
 * reconcile it against anything. Splitting the group means every line states
 * a rate that really applied to the hours on it, and the lines still sum to
 * the same money.
 *
 * Money is rounded ONCE PER LINE, from the line's total seconds, using the
 * shared `entryAmount` helper the reports use — so an invoice and a report
 * over the same entries agree to the cent. `hours` is the human-facing
 * quantity rounded to two decimals; `seconds` is the authority and is what
 * `amount` is derived from, so a long line is never off by the accumulated
 * rounding of its parts.
 *
 * Lines come out sorted by label, then by rate ascending, so an invoice
 * regenerated from the same entries is byte-for-byte the same document.
 */
export function invoiceLineItems(
  entries: readonly BillableEntry[],
  groupBy: InvoiceGroupBy,
): InvoiceLineItem[] {
  type Bucket = {
    key: string;
    label: string;
    projectId: string | null;
    taskId: string | null;
    hourlyRate: number;
    currency: string;
    seconds: number;
  };

  const buckets = new Map<string, Bucket>();
  /** How many distinct rates each base group carries — decides the suffix. */
  const ratesPerGroup = new Map<string, Set<number>>();

  for (const entry of entries) {
    const base = groupBase(entry, groupBy);
    const bucketKey = `${base.key}@${entry.hourlyRate}`;
    const existing = buckets.get(bucketKey);
    if (existing) {
      existing.seconds += entry.seconds;
    } else {
      buckets.set(bucketKey, {
        ...base,
        hourlyRate: entry.hourlyRate,
        currency: entry.currency,
        seconds: entry.seconds,
      });
    }

    const rates = ratesPerGroup.get(base.key) ?? new Set<number>();
    rates.add(entry.hourlyRate);
    ratesPerGroup.set(base.key, rates);
  }

  const lines = [...buckets.values()].map((bucket) => {
    // Only a split group needs the rate in its key and label; a group billed
    // at one rate keeps the plain project/task id the wire type documents.
    const split = (ratesPerGroup.get(bucket.key)?.size ?? 1) > 1;
    const line: InvoiceLineItem = {
      key: split ? `${bucket.key}@${bucket.hourlyRate}` : bucket.key,
      label: split
        ? `${bucket.label} (at ${bucket.hourlyRate.toFixed(2)}/h)`
        : bucket.label,
      projectId: bucket.projectId,
      taskId: bucket.taskId,
      seconds: bucket.seconds,
      hours: roundCents(bucket.seconds / SECONDS_PER_HOUR),
      hourlyRate: bucket.hourlyRate,
      currency: bucket.currency,
      amount: entryAmount(bucket.seconds, bucket.hourlyRate),
    };
    // Sorted on the BASE label, never the rendered one: the rate suffix is
    // text, and comparing it as text files "(at 100.00/h)" before
    // "(at 80.00/h)". The split lines of one project belong together, in
    // rate order.
    return { line, sortLabel: bucket.label, rate: bucket.hourlyRate };
  });

  lines.sort((left, right) => {
    const byLabel = left.sortLabel.localeCompare(right.sortLabel);
    if (byLabel !== 0) return byLabel;
    return left.rate - right.rate;
  });

  return lines.map((entry) => entry.line);
}

// ── status transitions (pure) ────────────────────────────────────────

/** Issued invoices never return to draft. Ledger reversals correct payments. */
const ALLOWED_TRANSITIONS: Record<InvoiceStatus, readonly InvoiceStatus[]> = {
  draft: ["draft", "sent"],
  sent: ["sent", "paid"],
  paid: ["paid"],
};

export function isValidStatusTransition(
  from: InvoiceStatus,
  to: InvoiceStatus,
): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

// ── range parsing ────────────────────────────────────────────────────

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Read a range bound exactly the way `reports.ts` does: a bare "YYYY-MM-DD"
 * is the LOCAL calendar day the user picked in the date picker, and
 * `endOfDay` turns it into the EXCLUSIVE upper bound (midnight of the day
 * after). A full ISO datetime is taken as-is.
 *
 * Copied rather than imported because `reports.ts` keeps it private, and this
 * file may not edit it. The two must stay in step: an invoice that read its
 * range differently from the report the user checked it against would look
 * like a money bug.
 */
export const parseInvoiceRangeBound = (value: string, endOfDay: boolean): Date => {
  const dateOnly = DATE_ONLY.exec(value);
  if (dateOnly) {
    return new Date(
      Number(dateOnly[1]),
      Number(dateOnly[2]) - 1,
      Number(dateOnly[3]) + (endOfDay ? 1 : 0),
      0,
      0,
      0,
      0,
    );
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()))
    throw new InvoiceInputError(`Invalid date: ${value}`);
  return parsed;
};

export type InvoiceRange = { from: Date; to: Date };

/**
 * The billed range, or `null` for a BLANK invoice: `from` and `to` both left
 * out (the schema refuses one without the other). Blank means no tracked time
 * is gathered or claimed, and the stored range is null.
 */
export const parseInvoiceRange = (input: {
  from?: string | undefined;
  to?: string | undefined;
}): InvoiceRange | null => {
  if (input.from === undefined || input.to === undefined) return null;
  const from = parseInvoiceRangeBound(input.from, false);
  const to = parseInvoiceRangeBound(input.to, true);
  if (to.getTime() <= from.getTime()) {
    throw new InvoiceInputError("`to` must be after `from`");
  }
  return { from, to };
};
