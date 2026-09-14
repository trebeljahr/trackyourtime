import assert from "node:assert/strict";
import test from "node:test";
import { csvFilename, toCsv, type CsvColumn, type CsvRow } from "../services/csv.js";

const BOM = "﻿";
const CRLF = "\r\n";

const columns: CsvColumn[] = [
  { key: "description", header: "Description" },
  { key: "project", header: "Project" },
  { key: "seconds", header: "Seconds" },
];

/** The CSV body with the BOM stripped, split into physical lines. */
const lines = (csv: string): string[] => {
  assert.ok(csv.startsWith(BOM), "export must start with a UTF-8 BOM");
  const body = csv.slice(BOM.length);
  assert.ok(body.endsWith(CRLF), "export must end with a final CRLF");
  return body.slice(0, -CRLF.length).split(CRLF);
};

// ── shape ────────────────────────────────────────────────────────────

test("toCsv writes a BOM, a header row and CRLF line endings", () => {
  const csv = toCsv(
    [{ description: "Wrote tests", project: "trackyourtime", seconds: 3600 }],
    columns
  );

  assert.equal(
    csv,
    `${BOM}Description,Project,Seconds${CRLF}Wrote tests,trackyourtime,3600${CRLF}`
  );
  assert.ok(!csv.includes("\n\n"));
});

test("toCsv writes just a header row for an empty report", () => {
  assert.equal(toCsv([], columns), `${BOM}Description,Project,Seconds${CRLF}`);
});

test("toCsv renders missing and null cells as empty fields", () => {
  const rows: CsvRow[] = [{ description: null, seconds: 0 }];
  assert.deepEqual(lines(toCsv(rows, columns)), [
    "Description,Project,Seconds",
    ",,0",
  ]);
});

// ── quoting ──────────────────────────────────────────────────────────

test("toCsv quotes fields containing the delimiter", () => {
  const csv = toCsv([{ description: "Design, build, ship" }], [columns[0]]);
  assert.deepEqual(lines(csv), ["Description", '"Design, build, ship"']);
});

test("toCsv quotes fields containing quotes and doubles the inner quotes", () => {
  const csv = toCsv([{ description: 'Called it "done"' }], [columns[0]]);
  assert.deepEqual(lines(csv), ["Description", '"Called it ""done"""']);
});

test("toCsv quotes fields containing line breaks", () => {
  const csv = toCsv([{ description: "line one\nline two" }], [columns[0]]);
  const body = csv.slice(BOM.length);
  assert.equal(body, `Description${CRLF}"line one\nline two"${CRLF}`);
});

test("toCsv quotes a header that needs it", () => {
  const csv = toCsv([], [{ key: "a", header: 'Rate, "hourly"' }]);
  assert.equal(csv, `${BOM}"Rate, ""hourly"""${CRLF}`);
});

test("toCsv leaves ordinary text unquoted", () => {
  const csv = toCsv([{ description: "plain text 42" }], [columns[0]]);
  assert.deepEqual(lines(csv), ["Description", "plain text 42"]);
});

// ── numbers ──────────────────────────────────────────────────────────

test("toCsv emits numbers verbatim so SUM() keeps working", () => {
  const csv = toCsv([{ seconds: -1800 }, { seconds: 12.5 }], [columns[2]]);
  assert.deepEqual(lines(csv), ["Seconds", "-1800", "12.5"]);
});

test("toCsv renders non-finite numbers as empty fields", () => {
  const csv = toCsv(
    [{ seconds: Number.NaN }, { seconds: Number.POSITIVE_INFINITY }],
    [columns[2]]
  );
  assert.deepEqual(lines(csv), ["Seconds", "", ""]);
});

// ── formula injection ────────────────────────────────────────────────

test("toCsv defuses formulas in text fields", () => {
  const csv = toCsv(
    [
      { description: "=SUM(A1:A9)" },
      { description: "+1234" },
      { description: "-1234" },
      { description: "@import" },
    ],
    [columns[0]]
  );

  assert.deepEqual(lines(csv), [
    "Description",
    "'=SUM(A1:A9)",
    "'+1234",
    "'-1234",
    "'@import",
  ]);
});

test("toCsv defuses a formula and still quotes it when needed", () => {
  const csv = toCsv([{ description: '=HYPERLINK("http://x","a,b")' }], [columns[0]]);
  assert.deepEqual(lines(csv), [
    "Description",
    `"'=HYPERLINK(""http://x"",""a,b"")"`,
  ]);
});

test("toCsv guards leading tab and carriage return, which also trigger formulas", () => {
  // A tab needs the guard but not quotes; a CR needs both.
  assert.deepEqual(lines(toCsv([{ description: "\t=1+1" }], [columns[0]])), [
    "Description",
    "'\t=1+1",
  ]);

  const withCr = toCsv([{ description: "\r=1+1" }], [columns[0]]);
  assert.equal(withCr.slice(BOM.length), `Description${CRLF}"'\r=1+1"${CRLF}`);
});

test("toCsv does not guard a negative number written as a number", () => {
  // Only text is escaped — a numeric -5 must stay summable.
  assert.deepEqual(lines(toCsv([{ seconds: -5 }], [columns[2]])), [
    "Seconds",
    "-5",
  ]);
});

// ── filenames ────────────────────────────────────────────────────────

test("csvFilename builds a report filename from the range", () => {
  assert.equal(
    csvFilename("detailed", "2026-08-01", "2026-08-31"),
    "trackyourtime-detailed-2026-08-01_2026-08-31.csv"
  );
});

test("csvFilename strips characters a filesystem or header would choke on", () => {
  assert.equal(
    csvFilename("summary by project", "2026/08/01", "2026 08 31"),
    "trackyourtime-summary-by-project-2026-08-01_2026-08-31.csv"
  );
  assert.ok(!csvFilename("../../etc/passwd", "a", "b").includes("/"));
  assert.ok(!csvFilename('weekly"', "a", "b").includes('"'));
});
