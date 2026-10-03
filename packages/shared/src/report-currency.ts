import { normalizeCurrency, sumAmounts } from "./rates.js";

/** Earnings retain their entry currency. No exchange rate is implied. */
export type CurrencyAmount = { currency: string; amount: number };
export type CurrencyAmounts = CurrencyAmount[] | null;

/** Sum independently in each currency, with the same cent rounding as entries. */
export const sumCurrencyAmounts = (
  entries: readonly { currency: string; amount: number | null }[],
): CurrencyAmounts => {
  const buckets = new Map<string, number[]>();
  for (const entry of entries) {
    if (entry.amount === null) return null;
    if (entry.amount === 0) continue;
    const currency = normalizeCurrency(entry.currency);
    const bucket = buckets.get(currency) ?? [];
    bucket.push(entry.amount);
    buckets.set(currency, bucket);
  }
  return [...buckets].sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, amounts]) => ({ currency, amount: sumAmounts(amounts) }))
    .filter((bucket) => bucket.amount !== 0);
};

/** Legacy scalar fields are valid only when all earnings share a currency. */
export const singleCurrencyMoney = (
  amounts: CurrencyAmounts,
  fallbackCurrency: string,
): { amount: number | null; currency: string } => ({
  amount: amounts === null || amounts.length > 1 ? null : (amounts[0]?.amount ?? 0),
  currency: amounts?.length === 1 ? amounts[0]!.currency : fallbackCurrency,
});
