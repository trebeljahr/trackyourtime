// EN 16931 arithmetic in integer cents.
//
// Every amount on an invoice is a 2-dp number, and EN 16931 checks its sums
// with exact equality (BR-CO-10 … BR-CO-17). Floats cannot promise that, so
// every sum here runs on integer cents and every division rounds once, half
// away from zero. VAT is computed per breakdown row from the summed line nets
// of that row, never per line and then summed.
import {
  VATEX_CODES,
  type TaxBreakdownRow,
  type TaxCategory,
  type TotalsMismatch,
} from "@starter/shared";

/** 2-dp amount → integer cents. RangeError for non-finite input or more than 2 decimals. */
export function toCents(amount: number): number {
  if (!Number.isFinite(amount)) throw new RangeError(`Amount is not a finite number: ${amount}`);
  const cents = Math.round(amount * 100);
  if (Math.abs(amount * 100 - cents) > 1e-6) {
    throw new RangeError(`Amount has more than 2 decimals: ${amount}`);
  }
  if (!Number.isSafeInteger(cents)) throw new RangeError(`Amount is too large: ${amount}`);
  // Math.round(-0.001) is -0, which would print as "-0.00".
  return cents === 0 ? 0 : cents;
}

/** Integer cents → 2-dp number, for storage and the wire. */
export function centsToAmount(cents: number): number {
  assertSafeInteger(cents, "cents");
  return cents / 100;
}

/** Integer cents → "1234.50" / "-0.05". Exactly 2 decimals, no exponent, no grouping. */
export function formatCents(cents: number): string {
  assertSafeInteger(cents, "cents");
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  const whole = Math.floor(absolute / 100);
  const fraction = String(absolute % 100).padStart(2, "0");
  return `${sign}${whole}.${fraction}`;
}

/** round(numerator / denominator), ties away from zero, exact on safe integers. */
export function divRoundHalfAwayFromZero(numerator: number, denominator: number): number {
  assertSafeInteger(numerator, "numerator");
  assertSafeInteger(denominator, "denominator");
  if (denominator <= 0) throw new RangeError(`Denominator must be positive: ${denominator}`);
  const remainder = numerator % denominator;
  const quotient = (numerator - remainder) / denominator;
  if (Math.abs(remainder) * 2 >= denominator) {
    return quotient + Math.sign(numerator);
  }
  return quotient === 0 ? 0 : quotient;
}

/** 19 → 1900, 7.5 → 750. RangeError for more than 2 decimals or outside 0–100. */
export function rateToBasisPoints(rate: number): number {
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
    throw new RangeError(`VAT rate must be between 0 and 100: ${rate}`);
  }
  return toCents(rate);
}

/** VAT in cents for a basis in cents (BR-CO-17): basis × rate / 100, rounded once. */
export function vatCents(basisCents: number, rate: number): number {
  const product = basisCents * rateToBasisPoints(rate);
  return divRoundHalfAwayFromZero(product, 10_000);
}

export type TaxedLine = { amount: number; taxCategory: TaxCategory; taxRate: number };

/** BT-120 texts by category, already resolved (defaults applied). */
export type ResolvedExemptionNotes = Readonly<Partial<Record<TaxCategory, string | null>>>;

export type En16931Totals = {
  /** BT-106 = Σ line nets (BR-CO-10). */
  lineTotalCents: number;
  /** BT-109 = BT-106; no document-level allowances or charges (BR-CO-13). */
  taxBasisTotalCents: number;
  /** BT-110 = Σ breakdown tax (BR-CO-14). */
  taxTotalCents: number;
  /** BT-112 = BT-109 + BT-110 (BR-CO-15). */
  grandTotalCents: number;
  /** BT-115 = BT-112; nothing prepaid, no rounding amount (BR-CO-16). */
  duePayableCents: number;
  breakdown: TaxBreakdownRow[];
  /** For the invoice document: subtotal = BT-109, taxAmount = BT-110, total = BT-112. */
  subtotal: number;
  taxAmount: number;
  total: number;
};

/** Stable BG-23 order: S, Z, E, AE, O; within S by rate descending. */
export const BREAKDOWN_CATEGORY_ORDER: readonly TaxCategory[] = ["S", "Z", "E", "AE", "O"];

/**
 * Groups lines by (category, rate). basis = Σ line cents of the group
 * (BR-S-08 and siblings), tax = vatCents(basis, rate) per group.
 * exemptionReason = notes[category] for E/AE/O and null for S/Z;
 * exemptionReasonCode from VATEX_CODES.
 */
export function computeEn16931Totals(
  lines: readonly TaxedLine[],
  notes: ResolvedExemptionNotes,
): En16931Totals {
  const groups = new Map<string, { category: TaxCategory; rate: number; basisPoints: number; basis: number }>();
  let lineTotal = 0;
  for (const line of lines) {
    const cents = toCents(line.amount);
    const basisPoints = rateToBasisPoints(line.taxRate);
    lineTotal += cents;
    const key = `${line.taxCategory}:${basisPoints}`;
    const group = groups.get(key) ?? {
      category: line.taxCategory,
      rate: line.taxRate,
      basisPoints,
      basis: 0,
    };
    group.basis += cents;
    groups.set(key, group);
  }
  assertSafeInteger(lineTotal, "line total");

  const ordered = [...groups.values()].sort((a, b) => {
    const byCategory =
      BREAKDOWN_CATEGORY_ORDER.indexOf(a.category) - BREAKDOWN_CATEGORY_ORDER.indexOf(b.category);
    return byCategory !== 0 ? byCategory : b.basisPoints - a.basisPoints;
  });

  let taxTotal = 0;
  const breakdown = ordered.map((group): TaxBreakdownRow => {
    const tax = divRoundHalfAwayFromZero(group.basis * group.basisPoints, 10_000);
    taxTotal += tax;
    const carriesReason = group.category !== "S" && group.category !== "Z";
    return {
      category: group.category,
      rate: group.basisPoints / 100,
      basisAmount: group.basis / 100,
      taxAmount: tax / 100,
      exemptionReason: carriesReason ? (notes[group.category] ?? null) : null,
      exemptionReasonCode: VATEX_CODES[group.category],
    };
  });

  const grandTotal = lineTotal + taxTotal;
  return {
    lineTotalCents: lineTotal,
    taxBasisTotalCents: lineTotal,
    taxTotalCents: taxTotal,
    grandTotalCents: grandTotal,
    duePayableCents: grandTotal,
    breakdown,
    subtotal: lineTotal / 100,
    taxAmount: taxTotal === 0 ? 0 : taxTotal / 100,
    total: grandTotal / 100,
  };
}

/** Cent-exact comparison of stored subtotal/taxAmount/total. null = identical. */
export function compareStoredTotals(
  stored: { subtotal: number; taxAmount: number; total: number },
  recomputed: Pick<En16931Totals, "subtotal" | "taxAmount" | "total">,
): TotalsMismatch | null {
  const same = (a: number, b: number): boolean => {
    const left = safeCents(a);
    const right = safeCents(b);
    return left !== null && right !== null && left === right;
  };
  if (
    same(stored.subtotal, recomputed.subtotal) &&
    same(stored.taxAmount, recomputed.taxAmount) &&
    same(stored.total, recomputed.total)
  ) {
    return null;
  }
  return {
    stored: { subtotal: stored.subtotal, taxAmount: stored.taxAmount, total: stored.total },
    recomputed: {
      subtotal: recomputed.subtotal,
      taxAmount: recomputed.taxAmount,
      total: recomputed.total,
    },
  };
}

/** Same category, rate, basis and tax in the same order. Exemption texts are ignored. */
export function breakdownAmountsEqual(
  a: readonly TaxBreakdownRow[],
  b: readonly TaxBreakdownRow[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((row, index) => {
    const other = b[index];
    if (!other || row.category !== other.category) return false;
    const pairs: Array<[number, number]> = [
      [row.rate, other.rate],
      [row.basisAmount, other.basisAmount],
      [row.taxAmount, other.taxAmount],
    ];
    return pairs.every(([left, right]) => {
      const l = safeCents(left);
      return l !== null && l === safeCents(right);
    });
  });
}

/** Every line's rate if they all share one, else null (also for no lines). */
export function commonTaxRate(lines: readonly TaxedLine[]): number | null {
  const first = lines[0];
  if (!first) return null;
  const firstPoints = safeCents(first.taxRate);
  if (firstPoints === null) return null;
  return lines.every((line) => safeCents(line.taxRate) === firstPoints) ? first.taxRate : null;
}

/**
 * BT-129: seconds / 3600 to 6 decimals, half away from zero, trailing zeros
 * trimmed ("12.5", "0.342778", "0"). Integer math on micro-hours.
 */
export function billedHoursQuantity(seconds: number): string {
  if (!Number.isFinite(seconds)) throw new RangeError(`Seconds is not finite: ${seconds}`);
  const micro = divRoundHalfAwayFromZero(Math.round(seconds * 1_000_000), 3600);
  const sign = micro < 0 ? "-" : "";
  const absolute = Math.abs(micro);
  const whole = Math.floor(absolute / 1_000_000);
  const fraction = String(absolute % 1_000_000)
    .padStart(6, "0")
    .replace(/0+$/, "");
  return fraction === "" ? `${sign}${whole}` : `${sign}${whole}.${fraction}`;
}

/** PEPPOL-EN16931-R120 guard: |quantity (6 dp) × hourly rate − line net| ≤ 0.01. */
export function isLineNetConsistent(seconds: number, hourlyRate: number, amount: number): boolean {
  const quantity = Number(billedHoursQuantity(seconds));
  return Math.abs(quantity * hourlyRate - amount) <= 0.01 + 1e-9;
}

function safeCents(value: number): number | null {
  try {
    return toCents(value);
  } catch {
    return null;
  }
}

function assertSafeInteger(value: number, what: string): void {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${what} must be a safe integer: ${value}`);
}
