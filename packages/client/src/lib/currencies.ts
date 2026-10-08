// The currencies the pickers offer, shared by billing settings and the
// new-workspace dialog.

/**
 * ISO 4217 codes offered in the picker. Any 3-letter code is valid server-side.
 * Names come from `Intl.DisplayNames` in the rendered language.
 */
export const CURRENCIES: readonly string[] = [
  "EUR",
  "USD",
  "GBP",
  "CHF",
  "SEK",
  "NOK",
  "DKK",
  "PLN",
  "CZK",
  "CAD",
  "AUD",
  "NZD",
  "JPY",
  "SGD",
  "HKD",
  "INR",
  "BRL",
  "MXN",
  "ZAR",
];

/** "Euro" / "Euro", "US Dollar" / "US-Dollar"; the code itself when Intl has no name. */
export const currencyName = (code: string, intlLocale: string): string => {
  try {
    return new Intl.DisplayNames([intlLocale], { type: "currency" }).of(code) ?? code;
  } catch {
    return code;
  }
};
