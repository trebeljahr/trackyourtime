import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import PDFDocument from "pdfkit";
import { loadPdfFonts, pdfFontsDirectory, PDF_FONT_FILES } from "../services/pdf-fonts.js";

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** The `| File | SHA-256 |` table of assets/fonts/README.md, so the README and the files cannot drift. */
const readmeHashes = (): Map<string, string> => {
  const readme = readFileSync(join(pdfFontsDirectory(), "README.md"), "utf8");
  const hashes = new Map<string, string>();
  for (const match of readme.matchAll(/^\| ([\w.-]+) \| `([0-9a-f]{64})` \|$/gm)) {
    if (match[1] !== undefined && match[2] !== undefined) hashes.set(match[1], match[2]);
  }
  return hashes;
};

describe("vendored PDF fonts", () => {
  it("loads both faces", () => {
    const fonts = loadPdfFonts();
    assert.ok(fonts.regular.byteLength > 100_000);
    assert.ok(fonts.bold.byteLength > 100_000);
    assert.notDeepEqual(sha256(fonts.regular), sha256(fonts.bold));
  });

  it("matches the SHA-256 recorded in the README, for every file including the licence", () => {
    const hashes = readmeHashes();
    const files = [PDF_FONT_FILES.regular, PDF_FONT_FILES.bold, "OFL.txt"];
    for (const file of files) {
      const expected = hashes.get(file);
      assert.ok(expected, `README.md records no hash for ${file}`);
      assert.equal(sha256(readFileSync(join(pdfFontsDirectory(), file))), expected, file);
    }
  });

  it("ships the OFL licence text", () => {
    const licence = readFileSync(join(pdfFontsDirectory(), "OFL.txt"), "utf8");
    assert.match(licence, /SIL OPEN FONT LICENSE Version 1\.1/i);
  });

  it("covers German letters and typographic punctuation", () => {
    const { hasGlyph } = loadPdfFonts();
    for (const char of "ÄÖÜäöüß€§–„“·") {
      assert.equal(hasGlyph(char.codePointAt(0) ?? 0), true, `missing glyph for ${char}`);
    }
  });

  it("reports a code point neither face has", () => {
    assert.equal(loadPdfFonts().hasGlyph("😀".codePointAt(0) ?? 0), false);
  });

  it("pins pdfkit's private font handle that glyph coverage reads", () => {
    // If a pdfkit upgrade moves `_font.font.hasGlyphForCodePoint`, this fails in
    // CI rather than every e-invoice export failing in production.
    const doc = new PDFDocument({ autoFirstPage: false, font: loadPdfFonts().paths.regular });
    const current: unknown = "_font" in doc ? doc._font : undefined;
    assert.ok(typeof current === "object" && current !== null && "font" in current);
    const font: unknown = current.font;
    assert.ok(typeof font === "object" && font !== null && "hasGlyphForCodePoint" in font);
    assert.equal(typeof font.hasGlyphForCodePoint, "function");
  });
});
