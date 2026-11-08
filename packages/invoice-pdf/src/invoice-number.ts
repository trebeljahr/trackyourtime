/**
 * Invoice numbering.
 *
 * FORMAT: `YYYY-NNN` — the issue year, a dash, and a per-year sequence padded
 * to at least three digits: `2026-001`, `2026-014`, ... `2026-1000` once a
 * year runs past 999. The sequence restarts at 1 each calendar year, which is
 * what most small-business bookkeeping expects and what makes a number
 * readable at a glance ("the fourteenth invoice of 2026").
 *
 * CONCURRENCY: the obvious implementation — read the highest number, add one,
 * write — is a lost-update race. Two creates that read `2026-013` at the same
 * moment both write `2026-014`, and an invoice number is exactly the thing an
 * accountant matches a payment against, so a collision is a real-world
 * problem rather than a cosmetic one.
 *
 * The fix is not a lock. `Invoice` carries a UNIQUE index on
 * `{ workspaceId, number }`, so the database is the arbiter: the loser of the race
 * gets a duplicate-key error, and the caller retries with the next candidate.
 * These helpers exist to make that retry loop trivial — {@link nextInvoiceNumber}
 * proposes a first candidate from whatever numbers were visible, and
 * {@link bumpInvoiceNumber} produces the next one after a collision. Neither
 * touches the database, so both are testable on their own.
 */

/** A generated number: four-digit year, dash, three-or-more digit sequence. */
export const INVOICE_NUMBER_PATTERN = /^(\d{4})-(\d{3,})$/;

/** Minimum sequence width, so `1` reads as `001`. */
const SEQUENCE_PAD = 3;

/**
 * How many candidates {@link invoiceNumberCandidates} will offer before the
 * caller gives up. Every attempt costs one failed insert, and needing more
 * than a handful means something other than a race is wrong.
 */
export const MAX_NUMBER_ATTEMPTS = 8;

export type ParsedInvoiceNumber = { year: number; sequence: number };

/** Render a year and sequence in the canonical format. */
export function formatInvoiceNumber(year: number, sequence: number): string {
  const safeYear = Math.trunc(year);
  const safeSequence = Math.max(1, Math.trunc(sequence));
  return `${String(safeYear).padStart(4, "0")}-${String(safeSequence).padStart(
    SEQUENCE_PAD,
    "0",
  )}`;
}

/**
 * Read a number back, or `null` when it was not produced by this scheme.
 *
 * A caller may supply any string they like as an invoice number (a migration
 * from another system, a customer's own reference). Those are stored verbatim
 * and simply do not participate in sequencing — hence `null` rather than a
 * throw.
 */
export function parseInvoiceNumber(value: string): ParsedInvoiceNumber | null {
  const match = INVOICE_NUMBER_PATTERN.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const sequence = Number(match[2]);
  if (!Number.isSafeInteger(year) || !Number.isSafeInteger(sequence)) return null;
  if (sequence < 1) return null;
  return { year, sequence };
}

/**
 * The first candidate for a new invoice in `year`: one past the highest
 * sequence already used THAT year.
 *
 * Numbers from other years and numbers in a foreign format are ignored rather
 * than counted, so importing "INV-2024-7" from an old system cannot push this
 * year's sequence into nonsense. The result is only a proposal — the unique
 * index decides whether it survives.
 */
export function nextInvoiceNumber(
  existing: readonly string[],
  year: number,
): string {
  let highest = 0;
  for (const value of existing) {
    const parsed = parseInvoiceNumber(value);
    if (!parsed || parsed.year !== year) continue;
    if (parsed.sequence > highest) highest = parsed.sequence;
  }
  return formatInvoiceNumber(year, highest + 1);
}

/**
 * The candidate after `number`, for the retry that follows a duplicate-key
 * error. `null` when the number is not one of ours — a caller-supplied number
 * that collides is the caller's problem to resolve, not something to silently
 * renumber.
 */
export function bumpInvoiceNumber(number: string): string | null {
  const parsed = parseInvoiceNumber(number);
  if (!parsed) return null;
  return formatInvoiceNumber(parsed.year, parsed.sequence + 1);
}

/**
 * The sequence of candidates a create should try, starting at `first`.
 *
 * Materialized rather than generated so the retry loop in the router stays a
 * plain `for ... of` with a hard bound: an unparseable first candidate yields
 * exactly one attempt, and a generated one yields at most
 * {@link MAX_NUMBER_ATTEMPTS}.
 */
export function invoiceNumberCandidates(
  first: string,
  attempts: number = MAX_NUMBER_ATTEMPTS,
): string[] {
  const candidates = [first];
  for (let index = 1; index < Math.max(1, attempts); index += 1) {
    const previous = candidates[candidates.length - 1];
    if (previous === undefined) break;
    const next = bumpInvoiceNumber(previous);
    if (next === null) break;
    candidates.push(next);
  }
  return candidates;
}

/**
 * The calendar year an ISO date string NAMES, read off the string itself.
 *
 * `new Date("2026-01-01").getFullYear()` is not this: a date-only string
 * parses as UTC midnight, so any host west of UTC reads it back as the
 * PREVIOUS year and an invoice issued on the 1st of January gets numbered
 * into the year that just ended — a wrong, permanent, accountant-visible
 * number rather than a display glitch. Reading the leading `YYYY` is
 * host-zone-independent, and for an offset datetime ("2026-01-01T00:30+01:00")
 * it is the year the writer meant, which is the one the number should carry.
 *
 * Returns `null` for anything that does not start with four digits, so the
 * caller decides the fallback rather than silently getting year 0.
 */
export function yearOfIsoDate(value: string): number | null {
  const match = /^(\d{4})-\d{2}-\d{2}/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  return Number.isSafeInteger(year) ? year : null;
}
