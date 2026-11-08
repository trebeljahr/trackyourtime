/**
 * The ZUGFeRD font set from font bytes, for a runtime without a filesystem (an
 * encrypted workspace's browser, which fetches the same Noto files the server
 * reads from `assets/fonts`).
 *
 * The glyph test is the server's (`services/pdf-fonts.ts`): pdfkit keeps the
 * fontkit instance of the current font at `doc._font.font`. That is private
 * API, so it is reached through a structural check that throws when pdfkit
 * moves it, and the server's `pdf-fonts.test.ts` pins it.
 */
import type { ZugferdFonts } from "./zugferd.js";

type PdfDocumentConstructor = new (options?: PDFKit.PDFDocumentOptions) => PDFKit.PDFDocument;

const isObject = (value: unknown): value is object => typeof value === "object" && value !== null;

function glyphTest(doc: PDFKit.PDFDocument): (codePoint: number) => boolean {
  const current: unknown = "_font" in doc ? (doc as { _font?: unknown })._font : undefined;
  const font: unknown = isObject(current) && "font" in current ? (current as { font?: unknown }).font : undefined;
  if (!isObject(font) || !("hasGlyphForCodePoint" in font)) throw new Error("pdfkit internals changed: cannot read glyph coverage");
  const fn: unknown = (font as { hasGlyphForCodePoint?: unknown }).hasGlyphForCodePoint;
  if (typeof fn !== "function") throw new Error("pdfkit internals changed: cannot read glyph coverage");
  return (codePoint: number): boolean => Boolean(fn.call(font, codePoint));
}

/** Both faces, and whether BOTH have a glyph for a code point (memoised). */
export function zugferdFontsFromBytes(PDFDocument: PdfDocumentConstructor, regular: Uint8Array, bold: Uint8Array): ZugferdFonts {
  // A throwaway document that is never drawn on or ended: only the way to
  // reach pdfkit's own font parser.
  const doc = new PDFDocument({ autoFirstPage: false, font: "" });
  doc.font(regular as unknown as string);
  const hasRegular = glyphTest(doc);
  doc.font(bold as unknown as string);
  const hasBold = glyphTest(doc);
  const memo = new Map<number, boolean>();
  return {
    regular: regular as unknown as ZugferdFonts["regular"],
    bold: bold as unknown as ZugferdFonts["bold"],
    hasGlyph(codePoint: number): boolean {
      const known = memo.get(codePoint);
      if (known !== undefined) return known;
      const result = hasRegular(codePoint) && hasBold(codePoint);
      memo.set(codePoint, result);
      return result;
    },
  };
}
