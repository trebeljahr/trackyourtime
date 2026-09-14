import assert from "node:assert/strict";
import test from "node:test";
import { inflateSync } from "node:zlib";
import type {
  DetailedEntry,
  DetailedReportResult,
  SummaryReportResult,
  WeeklyReportResult,
} from "@starter/shared";
import {
  formatPdfAmount,
  renderDetailedPdf,
  renderSummaryPdf,
  renderWeeklyPdf,
  sanitizePdfText,
  type PdfReportMeta,
} from "../services/pdf.js";

const meta: PdfReportMeta = {
  title: "Summary report by project",
  from: "2026-08-01",
  to: "2026-08-31",
  timeZone: "Europe/Berlin",
  currency: "EUR",
  generatedAt: "2026-09-01T08:00:00.000Z",
};

/**
 * A PDF is a container format, so "did it render" is checked structurally: the
 * `%PDF-` header, the `%%EOF` trailer and a byte count that could not be
 * produced by an empty page. Pixel-level assertions would pin the layout, not
 * the contract.
 */
const assertPdf = (bytes: Buffer, minimumBytes: number): void => {
  assert.ok(Buffer.isBuffer(bytes), "renderer must resolve a Buffer");
  assert.equal(
    bytes.subarray(0, 5).toString("latin1"),
    "%PDF-",
    "must start with the PDF magic bytes",
  );
  assert.ok(
    bytes.subarray(-1024).toString("latin1").includes("%%EOF"),
    "must be terminated with %%EOF",
  );
  assert.ok(
    bytes.byteLength > minimumBytes,
    `expected more than ${minimumBytes} bytes, got ${bytes.byteLength}`,
  );
};

/**
 * Reconstruct the visible text of each page, in page order.
 *
 * pdfkit deflates every page's content stream and writes the drawn text as
 * hex-encoded runs inside `TJ` arrays, split wherever the font's kerning table
 * fires. Concatenating every `<hex>` run in one stream therefore reassembles
 * exactly the characters that page draws — which is what lets these tests
 * assert on content (a repeated header row, a truncated description) rather
 * than on byte counts.
 */
const pageTexts = (bytes: Buffer): string[] => {
  const pages: string[] = [];
  const open = Buffer.from("stream\n", "latin1");
  const close = Buffer.from("endstream", "latin1");

  // `endstream` ends in `stream`, so the scan cannot jump past a closing
  // keyword — it steps one match at a time and lets the inflate fail on the
  // false positives.
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
      pages.push(Buffer.from(hex, "hex").toString("latin1"));
      cursor = end + close.byteLength;
    } catch {
      // Not a deflated content stream (a false `stream` match, or metadata).
      cursor = start;
    }
  }

  return pages;
};

const pageCount = (bytes: Buffer): number => pageTexts(bytes).length;

const emptySummary: SummaryReportResult = {
  totalSec: 0,
  billableSec: 0,
  totalAmount: 0,
  currency: "EUR",
  groups: [],
  timeline: [],
  moneyVisible: true,
};

const entry = (overrides: Partial<DetailedEntry> = {}): DetailedEntry => ({
  id: "entry-1",
  workspaceId: "workspace-1",
  authorId: "user-1",
  description: "Wrote the exporter",
  projectId: "project-1",
  taskId: null,
  billable: true,
  start: "2026-08-03T07:00:00.000Z",
  end: "2026-08-03T09:30:00.000Z",
  durationSec: 9000,
  hourlyRate: 90,
  currency: "EUR",
  source: "web",
  timeZone: "Europe/Berlin",
  tagIds: [],
  invoiceId: null,
  importId: null,
  runaway: null,
  createdAt: "2026-08-03T09:30:00.000Z",
  updatedAt: "2026-08-03T09:30:00.000Z",
  projectName: "tracktime",
  projectColor: "#8b5cf6",
  clientName: "Internal",
  taskName: "Exports",
  amount: 225,
  ...overrides,
});

const detailed = (entries: DetailedEntry[]): DetailedReportResult => ({
  entries,
  // The export path concatenates paginated pages and leaves both totals at 0 —
  // the renderer has to sum the rows it is given rather than trust these.
  totalSec: 0,
  totalAmount: 0,
  currency: "EUR",
  moneyVisible: true,
});

const weekly = (rows: WeeklyReportResult["rows"]): WeeklyReportResult => {
  const days = [
    "2026-08-03",
    "2026-08-04",
    "2026-08-05",
    "2026-08-06",
    "2026-08-07",
    "2026-08-08",
    "2026-08-09",
  ];
  const dayTotals = days.map((_day, index) =>
    rows.reduce((total, row) => total + (row.daySeconds[index] ?? 0), 0),
  );
  return {
    days,
    rows,
    dayTotals,
    totalSec: dayTotals.reduce((total, value) => total + value, 0),
    moneyVisible: true,
  };
};

// ── text hygiene ─────────────────────────────────────────────────────

test("sanitizePdfText collapses whitespace and drops control characters", () => {
  assert.equal(
    sanitizePdfText("  line one\nline\ttwo\u0000\u001b  "),
    "line one line two",
  );
});

test("sanitizePdfText leaves formula-looking text alone", () => {
  // The CSV exporter prefixes an apostrophe here. A PDF evaluates nothing, so
  // doing the same would corrupt every description starting with a dash.
  assert.equal(sanitizePdfText("=SUM(A1:A9)"), "=SUM(A1:A9)");
  assert.equal(sanitizePdfText("- refactored the router"), "- refactored the router");
});

test("formatPdfAmount groups thousands and keeps two decimals", () => {
  assert.equal(formatPdfAmount(0), "0.00");
  assert.equal(formatPdfAmount(1234.5), "1,234.50");
  assert.equal(formatPdfAmount(-1234567.891), "-1,234,567.89");
  assert.equal(formatPdfAmount(Number.NaN), "0.00");
});

// ── summary ──────────────────────────────────────────────────────────

test("renderSummaryPdf produces a real PDF", async () => {
  const bytes = await renderSummaryPdf(
    {
      totalSec: 12_600,
      billableSec: 9000,
      totalAmount: 225,
      currency: "EUR",
      moneyVisible: true,
      groups: [
        {
          key: "project-1",
          label: "tracktime",
          color: "#8b5cf6",
          seconds: 9000,
          billableSec: 9000,
          amount: 225,
        },
        {
          key: "none",
          label: "No project",
          color: null,
          seconds: 3600,
          billableSec: 0,
          amount: 0,
        },
      ],
      timeline: [],
    },
    meta,
  );

  assertPdf(bytes, 1200);
  const [page] = pageTexts(bytes);
  assert.ok(page !== undefined);
  // The range is meaningless without the zone its days were bucketed in.
  assert.ok(page.includes("2026-08-01 to 2026-08-31"));
  assert.ok(page.includes("Europe/Berlin"));
  assert.ok(page.includes("generated 2026-09-01T08:00:00.000Z"));
  assert.ok(page.includes("Amount (EUR)"));
  assert.ok(page.includes("tracktime"));
  assert.ok(page.includes("No project"));
  // Group durations and the totals row, both via formatDuration.
  assert.ok(page.includes("2:30:00"));
  assert.ok(page.includes("3:30:00"));
  assert.equal(pageCount(bytes), 1);
});

test("renderSummaryPdf renders a TAG-grouped summary, over-adding groups and all", async () => {
  // The seam this pins: a tag-grouped report is the one grouping whose rows
  // deliberately sum to MORE than the total, because an entry with two tags
  // contributes its full duration to both groups. `tagGroupIdentities` in
  // routers/reports.ts is what produces that, and the PDF must render it
  // faithfully rather than "correcting" it into a total that matches — the
  // screen already carries the caveat, and a PDF that disagreed with the
  // screen would be the worse of the two documents.
  //
  // 3:30:00 of real time, reported as 2:30:00 + 2:00:00 + 1:00:00 = 5:30:00
  // across the tag rows.
  const bytes = await renderSummaryPdf(
    {
      totalSec: 12_600,
      billableSec: 9000,
      totalAmount: 225,
      currency: "EUR",
      moneyVisible: true,
      groups: [
        {
          key: "tag-1",
          label: "deep work",
          color: "#0ea5e9",
          seconds: 9000,
          billableSec: 9000,
          amount: 225,
        },
        {
          key: "tag-2",
          label: "billable-review",
          color: "#f59e0b",
          seconds: 7200,
          billableSec: 7200,
          amount: 180,
        },
        {
          key: "none",
          label: "No tag",
          color: null,
          seconds: 3600,
          billableSec: 0,
          amount: 0,
        },
      ],
      timeline: [],
    },
    { ...meta, title: "Summary report by tag" },
  );

  assertPdf(bytes, 1200);
  const [page] = pageTexts(bytes);
  assert.ok(page !== undefined);
  assert.ok(page.includes("Summary report by tag"));
  // Every tag row survives, including the untagged bucket.
  assert.ok(page.includes("deep work"));
  assert.ok(page.includes("billable-review"));
  assert.ok(page.includes("No tag"));
  // The group durations are printed as given...
  assert.ok(page.includes("2:30:00"));
  assert.ok(page.includes("2:00:00"));
  assert.ok(page.includes("1:00:00"));
  // ...and the TOTAL stays the true un-double-counted elapsed time, NOT the
  // 5:30:00 the rows add up to.
  assert.ok(page.includes("3:30:00"));
  assert.ok(!page.includes("5:30:00"));
  assert.equal(pageCount(bytes), 1);
});

test("renderSummaryPdf still produces a valid document for an empty report", async () => {
  const bytes = await renderSummaryPdf(emptySummary, meta);
  assertPdf(bytes, 1000);
  assert.equal(pageCount(bytes), 1);
});

// ── detailed ─────────────────────────────────────────────────────────

test("renderDetailedPdf produces a real PDF", async () => {
  const bytes = await renderDetailedPdf(
    detailed([entry(), entry({ id: "entry-2", end: null, amount: 0 })]),
    { ...meta, title: "Detailed report" },
  );

  assertPdf(bytes, 1200);
  const [page] = pageTexts(bytes);
  assert.ok(page !== undefined);
  assert.ok(page.includes("Wrote the exporter"));
  assert.ok(page.includes("tracktime / Exports"));
  // 07:00Z is 09:00 in Europe/Berlin — the report's zone, not the server's.
  assert.ok(page.includes("09:00 - 11:30"));
  // A still-running entry has no end time to print.
  assert.ok(page.includes("09:00 - running"));
  assert.ok(page.includes("Total"));
});

test("renderDetailedPdf survives an absurdly long description", async () => {
  const bytes = await renderDetailedPdf(
    detailed([
      entry({
        description: "supercalifragilistic ".repeat(400),
        projectName: "A project name nobody should ever have typed ".repeat(20),
      }),
    ]),
    { ...meta, title: "Detailed report" },
  );

  assertPdf(bytes, 1200);
  // Truncated to one line, so the whole thing still fits on a single page.
  assert.equal(pageCount(bytes), 1);
  const [page] = pageTexts(bytes);
  assert.ok(page !== undefined);
  assert.ok(page.includes("..."), "a truncated cell must say so");
  assert.ok(
    !page.includes(
      "supercalifragilistic supercalifragilistic supercalifragilistic",
    ),
    "a long description must be truncated, not wrapped across the row",
  );
});

test("renderDetailedPdf paginates a long report and stays bounded", async () => {
  const entries = Array.from({ length: 400 }, (_value, index) =>
    entry({ id: `entry-${index}`, description: `Entry number ${index}` }),
  );

  const bytes = await renderDetailedPdf(detailed(entries), {
    ...meta,
    title: "Detailed report",
  });

  assertPdf(bytes, 5000);
  const pages = pageTexts(bytes);
  assert.ok(pages.length > 5, `400 rows must span several pages, got ${pages.length}`);

  // Every page is numbered, carries the report identity, and repeats the
  // column header row — otherwise page 7 of a print-out is unreadable.
  pages.forEach((page, index) => {
    assert.ok(page.includes(`Page ${index + 1}`), `page ${index + 1} is unnumbered`);
    assert.ok(page.includes("Detailed report"), `page ${index + 1} lost its title`);
    assert.ok(
      page.includes("DateTimeDurationDescription"),
      `page ${index + 1} lost its column header row`,
    );
  });
  pages.slice(1).forEach((page, index) => {
    assert.ok(
      page.includes("continued"),
      `page ${index + 2} is not marked as a continuation`,
    );
  });
});

test("renderDetailedPdf still produces a valid document for an empty report", async () => {
  const bytes = await renderDetailedPdf(detailed([]), {
    ...meta,
    title: "Detailed report",
  });
  assertPdf(bytes, 1000);
  assert.equal(pageCount(bytes), 1);
});

// ── weekly ───────────────────────────────────────────────────────────

test("renderWeeklyPdf produces a landscape PDF", async () => {
  const bytes = await renderWeeklyPdf(
    weekly([
      {
        projectId: "project-1",
        taskId: null,
        label: "tracktime",
        color: "#8b5cf6",
        daySeconds: [3600, 0, 7200, 0, 1800, 0, 0],
        totalSec: 12_600,
      },
    ]),
    { ...meta, title: "Weekly timesheet" },
  );

  assertPdf(bytes, 1200);
  // A4 landscape is 842 x 595 points; the MediaBox proves the orientation.
  assert.ok(
    bytes.toString("latin1").includes("/MediaBox [0 0 841.89 595.28]"),
    "weekly report must be rendered landscape",
  );

  const [page] = pageTexts(bytes);
  assert.ok(page !== undefined);
  // Seven day columns, weekday-labelled, plus the row and column totals.
  assert.ok(page.includes("Mon 08-03"));
  assert.ok(page.includes("Sun 08-09"));
  assert.ok(page.includes("Total"));
  assert.ok(page.includes("3:30:00"));
});

test("renderWeeklyPdf still produces a valid document for an empty week", async () => {
  const bytes = await renderWeeklyPdf(weekly([]), {
    ...meta,
    title: "Weekly timesheet",
  });
  assertPdf(bytes, 1000);
  assert.equal(pageCount(bytes), 1);
});
