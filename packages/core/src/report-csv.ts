/**
 * RFC 4180 CSV serialization for report exports.
 *
 * Three things spreadsheets care about that a naive `join(",")` gets wrong:
 *  - quoting (a field containing `,` `"` CR or LF must be quoted, inner
 *    quotes doubled),
 *  - CRLF line endings,
 *  - a leading UTF-8 BOM, without which Excel decodes the file as the
 *    system codepage and mangles every non-ASCII project name.
 *
 * It also defuses CSV injection: a text field starting with `=`, `+`, `-`
 * or `@` is read as a formula by Excel/Sheets, so those get a leading
 * apostrophe. Numbers are emitted verbatim — they are produced by us, never
 * by user input, and quoting a negative number would break `SUM()`.
 */

/** A single CSV cell. `null` renders as an empty field. */
export type CsvValue = string | number | null;

/** Column definition — `key` indexes the row object, `header` is the label. */
export type CsvColumn = {
  key: string;
  header: string;
};

export type CsvRow = Record<string, CsvValue | undefined>;

const UTF8_BOM = "\ufeff";
const LINE_END = "\r\n";

/** Fields containing a delimiter, a quote or a line break must be quoted. */
const NEEDS_QUOTES = /[",\r\n]/;

/** Leading characters a spreadsheet would interpret as a formula. */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

const escapeField = (value: CsvValue | undefined): string => {
  if (value === null || value === undefined) return "";

  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "";
  }

  const guarded = FORMULA_LEAD.test(value) ? `'${value}` : value;
  return NEEDS_QUOTES.test(guarded)
    ? `"${guarded.replace(/"/g, '""')}"`
    : guarded;
};

/**
 * The start of a file: the BOM and the header line, CRLF-terminated. With
 * {@link csvLine} per row this writes exactly what {@link toCsv} returns, one
 * line at a time — the streamed export is built from these two.
 */
export function csvHead(columns: CsvColumn[]): string {
  return `${UTF8_BOM}${columns.map((column) => escapeField(column.header)).join(",")}${LINE_END}`;
}

/** One row, CRLF-terminated. Keys missing from the row render as empty fields. */
export function csvLine(row: CsvRow, columns: CsvColumn[]): string {
  return `${columns.map((column) => escapeField(row[column.key])).join(",")}${LINE_END}`;
}

/**
 * Serialize `rows` as RFC 4180 CSV using `columns` for order and headers.
 * Keys missing from a row render as empty fields.
 */
export function toCsv(rows: CsvRow[], columns: CsvColumn[]): string {
  let csv = csvHead(columns);
  for (const row of rows) csv += csvLine(row, columns);
  return csv;
}

/**
 * Build a download filename like
 * `trackyourtime-detailed-2026-08-01_2026-08-31.csv`. `from`/`to` are local
 * "YYYY-MM-DD" day keys.
 */
export function csvFilename(
  report: string,
  from: string,
  to: string,
): string {
  const safe = (value: string): string =>
    value.replace(/[^0-9A-Za-z-]/g, "-");
  return `trackyourtime-${safe(report)}-${safe(from)}_${safe(to)}.csv`;
}
