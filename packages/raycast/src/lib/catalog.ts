/**
 * Shared bits of the catalog forms: what "no client" is in a dropdown, and how
 * the numeric project fields survive a round trip through a text field.
 */

/** `""` is the dropdown's stand-in for "no client"/"no project"/"no task". */
export const NONE = "";

/**
 * Read an optional number out of a form field.
 *
 * Three outcomes, all meaningful: empty clears the value (`null`), a number
 * sets it, and anything else is a mistake the caller must refuse rather than
 * silently turn into a cleared field.
 */
export const parseOptionalNumber = (raw: string): { ok: true; value: number | null } | { ok: false } => {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: null };

  // Commas are what a German keyboard produces for a decimal point, and the
  // number this becomes is money — worth accepting rather than rejecting.
  const value = Number(trimmed.replace(",", "."));
  if (!Number.isFinite(value) || value < 0) return { ok: false };
  return { ok: true, value };
};
