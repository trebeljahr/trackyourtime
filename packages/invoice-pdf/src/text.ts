/**
 * Text hygiene for a PDF cell, shared by the invoice renderer, the e-invoice
 * blocks and the server's report renderer (which re-exports this).
 *
 * One cell is one line: control chars out, runs of whitespace collapsed.
 *
 * Except U+00A0 NO-BREAK SPACE, which is kept: German figures put one between
 * a number and its unit, WinAnsi can draw it, and collapsing it into an
 * ordinary space would split the number from the unit in any run that wraps.
 */

/**
 * C0/C1 control characters plus the Unicode line/paragraph separators. None of
 * these have a glyph; they exist in exported text only by accident (a pasted
 * description, a stray NUL from an import) and would otherwise be handed to
 * the font's encoder as undefined code points.
 */
const CONTROL_CHARS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/g;

export function sanitizePdfText(value: string): string {
  return value.replace(CONTROL_CHARS, " ").replace(/[^\S\u00a0]+/g, " ").trim();
}
