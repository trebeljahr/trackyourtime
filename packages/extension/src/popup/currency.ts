/** Currency glyphs match the web tracker, including text fallbacks. */
import {
  Banknote,
  Bitcoin,
  DollarSign,
  Euro,
  IndianRupee,
  JapaneseYen,
  PoundSterling,
  RussianRuble,
  SwissFranc,
  type LucideIcon,
} from "lucide-react";

/**
 * Codes lucide draws a dedicated symbol for. Everything else falls back to the
 * currency's own text symbol, so "kr" and "zł" still read correctly.
 */
const ICONS: Record<string, LucideIcon> = {
  EUR: Euro,
  GBP: PoundSterling,
  CHF: SwissFranc,
  INR: IndianRupee,
  RUB: RussianRuble,
  BTC: Bitcoin,
  // Both render "¥".
  JPY: JapaneseYen,
  CNY: JapaneseYen,
  // The dollar family shares one glyph, exactly as the real symbols do.
  USD: DollarSign,
  CAD: DollarSign,
  AUD: DollarSign,
  NZD: DollarSign,
  SGD: DollarSign,
  HKD: DollarSign,
  MXN: DollarSign,
  TWD: DollarSign,
  ARS: DollarSign,
  CLP: DollarSign,
  COP: DollarSign,
};

/** The lucide icon for `currency`, or null when only a text symbol will do. */
export const currencyIcon = (currency: string): LucideIcon | null =>
  ICONS[currency.toUpperCase()] ?? null;

/** Generic stand-in wherever the slot demands an icon component. */
export const CURRENCY_FALLBACK_ICON: LucideIcon = Banknote;

const symbols = new Map<string, string>();

/**
 * The bare symbol for a code — "€", "kr", "zł". Falls back to the code itself
 * for anything `Intl` rejects.
 */
export const currencySymbol = (currency: string): string => {
  const key = currency.toUpperCase();
  const cached = symbols.get(key);
  if (cached !== undefined) return cached;

  let symbol = key;
  if (/^[A-Z]{3}$/.test(key)) {
    try {
      const parts = new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: key,
        currencyDisplay: "narrowSymbol",
      }).formatToParts(0);
      symbol = parts.find((part) => part.type === "currency")?.value ?? key;
    } catch {
      // Unknown ISO code — the code itself is the most honest glyph we have.
    }
  }

  symbols.set(key, symbol);
  return symbol;
};
