import type { CurrencyAmounts } from "@starter/shared";

/**
 * What a report shows in place of money the caller may not see.
 *
 * The server withholds report amounts as `null` for a member who may see
 * colleagues' time but not their money (`moneyVisible: false`). A dash says
 * "not shown to you"; `0` would say "earned nothing", and a blank cell reads
 * as a rendering bug.
 */
export const MONEY_WITHHELD = "—";

/** Format a report amount, or the withheld marker when it is `null`. */
export const formatReportMoney = (
  amount: number | null,
  money: (amount: number) => string
): string => (amount === null ? MONEY_WITHHELD : money(amount));

/**
 * Sum amounts that may be withheld. One `null` makes the sum `null`: a total
 * over rows the caller could only partly price is a partial sum presented as
 * a whole one, which is exactly what the server refuses to compute.
 */
export const sumReportMoney = (
  amounts: readonly (number | null)[]
): number | null => {
  let total = 0;
  for (const amount of amounts) {
    if (amount === null) return null;
    total += amount;
  }
  return total;
};

/** Prefer currency buckets; old servers still supply a scalar and currency. */
export const formatReportAmounts = (
  amounts: CurrencyAmounts | undefined,
  amount: number | null,
  currency: string | undefined,
  money: (amount: number, currency?: string) => string,
): string => amounts === undefined
  ? formatReportMoney(amount, (value) => money(value, currency))
  : amounts === null ? MONEY_WITHHELD
  : amounts.length === 0 ? money(0, currency)
  : amounts.map((bucket) => money(bucket.amount, bucket.currency)).join(" · ");
