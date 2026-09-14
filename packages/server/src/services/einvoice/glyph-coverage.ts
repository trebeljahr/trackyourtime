/**
 * Glyph coverage for the PDF/A rendering.
 *
 * A text run that references a glyph the embedded font does not have draws
 * `.notdef`, and PDF/A-3 (6.2.11.4.1, 6.2.11.8) rejects that. The file then
 * fails validation with nothing visibly wrong on the page. So before drawing,
 * every code point the font lacks is replaced with "?" in a COPY of the invoice.
 *
 * Only the drawn copy is touched. The embedded XML is the leading part of the
 * hybrid and keeps the real text; the BMF tolerates rendering differences in the
 * image part.
 */
import type { Invoice } from "@starter/shared";

export type HasGlyph = (codePoint: number) => boolean;

/** "\n" and "\t" are layout, not glyphs: the renderer turns them into spacing. */
const LAYOUT_CODE_POINTS = new Set([0x09, 0x0a, 0x0d]);

/** Every code point `hasGlyph` rejects becomes "?". Walks code points, so an astral character becomes one "?". */
export function coverText(text: string, hasGlyph: HasGlyph): string {
  let out = "";
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    out += LAYOUT_CODE_POINTS.has(codePoint) || hasGlyph(codePoint) ? char : "?";
  }
  return out;
}

const coverNullable = (value: string | null, hasGlyph: HasGlyph): string | null =>
  value === null ? null : coverText(value, hasGlyph);

/**
 * Every string leaf of a flat party snapshot (issuer or recipient), string
 * arrays included (`addressLines`). Booleans, numbers and nulls are copied.
 * Generic on purpose: a field added to `InvoiceIssuer` later is drawn by the
 * renderer long before anyone remembers this file.
 */
function coverParty<P extends object>(party: P, hasGlyph: HasGlyph): P {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(party)) {
    if (typeof value === "string") out[key] = coverText(value, hasGlyph);
    else if (Array.isArray(value)) {
      out[key] = value.map((item: unknown) => (typeof item === "string" ? coverText(item, hasGlyph) : item));
    } else out[key] = value;
  }
  return out as P;
}

/**
 * A copy of the invoice with `coverText` applied to every string the renderer
 * draws: number, clientName, notes, paymentTerms, line labels, every string leaf
 * of the issuer and recipient snapshots, and the breakdown's exemption reasons. Numbers, ids,
 * dates and the input object are untouched.
 */
export function coverInvoiceText<T extends Invoice>(invoice: T, hasGlyph: HasGlyph): T {
  return {
    ...invoice,
    number: coverText(invoice.number, hasGlyph),
    clientName: coverText(invoice.clientName, hasGlyph),
    notes: coverNullable(invoice.notes, hasGlyph),
    lineItems: invoice.lineItems.map((line) => ({
      ...line,
      label: coverText(line.label, hasGlyph),
    })),
    ...(invoice.paymentTerms === undefined
      ? {}
      : { paymentTerms: coverNullable(invoice.paymentTerms, hasGlyph) }),
    ...(invoice.issuer === undefined || invoice.issuer === null
      ? {}
      : { issuer: coverParty(invoice.issuer, hasGlyph) }),
    ...(invoice.recipient === undefined || invoice.recipient === null
      ? {}
      : { recipient: coverParty(invoice.recipient, hasGlyph) }),
    ...(invoice.taxBreakdown === undefined
      ? {}
      : {
          taxBreakdown: invoice.taxBreakdown.map((row) => ({
            ...row,
            exemptionReason: coverNullable(row.exemptionReason, hasGlyph),
          })),
        }),
  };
}
