/**
 * Formatting for the e-invoice outputs: numbers that are not amounts, dates
 * and filenames. Amounts are `formatCents(toCents(x))` from totals.ts.
 *
 * Every function here is pure, locale-free and browser-safe (no `node:` import,
 * no `Buffer`): the invoice renderer and the public generator page both need
 * it. The XML-aware text helpers (`cleanText`, `cleanLine`) stay on the server
 * in `services/einvoice/format.ts`, which re-exports this module beside them.
 * None of these functions produces an exponent, a thousands separator or a
 * float artefact (BR-DEC-*), and none reads the clock.
 */

const MAX_SAFE_DECIMAL = 1e15;

// BigInt() calls rather than `10n` literals: the client type-checks this file
// through the AppRouter import chain, and its tsconfig targets ES2017, where a
// BigInt literal is a compile error (TS2737). The runtime has BigInt either way.
const ONE = BigInt(1);
const TWO = BigInt(2);
const TEN = BigInt(10);
const TEN_THOUSAND = BigInt(10_000);

/**
 * A finite number as an exact decimal: `digits × 10^-scale`, read from the
 * shortest round-trip string (`String(0.1 + 0.2)` is "0.30000000000000004",
 * `String(1.005)` is "1.005"), so the value is the decimal the number was
 * meant to be rather than its binary expansion.
 */
function toDecimalParts(value: number): { digits: bigint; scale: number } {
  const text = String(Math.abs(value));
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(text);
  if (!match) throw new RangeError(`Cannot format ${text} as a decimal`);
  const whole = match[1] ?? "0";
  const fraction = match[2] ?? "";
  const exponent = Number(match[3] ?? "0");
  let digits = BigInt(`${whole}${fraction}`);
  let scale = fraction.length - exponent;
  if (scale < 0) {
    digits *= TEN ** BigInt(-scale);
    scale = 0;
  }
  return { digits, scale };
}

/** Round a non-negative decimal to `places` fraction digits, ties away from zero. */
function roundToPlaces(parts: { digits: bigint; scale: number }, places: number): bigint {
  if (parts.scale <= places) return parts.digits * TEN ** BigInt(places - parts.scale);
  const divisor = TEN ** BigInt(parts.scale - places);
  const quotient = parts.digits / divisor;
  const remainder = parts.digits % divisor;
  return remainder * TWO >= divisor ? quotient + ONE : quotient;
}

/** Scaled integer → "int.frac" with between `minFraction` and `places` fraction digits. */
function scaledToString(scaled: bigint, places: number, minFraction: number): string {
  const unit = TEN ** BigInt(places);
  const whole = (scaled / unit).toString();
  let fraction = (scaled % unit).toString().padStart(places, "0");
  while (fraction.length > minFraction && fraction.endsWith("0")) fraction = fraction.slice(0, -1);
  return fraction === "" ? whole : `${whole}.${fraction}`;
}

/**
 * VAT percent with exactly 2 decimals: 19 → "19.00", 7.5 → "7.50", 0 → "0.00".
 * Throws RangeError for non-finite or negative input and for more than 2
 * decimals, which vatRateSchema never lets through.
 */
export function formatPercent(rate: number): string {
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
    throw new RangeError(`Invalid VAT rate: ${rate}`);
  }
  const parts = toDecimalParts(rate);
  const scaled = roundToPlaces(parts, 2);
  if (roundToPlaces(parts, 6) !== scaled * TEN_THOUSAND) {
    throw new RangeError(`VAT rate has more than 2 decimals: ${rate}`);
  }
  return scaledToString(scaled, 2, 2);
}

/**
 * A non-negative decimal with at least 2 and at most `maxFractionDigits`
 * fraction digits, ties away from zero: 95 → "95.00", 87.5 → "87.50",
 * 33.3333333 → "33.333333". Used for the net price (BT-146).
 * Throws RangeError on non-finite, negative (BR-27) or out-of-range input.
 */
export function formatDecimal(value: number, maxFractionDigits = 6): string {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`Invalid decimal: ${value}`);
  }
  if (value >= MAX_SAFE_DECIMAL) throw new RangeError(`Decimal out of range: ${value}`);
  if (!Number.isInteger(maxFractionDigits) || maxFractionDigits < 2 || maxFractionDigits > 12) {
    throw new RangeError(`Invalid fraction digits: ${maxFractionDigits}`);
  }
  const scaled = roundToPlaces(toDecimalParts(value), maxFractionDigits);
  return scaledToString(scaled, maxFractionDigits, 2);
}

function parseIso(iso: string): Date {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new RangeError(`Invalid date: ${iso}`);
  return date;
}

const pad = (value: number, width: number): string => String(value).padStart(width, "0");

/** ISO string → "YYYYMMDD" from the UTC calendar date. For issueDate / dueDate. */
export function utcDateKey(iso: string): string {
  const date = parseIso(iso);
  return `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1, 2)}${pad(date.getUTCDate(), 2)}`;
}

/** ISO string → "YYYYMMDD" from the process-local calendar date. For `from`. */
export function localDateKey(iso: string): string {
  const date = parseIso(iso);
  return `${pad(date.getFullYear(), 4)}${pad(date.getMonth() + 1, 2)}${pad(date.getDate(), 2)}`;
}

/**
 * Exclusive end bound → the last billed day, "YYYYMMDD" in process-local time.
 * `Invoice.to` is midnight of the day AFTER the last billed day, so the raw
 * bound is one day late. For BT-72 and BT-74.
 */
export function lastBilledDateKey(iso: string): string {
  const date = parseIso(iso);
  return localDateKey(new Date(date.getTime() - 1).toISOString());
}

const dashed = (key: string): string => `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}`;

/** The billed period as "YYYY-MM-DD" calendar dates: the first and the last billed day. */
export function billedPeriodDates(from: string, to: string): { start: string; end: string } {
  return { start: dashed(localDateKey(from)), end: dashed(lastBilledDateKey(to)) };
}

/** The filename-safe form of an invoice number: [^A-Za-z0-9_-]+ → "-", dashes trimmed, max 60, "document" when empty. */
export function safeFilenamePart(invoiceNumber: string): string {
  const safe = invoiceNumber
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return safe === "" ? "document" : safe;
}
