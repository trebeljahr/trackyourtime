import { inflateSync } from "node:zlib";

/**
 * The text each page of a pdfkit document draws, one string per page.
 *
 * pdfkit writes every run of text as hex inside `TJ` arrays in a deflated
 * content stream, split wherever kerning fires; concatenating every `<hex>`
 * run in one stream reassembles exactly the characters that page draws. The
 * standard-14 fonts encode WinAnsi, which agrees with latin1 for every letter
 * the catalogs use (ä, ö, ü, ß) and differs only in 0x80–0x9F, where WinAnsi
 * keeps the typographic marks German text uses — mapped back below so a test
 * can assert on „…“ and – as written. Same reader as `pdf.test.ts`.
 */
const WIN_ANSI_HIGH: Record<number, string> = {
  0x80: "\u20ac",
  0x84: "\u201e",
  0x85: "\u2026",
  0x91: "\u2018",
  0x92: "\u2019",
  0x93: "\u201c",
  0x94: "\u201d",
  0x96: "\u2013",
  0x97: "\u2014",
};

const decodeWinAnsi = (bytes: Buffer): string =>
  Array.from(bytes, (byte) => WIN_ANSI_HIGH[byte] ?? String.fromCharCode(byte)).join("");

export const pageTexts = (bytes: Buffer): string[] => {
  const pages: string[] = [];
  const open = Buffer.from("stream\n", "latin1");
  const close = Buffer.from("endstream", "latin1");

  let cursor = 0;
  for (;;) {
    const at = bytes.indexOf(open, cursor);
    if (at === -1) break;
    const start = at + open.byteLength;
    const end = bytes.indexOf(close, start);
    if (end === -1) break;

    try {
      const inflated = inflateSync(bytes.subarray(start, end)).toString("latin1");
      const runs = inflated.match(/<([0-9a-fA-F]+)>/g) ?? [];
      const hex = runs.map((run) => run.slice(1, -1)).join("");
      pages.push(decodeWinAnsi(Buffer.from(hex, "hex")));
      cursor = end + close.byteLength;
    } catch {
      cursor = start;
    }
  }

  return pages;
};
