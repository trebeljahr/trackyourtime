import { normalizeCurrency } from "./rates.js";

/** Earnings retain their entry currency. No exchange rate is implied. */
export type CurrencyAmount = { currency: string; amount: number };
export type CurrencyAmounts = CurrencyAmount[] | null;

/**
 * {@link sumCurrencyAmounts} one entry at a time, for a report too large to
 * hold as an array (the streamed detailed export). Same arithmetic in the same
 * order — a running sum of `amount * 100` per currency, exactly what
 * `sumAmounts` reduces — so folding a list through it gives the identical
 * result, bit for bit.
 */
export type CurrencyAmountsAccumulator = {
  add: (entry: { currency: string; amount: number | null }) => void;
  result: () => CurrencyAmounts;
};

export const currencyAmountsAccumulator = (): CurrencyAmountsAccumulator => {
  const cents = new Map<string, number>();
  let withheld = false;
  return {
    add: (entry) => {
      if (withheld) return;
      if (entry.amount === null) {
        withheld = true;
        return;
      }
      if (entry.amount === 0) return;
      const currency = normalizeCurrency(entry.currency);
      cents.set(currency, (cents.get(currency) ?? 0) + entry.amount * 100);
    },
    result: () =>
      withheld
        ? null
        : [...cents]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([currency, total]) => ({ currency, amount: Math.round(total) / 100 }))
            .filter((bucket) => bucket.amount !== 0),
  };
};

/** Sum independently in each currency, with the same cent rounding as entries. */
export const sumCurrencyAmounts = (
  entries: readonly { currency: string; amount: number | null }[],
): CurrencyAmounts => {
  const sum = currencyAmountsAccumulator();
  for (const entry of entries) sum.add(entry);
  return sum.result();
};

/** Legacy scalar fields are valid only when all earnings share a currency. */
export const singleCurrencyMoney = (
  amounts: CurrencyAmounts,
  fallbackCurrency: string,
): { amount: number | null; currency: string } => ({
  amount: amounts === null || amounts.length > 1 ? null : (amounts[0]?.amount ?? 0),
  currency: amounts?.length === 1 ? amounts[0]!.currency : fallbackCurrency,
});
