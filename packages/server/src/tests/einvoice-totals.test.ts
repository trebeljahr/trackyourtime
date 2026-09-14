// EN 16931 arithmetic: integer cents, VAT per breakdown row, half away from zero.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TaxBreakdownRow } from "@starter/shared";
import {
  billedHoursQuantity,
  breakdownAmountsEqual,
  centsToAmount,
  commonTaxRate,
  compareStoredTotals,
  computeEn16931Totals,
  divRoundHalfAwayFromZero,
  formatCents,
  isLineNetConsistent,
  rateToBasisPoints,
  toCents,
  vatCents,
  type TaxedLine,
} from "../services/einvoice/totals.js";

const s = (amount: number, taxRate = 19): TaxedLine => ({ amount, taxCategory: "S", taxRate });

describe("cents", () => {
  it("converts 2-dp amounts exactly, including float artefacts", () => {
    assert.equal(toCents(0.1 + 0.2), 30);
    assert.equal(toCents(1.15), 115);
    assert.equal(toCents(-12.34), -1234);
    assert.equal(Object.is(toCents(-0), 0), true);
    assert.equal(centsToAmount(123456), 1234.56);
  });

  it("refuses more than 2 decimals and non-finite amounts", () => {
    assert.throws(() => toCents(1.005), RangeError);
    assert.throws(() => toCents(Number.NaN), RangeError);
    assert.throws(() => toCents(Number.POSITIVE_INFINITY), RangeError);
  });

  it("formats with exactly two decimals and no exponent", () => {
    assert.equal(formatCents(0), "0.00");
    assert.equal(formatCents(5), "0.05");
    assert.equal(formatCents(-5), "-0.05");
    assert.equal(formatCents(123450), "1234.50");
    assert.equal(formatCents(100_000_000_000_000), "1000000000000.00");
    assert.throws(() => formatCents(1.5), RangeError);
  });
});

describe("rounding", () => {
  it("rounds ties away from zero in both directions", () => {
    assert.equal(divRoundHalfAwayFromZero(5, 10), 1);
    assert.equal(divRoundHalfAwayFromZero(-5, 10), -1);
    assert.equal(divRoundHalfAwayFromZero(4, 10), 0);
    assert.equal(divRoundHalfAwayFromZero(-4, 10), 0);
    assert.equal(divRoundHalfAwayFromZero(15, 10), 2);
    assert.equal(divRoundHalfAwayFromZero(-15, 10), -2);
  });

  it("refuses a non-positive denominator and unsafe integers", () => {
    assert.throws(() => divRoundHalfAwayFromZero(1, 0), RangeError);
    assert.throws(() => divRoundHalfAwayFromZero(2 ** 53, 3), RangeError);
  });

  it("takes rates with up to 2 decimals as basis points", () => {
    assert.equal(rateToBasisPoints(19), 1900);
    assert.equal(rateToBasisPoints(7.5), 750);
    assert.throws(() => rateToBasisPoints(7.125), RangeError);
    assert.throws(() => rateToBasisPoints(101), RangeError);
  });

  it("computes VAT once on the basis", () => {
    // 0.0105 → 0.01 (half away from zero on 1.05 cents).
    assert.equal(vatCents(14, 7.5), 1);
    // 25.3327 → 25.33
    assert.equal(vatCents(13333, 19), 2533);
    // 0.095 → 0.10: a tie rounds away from zero.
    assert.equal(vatCents(50, 19), 10);
    assert.equal(vatCents(-50, 19), -10);
  });
});

describe("computeEn16931Totals", () => {
  it("sums one S row and derives every document total from it", () => {
    const totals = computeEn16931Totals([s(100), s(33.33)], {});
    assert.equal(totals.lineTotalCents, 13333);
    assert.equal(totals.taxBasisTotalCents, 13333);
    assert.equal(totals.taxTotalCents, 2533);
    assert.equal(totals.grandTotalCents, 15866);
    assert.equal(totals.duePayableCents, 15866);
    assert.deepEqual(
      { subtotal: totals.subtotal, taxAmount: totals.taxAmount, total: totals.total },
      { subtotal: 133.33, taxAmount: 25.33, total: 158.66 },
    );
    assert.deepEqual(totals.breakdown, [
      { category: "S", rate: 19, basisAmount: 133.33, taxAmount: 25.33, exemptionReason: null, exemptionReasonCode: null },
    ]);
  });

  it("taxes the summed row, not each line: many small lines", () => {
    // Per line 0.01 × 19 % = 0.0019 rounds to 0.00; 100 lines summed to 1.00 give 0.19.
    const lines = Array.from({ length: 100 }, () => s(0.01));
    const totals = computeEn16931Totals(lines, {});
    assert.equal(totals.subtotal, 1);
    assert.equal(totals.taxAmount, 0.19);
    assert.equal(totals.total, 1.19);
  });

  it("keeps mixed rates apart and orders S by rate descending, then Z, E, AE, O", () => {
    const totals = computeEn16931Totals(
      [
        { amount: 10, taxCategory: "O", taxRate: 0 },
        s(100, 7),
        { amount: 20, taxCategory: "AE", taxRate: 0 },
        { amount: 30, taxCategory: "E", taxRate: 0 },
        s(200, 19),
        { amount: 40, taxCategory: "Z", taxRate: 0 },
        s(50, 7),
      ],
      { E: "Kleinunternehmer", AE: "Reverse charge", O: "Not subject", Z: "ignored", S: "ignored" },
    );
    assert.deepEqual(
      totals.breakdown.map((row) => [row.category, row.rate, row.basisAmount, row.taxAmount, row.exemptionReason, row.exemptionReasonCode]),
      [
        ["S", 19, 200, 38, null, null],
        ["S", 7, 150, 10.5, null, null],
        ["Z", 0, 40, 0, null, null],
        ["E", 0, 30, 0, "Kleinunternehmer", null],
        ["AE", 0, 20, 0, "Reverse charge", "VATEX-EU-AE"],
        ["O", 0, 10, 0, "Not subject", "VATEX-EU-O"],
      ],
    );
    assert.equal(totals.subtotal, 450);
    assert.equal(totals.taxAmount, 48.5);
    assert.equal(totals.total, 498.5);
  });

  it("leaves a missing note null", () => {
    const totals = computeEn16931Totals([{ amount: 10, taxCategory: "E", taxRate: 0 }], {});
    assert.equal(totals.breakdown[0]?.exemptionReason, null);
  });

  it("totals no lines to zero and handles negative lines", () => {
    assert.equal(computeEn16931Totals([], {}).total, 0);
    const credit = computeEn16931Totals([s(100), s(-0.5)], {});
    assert.equal(credit.subtotal, 99.5);
    // 18.905 → 18.91
    assert.equal(credit.taxAmount, 18.91);
  });

  it("refuses corrupt amounts rather than rounding them silently", () => {
    assert.throws(() => computeEn16931Totals([s(10.005)], {}), RangeError);
  });
});

describe("stored totals and breakdowns", () => {
  const recomputed = computeEn16931Totals([s(100), s(33.33)], {});

  it("finds identical stored totals equal", () => {
    assert.equal(compareStoredTotals({ subtotal: 133.33, taxAmount: 25.33, total: 158.66 }, recomputed), null);
  });

  it("reports a difference of one cent with both figure sets", () => {
    assert.deepEqual(compareStoredTotals({ subtotal: 133.33, taxAmount: 25.34, total: 158.67 }, recomputed), {
      stored: { subtotal: 133.33, taxAmount: 25.34, total: 158.67 },
      recomputed: { subtotal: 133.33, taxAmount: 25.33, total: 158.66 },
    });
  });

  it("compares breakdown amounts, ignoring the exemption text", () => {
    const row: TaxBreakdownRow = { category: "E", rate: 0, basisAmount: 10, taxAmount: 0, exemptionReason: "a", exemptionReasonCode: null };
    assert.equal(breakdownAmountsEqual([row], [{ ...row, exemptionReason: null }]), true);
    assert.equal(breakdownAmountsEqual([row], [{ ...row, basisAmount: 10.01 }]), false);
    assert.equal(breakdownAmountsEqual([row], [{ ...row, category: "O" }]), false);
    assert.equal(breakdownAmountsEqual([row], []), false);
  });

  it("finds the common rate, or null when lines differ", () => {
    assert.equal(commonTaxRate([s(1), s(2)]), 19);
    assert.equal(commonTaxRate([s(1), s(2, 7)]), null);
    assert.equal(commonTaxRate([]), null);
  });
});

describe("hours quantity", () => {
  it("prints up to 6 decimals, trimmed", () => {
    assert.equal(billedHoursQuantity(0), "0");
    assert.equal(billedHoursQuantity(3600), "1");
    assert.equal(billedHoursQuantity(45000), "12.5");
    assert.equal(billedHoursQuantity(1234), "0.342778");
    // 1 s = 0.000277777… → 0.000278
    assert.equal(billedHoursQuantity(1), "0.000278");
  });

  it("checks a line net against quantity × rate within a cent", () => {
    assert.equal(isLineNetConsistent(45000, 95, 1187.5), true);
    assert.equal(isLineNetConsistent(1234, 100, 34.28), true);
    assert.equal(isLineNetConsistent(3600, 100, 100.02), false);
  });
});
