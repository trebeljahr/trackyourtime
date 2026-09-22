/**
 * Invoice lines of two kinds, and the one way to read either.
 *
 * A TIME line is rolled up from tracked entries: `seconds` is its authority,
 * `hours` its rounded quantity and `hourlyRate` its price. A MANUAL line is
 * typed onto a draft: `quantity` of a `unit` at a `unitPrice`. Every line
 * stored before manual lines existed carries none of the new keys and is a
 * time line, so the readers here default rather than require — a document a
 * customer holds must read exactly as it did.
 *
 * Imports only `zod`, so `types.ts` and `schemas.ts` can both import from
 * here without a cycle.
 */
import { z } from "zod";

/** What a line bills: rolled-up tracked time, or something typed by hand. */
export const INVOICE_LINE_KINDS = ["time", "manual"] as const;
export type InvoiceLineKind = (typeof INVOICE_LINE_KINDS)[number];

/**
 * The unit a line's quantity is counted in. `hour` is every time line and the
 * default; `day` and `piece` exist for manual lines (a daily rate, a fixed
 * fee). Each maps to one UN/ECE Rec 20 code in the e-invoice XML.
 */
export const INVOICE_LINE_UNITS = ["hour", "day", "piece"] as const;
export type InvoiceLineUnit = (typeof INVOICE_LINE_UNITS)[number];
export const invoiceLineUnitSchema = z.enum(INVOICE_LINE_UNITS);

/** BT-130 unit codes (UN/ECE Recommendation 20). C62 is "one" — a piece. */
export const INVOICE_LINE_UNIT_CODES: Readonly<Record<InvoiceLineUnit, string>> = {
  hour: "HUR",
  day: "DAY",
  piece: "C62",
};

/**
 * The shape both readers below accept: the stored keys, each optional, so a
 * legacy row (none of them) and a manual row (all of them) read the same way.
 */
export type InvoiceLineLike = {
  kind?: InvoiceLineKind | undefined;
  hours: number;
  hourlyRate: number;
  quantity?: number | undefined;
  unit?: InvoiceLineUnit | undefined;
  unitPrice?: number | undefined;
};

/** Absent = time: every row written before manual lines existed. */
export function lineKind(line: Pick<InvoiceLineLike, "kind">): InvoiceLineKind {
  return line.kind === "manual" ? "manual" : "time";
}

/** The billed quantity: a manual line's own, a time line's decimal hours. */
export function lineQuantity(line: InvoiceLineLike): number {
  return typeof line.quantity === "number" && Number.isFinite(line.quantity)
    ? line.quantity
    : line.hours;
}

/** The quantity's unit: hours unless the line says otherwise. */
export function lineUnit(line: Pick<InvoiceLineLike, "unit">): InvoiceLineUnit {
  return line.unit ?? "hour";
}

/** The price of one unit: a manual line's own, a time line's hourly rate. */
export function lineUnitPrice(line: InvoiceLineLike): number {
  return typeof line.unitPrice === "number" && Number.isFinite(line.unitPrice)
    ? line.unitPrice
    : line.hourlyRate;
}

/**
 * Keys of manual lines: a fixed prefix, so one can never collide with a time
 * line's key (a project or task id, `none`, or either with an `@rate` suffix)
 * and both sides can tell the kinds apart from the key alone. The id part is
 * chosen by whoever adds the line — the web app before its first save, so
 * its VAT choice can address the line — or by the server when none was sent.
 */
export const MANUAL_LINE_KEY_PREFIX = "manual:";
export const MANUAL_LINE_KEY_PATTERN = /^manual:[A-Za-z0-9_-]{1,64}$/;

export function isManualLineKey(key: string): boolean {
  return MANUAL_LINE_KEY_PATTERN.test(key);
}

const KEY_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** A fresh `manual:<12 chars>` key. Random, so two devices editing one draft cannot pick the same id. */
export function newManualLineKey(random: () => number = Math.random): string {
  let id = "";
  for (let i = 0; i < 12; i++) {
    id += KEY_ALPHABET[Math.floor(random() * KEY_ALPHABET.length)] ?? "a";
  }
  return `${MANUAL_LINE_KEY_PREFIX}${id}`;
}

/** Bounds shared by the schemas and the editors. */
export const MANUAL_LINE_LIMITS = {
  label: 300,
  /** Quantity decimals: a quarter day, a thousandth of an hour. */
  quantityDecimals: 3,
  quantityMax: 1_000_000,
  /** Price decimals: cents. */
  unitPriceDecimals: 2,
  unitPriceMax: 100_000_000,
  linesPerInvoice: 200,
} as const;

const hasAtMostDecimals = (value: number, decimals: number): boolean => {
  const scaled = value * 10 ** decimals;
  return Math.abs(scaled - Math.round(scaled)) < 1e-6;
};

/** > 0 with at most 3 decimals; `zod` refuses the rest before the server sees it. */
export const manualLineQuantitySchema = z
  .number()
  .positive()
  .max(MANUAL_LINE_LIMITS.quantityMax)
  .refine(
    (value) => hasAtMostDecimals(value, MANUAL_LINE_LIMITS.quantityDecimals),
    `At most ${MANUAL_LINE_LIMITS.quantityDecimals} decimals`,
  );

/** ≥ 0 with at most 2 decimals. 0 is a real price: a line given for free. */
export const manualLineUnitPriceSchema = z
  .number()
  .min(0)
  .max(MANUAL_LINE_LIMITS.unitPriceMax)
  .refine(
    (value) => hasAtMostDecimals(value, MANUAL_LINE_LIMITS.unitPriceDecimals),
    `At most ${MANUAL_LINE_LIMITS.unitPriceDecimals} decimals`,
  );

/**
 * `quantity × unitPrice`, rounded once to whole cents, half away from zero,
 * in integers: thousandths of a unit times cents is exact, and a float product
 * (`1.005 * 100`) is not. Both the server (when it stores a line) and the web
 * app (while a line is typed) call this, so the amount on screen is the amount
 * that will be saved.
 */
export function manualLineAmount(quantity: number, unitPrice: number): number {
  if (!Number.isFinite(quantity) || !Number.isFinite(unitPrice)) return 0;
  const thousandths = Math.round(quantity * 1000);
  const cents = Math.round(unitPrice * 100);
  const product = thousandths * cents; // in 1e-5 currency units
  const sign = product < 0 ? -1 : 1;
  const absolute = Math.abs(product);
  const remainder = absolute % 1000;
  const whole = (absolute - remainder) / 1000;
  const roundedCents = remainder * 2 >= 1000 ? whole + 1 : whole;
  const amount = (sign * roundedCents) / 100;
  return amount === 0 ? 0 : amount;
}
