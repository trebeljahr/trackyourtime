/**
 * Reading a delimited text file into rows of raw strings.
 *
 * A separate implementation from `services/csv.ts` on purpose: that one only
 * ever writes files we generated, so it can assume commas, CRLF and no
 * surprises. This one reads files written by somebody else's exporter, which
 * means semicolons in half of Europe, tabs from spreadsheet copy-paste, quoted
 * fields containing the delimiter, doubled quotes inside them, and a BOM the
 * first header would otherwise carry into its own name.
 */
import {
  ImportFileError,
  MAX_IMPORT_CELL_CHARS,
  MAX_IMPORT_COLUMNS,
  MAX_IMPORT_ROWS,
  assertImportTextWithinLimit,
} from "@starter/shared";

/** Delimiters worth guessing between, in the order ties are broken. */
const CANDIDATES = [",", ";", "\t", "|"] as const;

export type DelimitedFile = {
  delimiter: string;
  /** The first row, already de-BOM'd and trimmed of surrounding quotes. */
  header: string[];
  /** Every row after the header. Short rows are NOT padded — see `cell`. */
  rows: string[][];
};

/**
 * Split one delimited document into rows.
 *
 * Written as a character scanner rather than `split` because a quoted field may
 * contain the delimiter, a newline, or an escaped quote, and every one of those
 * turns a split-based parser into silent data corruption rather than an error.
 */
export function parseDelimited(text: string, delimiter: string): string[][] {
  assertImportTextWithinLimit(text);
  return scanDelimited(text, delimiter);
}

function scanDelimited(text: string, delimiter: string, sampleRows?: number): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let index = 0;
  // A trailing newline must not produce a final empty row, so rows are only
  // pushed when they hold something.
  const endField = (): void => {
    if (field.length > MAX_IMPORT_CELL_CHARS) {
      throw new ImportFileError(`An import cell can have at most ${MAX_IMPORT_CELL_CHARS.toLocaleString("en-US")} characters.`);
    }
    if (row.length >= MAX_IMPORT_COLUMNS) {
      throw new ImportFileError(`An import row can have at most ${MAX_IMPORT_COLUMNS} columns.`);
    }
    row.push(field);
    field = "";
  };
  const endRow = (): void => {
    endField();
    if (row.length > 1 || (row[0] ?? "").length > 0) {
      // One header plus the bounded number of data rows. Refuse while scanning,
      // before building or detecting the columns of an oversized document.
      if (rows.length >= MAX_IMPORT_ROWS + 1) {
        throw new ImportFileError(`An import can have at most ${MAX_IMPORT_ROWS.toLocaleString("en-US")} rows. Split the file by date range.`);
      }
      rows.push(row);
    }
    row = [];
  };

  while (index < text.length) {
    if (sampleRows !== undefined && rows.length >= sampleRows) break;
    if (field.length > MAX_IMPORT_CELL_CHARS) {
      throw new ImportFileError(`An import cell can have at most ${MAX_IMPORT_CELL_CHARS.toLocaleString("en-US")} characters.`);
    }
    const char = text[index] as string;

    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }

    if (char === '"' && field.length === 0) {
      quoted = true;
      index += 1;
      continue;
    }
    if (char === delimiter) {
      endField();
      index += 1;
      continue;
    }
    if (char === "\r") {
      // CRLF and a lone CR both end the row.
      if (text[index + 1] === "\n") index += 1;
      endRow();
      index += 1;
      continue;
    }
    if (char === "\n") {
      endRow();
      index += 1;
      continue;
    }
    field += char;
    index += 1;
  }

  if (quoted) {
    // Delimiter detection deliberately sees only a prefix, which can end
    // inside a quoted cell. The full read must not silently accept that.
    if (sampleRows !== undefined) return rows;
    throw new ImportFileError("The file ends inside a quoted cell. Close the quote and try again.");
  }
  if (field.length > 0 || row.length > 0) endRow();
  return rows;
}

/**
 * Guess the delimiter by parsing the head of the file with each candidate and
 * keeping the one that yields the most columns CONSISTENTLY.
 *
 * Consistency is what makes this reliable: a semicolon-separated file parsed
 * with commas usually yields one wide column or wildly varying widths, and a
 * description containing a comma would otherwise outvote the real delimiter.
 */
export function sniffDelimiter(text: string): string {
  const head = text.slice(0, 64_000);
  let best = ",";
  let bestScore = -1;

  for (const candidate of CANDIDATES) {
    let rows: string[][];
    try {
      rows = scanDelimited(head, candidate, 20);
    } catch (error) {
      // A wrong delimiter can turn a whole row into one overlong cell. Only
      // the selected delimiter's limits decide whether the file is accepted.
      if (error instanceof ImportFileError) continue;
      throw error;
    }
    if (rows.length === 0) continue;
    const width = rows[0]?.length ?? 0;
    if (width < 2) continue;
    const consistent = rows.filter((row) => row.length === width).length;
    // Width breaks ties towards the delimiter that actually structures the
    // file; the consistency ratio keeps a stray delimiter from winning on width.
    const score = (consistent / rows.length) * 100 + width;
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return best;
}

/** Strip a UTF-8 BOM and the zero-width space some exporters emit with it. */
export const stripBom = (text: string): string =>
  text.replace(/^[﻿​]+/, "");

/**
 * Read a whole document: sniff, parse, and split the header off.
 *
 * Rows shorter than the header are kept as-is rather than padded, because
 * "this row has no end time" and "this row's end time is empty" are the same
 * answer and both are handled by {@link cell}.
 */
export function readDelimitedFile(text: string): DelimitedFile {
  assertImportTextWithinLimit(text);
  const clean = stripBom(text);
  const delimiter = sniffDelimiter(clean);
  const all = parseDelimited(clean, delimiter);
  const [header = [], ...rows] = all;
  return {
    delimiter,
    header: header.map((value) => value.trim()),
    rows,
  };
}

/** A cell that may not exist, trimmed. Missing and empty read alike. */
export const cell = (row: string[], index: number | undefined): string =>
  index === undefined ? "" : (row[index] ?? "").trim();
