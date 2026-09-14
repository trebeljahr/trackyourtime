/**
 * The fonts the e-invoice PDF embeds.
 *
 * PDF/A forbids the standard-14 fonts the plain invoice PDF draws with, because
 * they are referenced by name and never embedded. The PDF/A-3b variant therefore
 * embeds Noto Sans (SIL OFL 1.1), vendored in `packages/server/assets/fonts/`
 * with its licence and the SHA-256 of each file.
 *
 * The files are resolved against THIS module, not the working directory:
 * `src/services/` (tsx, tests) and `dist/services/` (the built image) both sit
 * two levels under the package root, so one relative URL serves both. The
 * Docker runtime stage must copy `assets/` next to `dist/`, or every e-invoice
 * export fails here with the path that was looked for.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";

export type PdfFonts = {
  /** Absolute paths. pdfkit's typings accept only a path for the constructor's `font` option. */
  paths: { regular: string; bold: string };
  regular: Buffer;
  bold: Buffer;
  /** True iff BOTH faces have a glyph for the code point. */
  hasGlyph(codePoint: number): boolean;
};

export const PDF_FONT_FILES = {
  regular: "NotoSans-Regular.ttf",
  bold: "NotoSans-Bold.ttf",
} as const;

/** The folder holding the vendored fonts, their licence and README. */
export const pdfFontsDirectory = (): string =>
  fileURLToPath(new URL("../../assets/fonts/", import.meta.url));

const fontPath = (file: string): string =>
  fileURLToPath(new URL(`../../assets/fonts/${file}`, import.meta.url));

function readFont(file: string): { path: string; bytes: Buffer } {
  const path = fontPath(file);
  if (!existsSync(path)) {
    throw new Error(
      `Font file missing: ${path}. The e-invoice PDF embeds the fonts in packages/server/assets/fonts; ` +
        "a Docker image needs `COPY --from=build /prod/assets ./assets`.",
    );
  }
  return { path, bytes: readFileSync(path) };
}

/**
 * pdfkit keeps the fontkit instance of the current font at `doc._font.font`.
 * That is private API, so it is reached through a structural type and a runtime
 * guard; `tests/pdf-fonts.test.ts` pins it, so a pdfkit upgrade that moves it
 * fails CI rather than an export.
 */
const isObject = (value: unknown): value is object =>
  typeof value === "object" && value !== null;

function glyphTest(doc: PDFKit.PDFDocument): (codePoint: number) => boolean {
  const current: unknown = "_font" in doc ? doc._font : undefined;
  const font: unknown = isObject(current) && "font" in current ? current.font : undefined;
  if (!isObject(font) || !("hasGlyphForCodePoint" in font)) {
    throw new Error("pdfkit internals changed: cannot read glyph coverage");
  }
  const fn: unknown = font.hasGlyphForCodePoint;
  if (typeof fn !== "function") {
    throw new Error("pdfkit internals changed: cannot read glyph coverage");
  }
  return (codePoint: number): boolean => Boolean(fn.call(font, codePoint));
}

function buildHasGlyph(paths: PdfFonts["paths"]): (codePoint: number) => boolean {
  // A throwaway document: nothing is drawn and it is never ended, so it only
  // serves as the way to reach pdfkit's own font parser without adding fontkit
  // as a direct dependency.
  const doc = new PDFDocument({ autoFirstPage: false, font: paths.regular });
  const regular = glyphTest(doc);
  doc.font(paths.bold);
  const bold = glyphTest(doc);

  const memo = new Map<number, boolean>();
  return (codePoint: number): boolean => {
    const known = memo.get(codePoint);
    if (known !== undefined) return known;
    const result = regular(codePoint) && bold(codePoint);
    memo.set(codePoint, result);
    return result;
  };
}

let cached: PdfFonts | null = null;

/** Reads both TTFs once per process. Throws with the resolved path when a file is missing. */
export function loadPdfFonts(): PdfFonts {
  if (cached !== null) return cached;
  const regular = readFont(PDF_FONT_FILES.regular);
  const bold = readFont(PDF_FONT_FILES.bold);
  const paths = { regular: regular.path, bold: bold.path };
  cached = {
    paths,
    regular: regular.bytes,
    bold: bold.bytes,
    hasGlyph: buildHasGlyph(paths),
  };
  return cached;
}
