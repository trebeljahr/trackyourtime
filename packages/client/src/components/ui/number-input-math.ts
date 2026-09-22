/**
 * The arithmetic behind `NumberInput`, kept apart from React so it is tested
 * without a DOM.
 *
 * The field holds a string, never a number: "1." and "" are states a person
 * types through, and a field that parsed on every keystroke would either
 * refuse them or save them. Parsing happens here, where a caller asks for it.
 */

export type StepOptions = {
  /** How far one press of the stepper or an arrow key moves. */
  step: number;
  min?: number;
  max?: number;
  /** Decimals kept after a step, so 0.1 + 0.2 never lands in the field. */
  precision: number;
};

/**
 * A typed number, or `null` when the text is blank or not a number.
 *
 * A comma is what a German keyboard produces for a decimal point. Accepted in
 * every language rather than only in German: the keyboard, not the interface
 * language, decides which key a person reaches for.
 */
export const parseDecimalInput = (raw: string): number | null => {
  const normalized = raw.trim().replace(",", ".");
  if (normalized === "") return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
};

/** Round to `precision` decimals and print without float noise. */
export const formatNumberInput = (value: number, precision: number): string => {
  const factor = 10 ** precision;
  const rounded = Math.round(value * factor) / factor;
  // `toFixed` would print "100.00" for a rate of 100; `String` prints "100".
  return String(Object.is(rounded, -0) ? 0 : rounded);
};

const clamp = (value: number, min: number | undefined, max: number | undefined): number =>
  Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min ?? Number.NEGATIVE_INFINITY, value));

/**
 * The text after one step up or down from what is in the field.
 *
 * A blank field steps from zero, which the bounds then pull into range — so
 * an empty "minutes" field with a minimum of 1 answers "1" on the first press,
 * as the native control does. A field holding text that is not a number
 * steps from zero the same way, rather than refusing the press.
 */
export const stepNumberInput = (
  raw: string,
  direction: 1 | -1,
  { step, min, max, precision }: StepOptions,
): string => {
  const current = parseDecimalInput(raw) ?? 0;
  return formatNumberInput(clamp(current + direction * step, min, max), precision);
};

/** Whether a step in `direction` would change nothing, so its button can rest. */
export const atStepBound = (
  raw: string,
  direction: 1 | -1,
  { min, max }: Pick<StepOptions, "min" | "max">,
): boolean => {
  const current = parseDecimalInput(raw);
  if (current === null) return false;
  return direction > 0 ? max !== undefined && current >= max : min !== undefined && current <= min;
};
