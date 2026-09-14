/**
 * Server-rendered PDF export.
 *
 * Why pdfkit:
 *  - It is CommonJS, but it has a SINGLE default export, so
 *    `import PDFDocument from "pdfkit";` works unchanged under this package's
 *    Node ESM setup. (The failure mode this avoids is the one `@starter/shared`
 *    already hit: Node's static cjs-module-lexer cannot see NAMED exports
 *    through `__exportStar(require())`, so a CJS package with named exports
 *    breaks at link time. A default-only export has no such problem.)
 *  - It bundles the standard-14 AFM font metrics, so Helvetica/Times/Courier
 *    render with correct widths without shipping any font files — nothing to
 *    bundle into the Docker image, nothing to path-resolve at runtime.
 *  - It streams. A document is written page by page into a sink, so a large
 *    detailed report never materializes twice in memory the way a
 *    build-a-giant-string-then-encode approach would.
 *
 * Defensive habits carried over from `services/csv.ts` — and the one that is
 * deliberately NOT carried over:
 *  - NOT carried over: the spreadsheet formula-injection guard. A leading `=`,
 *    `+`, `-` or `@` is dangerous in CSV only because Excel and Sheets EVALUATE
 *    cell text. A PDF has no formula engine: text drawn into a content stream
 *    is glyphs and nothing else, and pdfkit escapes the string when it writes
 *    it, so `=cmd|'/c calc'!A1` renders as those literal characters. Prefixing
 *    an apostrophe here would corrupt every description that legitimately
 *    starts with a dash.
 *  - Carried over and still needed: control characters are stripped (they
 *    cannot be drawn and only serve to confuse), whitespace is collapsed so a
 *    pasted multi-line description cannot blow a single-line row open, and
 *    every cell is measured against its column and truncated with an ellipsis
 *    so no value can overflow into its neighbour or off the page.
 *
 * Memory: `bufferPages` is deliberately left OFF. Pages are flushed into the
 * output stream as soon as they are finished, so a 100k-entry detailed export
 * holds one page of content at a time rather than the whole document. The
 * price is that a page cannot be revisited after it is written, which is why
 * the footer says "Page 7" and not "Page 7 of 213" — the total is not knowable
 * without buffering every page first.
 */
import PDFDocument from "pdfkit";
import {
  dayKeyInZone,
  entryDurationSec,
  formatClockInZone,
  formatDuration,
  resolveTimeZone,
  sumAmounts,
  type DetailedEntry,
  type DetailedReportResult,
  type SummaryReportResult,
  type WeeklyReportResult,
} from "@starter/shared";

/** Page furniture shared by every report PDF. */
export type PdfReportMeta = {
  /** Headline, e.g. "Summary report by project". */
  title: string;
  /** ISO date or datetime — start of the reported range. */
  from: string;
  /** ISO date or datetime — end of the reported range. */
  to: string;
  /** IANA zone the days were bucketed in. */
  timeZone: string;
  /** ISO 4217 code the amounts are in. */
  currency: string;
  /** ISO datetime the document was rendered at. */
  generatedAt: string;
  /**
   * False when the report's money is withheld from the caller. Absent means
   * visible, so a caller that predates the flag renders what it always did.
   * The masthead then drops its "Amounts in" line: a document with no amounts
   * naming a currency reads as one whose amounts went missing.
   */
  moneyVisible?: boolean;
};

// ── page geometry ────────────────────────────────────────────────────

const MARGINS = { top: 48, bottom: 30, left: 48, right: 48 } as const;

/**
 * Vertical band between the last table row and the page's bottom margin, where
 * the footer lives.
 *
 * It has to be reserved by hand: pdfkit starts a fresh page the moment a text
 * run would cross `page.maxY()`, so drawing a footer "below the content" would
 * silently produce an extra blank page per page. Keeping the footer inside the
 * band and every row above it means the layout never triggers pdfkit's own
 * pagination — this module owns every page break.
 */
const FOOTER_BAND = 18;

const FONT = "Helvetica";
const FONT_BOLD = "Helvetica-Bold";

const TITLE_SIZE = 16;
const SUBTITLE_SIZE = 9.5;
const META_SIZE = 8;
const BODY_SIZE = 8.5;

const ROW_HEIGHT = 15;
const CELL_PADDING = 4;

const INK = "#111111";
const MUTED = "#666666";
const RULE = "#cccccc";
const RULE_STRONG = "#888888";

type PageLayout = "portrait" | "landscape";

const pageOptions = (layout: PageLayout): PDFKit.PDFDocumentOptions => ({
  size: "A4",
  layout,
  margins: { ...MARGINS },
});

// ── text hygiene ─────────────────────────────────────────────────────

/**
 * C0/C1 control characters plus the Unicode line/paragraph separators. None of
 * these have a glyph; they exist in exported text only by accident (a pasted
 * description, a stray NUL from an import) and would otherwise be handed to
 * the font's encoder as undefined code points.
 */
const CONTROL_CHARS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/g;

/** One cell is one line: control chars out, runs of whitespace collapsed. */
export function sanitizePdfText(value: string): string {
  return value.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
}

const ELLIPSIS = "...";

/**
 * Trim `text` until it fits `width` at the document's CURRENT font and size,
 * appending an ellipsis when anything was dropped.
 *
 * The first slice is a width-ratio estimate rather than a character-by-
 * character walk, so a 4000-character description costs a handful of
 * `widthOfString` calls instead of thousands — this runs once per cell and a
 * detailed export has up to 100k rows.
 */
function fitText(
  doc: PDFKit.PDFDocument,
  text: string,
  width: number,
): string {
  if (text === "" || width <= 0) return "";
  const full = doc.widthOfString(text);
  if (full <= width) return text;

  const estimate = Math.max(1, Math.floor(text.length * (width / full)));
  let length = Math.min(text.length, estimate);

  while (
    length > 1 &&
    doc.widthOfString(`${text.slice(0, length)}${ELLIPSIS}`) > width
  ) {
    length -= 1;
  }
  while (
    length < text.length &&
    doc.widthOfString(`${text.slice(0, length + 1)}${ELLIPSIS}`) <= width
  ) {
    length += 1;
  }

  return `${text.slice(0, length).trimEnd()}${ELLIPSIS}`;
}

/**
 * Amounts as grouped fixed-point, ASCII only — "1,234.50".
 *
 * Deliberately not `Intl.NumberFormat(..., { style: "currency" })`: that emits
 * locale punctuation such as U+202F NARROW NO-BREAK SPACE, which is outside the
 * WinAnsi encoding the standard-14 fonts use and would render as a blank box.
 * The currency code is stated once in the column header and again in the page
 * header instead, which is also less noisy than repeating it on every row.
 */
export function formatPdfAmount(amount: number): string {
  if (!Number.isFinite(amount)) return "0.00";
  const fixed = Math.abs(amount).toFixed(2);
  const dot = fixed.indexOf(".");
  const whole = fixed.slice(0, dot).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${amount < 0 ? "-" : ""}${whole}${fixed.slice(dot)}`;
}

// ── table primitives ─────────────────────────────────────────────────

type PdfAlign = "left" | "right";

type PdfColumn = {
  key: string;
  header: string;
  /** Fixed point width. `null` means "share whatever is left over". */
  width: number | null;
  align?: PdfAlign;
};

/** A resolved column: every width is a concrete number. */
type SizedColumn = PdfColumn & { width: number };

type PdfCells = Record<string, string>;

/** Give the flexible columns an equal share of the leftover width. */
function sizeColumns(columns: PdfColumn[], available: number): SizedColumn[] {
  const fixed = columns.reduce(
    (total, column) => total + (column.width ?? 0),
    0,
  );
  const flexCount = columns.filter((column) => column.width === null).length;
  const share = flexCount === 0 ? 0 : Math.max(40, (available - fixed) / flexCount);
  return columns.map((column) => ({ ...column, width: column.width ?? share }));
}

type Sheet = {
  doc: PDFKit.PDFDocument;
  meta: PdfReportMeta;
  layout: PageLayout;
  left: number;
  width: number;
  /** Y of the first row of content on a continuation page. */
  top: number;
  /** Y past which no row may start. */
  bottom: number;
  /** Write cursor. */
  y: number;
  page: number;
};

function createSheet(
  doc: PDFKit.PDFDocument,
  meta: PdfReportMeta,
  layout: PageLayout,
): Sheet {
  return {
    doc,
    meta,
    layout,
    left: MARGINS.left,
    width: doc.page.width - MARGINS.left - MARGINS.right,
    top: MARGINS.top,
    bottom: doc.page.height - MARGINS.bottom - FOOTER_BAND,
    y: MARGINS.top,
    page: 1,
  };
}

function drawFooter(sheet: Sheet): void {
  const { doc } = sheet;
  doc
    .font(FONT)
    .fontSize(META_SIZE)
    .fillColor(MUTED)
    .text(
      `Track Your Time · ${sheet.meta.timeZone}`,
      sheet.left,
      doc.page.height - MARGINS.bottom - 12,
      { width: sheet.width, align: "left", lineBreak: false },
    )
    .text(
      `Page ${sheet.page}`,
      sheet.left,
      doc.page.height - MARGINS.bottom - 12,
      { width: sheet.width, align: "right", lineBreak: false },
    );
  doc.fillColor(INK);
}

/** Full masthead — first page only. */
function drawTitleBlock(sheet: Sheet): void {
  const { doc, meta } = sheet;

  doc
    .font(FONT_BOLD)
    .fontSize(TITLE_SIZE)
    .fillColor(INK)
    .text(sanitizePdfText(meta.title), sheet.left, sheet.y, {
      width: sheet.width,
      lineBreak: false,
    });
  sheet.y += TITLE_SIZE + 6;

  // The zone is not decoration: the same entries bucket into different days in
  // different zones, so a range without its zone is not a reproducible claim.
  doc
    .font(FONT)
    .fontSize(SUBTITLE_SIZE)
    .fillColor(INK)
    .text(
      `${meta.from} to ${meta.to} · time zone ${meta.timeZone}`,
      sheet.left,
      sheet.y,
      { width: sheet.width, lineBreak: false },
    );
  sheet.y += SUBTITLE_SIZE + 4;

  doc
    .fontSize(META_SIZE)
    .fillColor(MUTED)
    .text(
      meta.moneyVisible === false
        ? `generated ${meta.generatedAt}`
        : `Amounts in ${sanitizePdfText(meta.currency)} · generated ${meta.generatedAt}`,
      sheet.left,
      sheet.y,
      { width: sheet.width, lineBreak: false },
    );
  sheet.y += META_SIZE + 12;
  doc.fillColor(INK);
}

/** One-line masthead — every page after the first. */
function drawContinuationHeader(sheet: Sheet): void {
  const { doc, meta } = sheet;
  doc
    .font(FONT_BOLD)
    .fontSize(SUBTITLE_SIZE)
    .fillColor(INK)
    .text(sanitizePdfText(meta.title), sheet.left, sheet.y, {
      width: sheet.width,
      lineBreak: false,
    });
  doc
    .font(FONT)
    .fontSize(META_SIZE)
    .fillColor(MUTED)
    .text(
      `${meta.from} to ${meta.to} · ${meta.timeZone} · continued`,
      sheet.left,
      sheet.y + 1,
      { width: sheet.width, align: "right", lineBreak: false },
    );
  sheet.y += SUBTITLE_SIZE + 10;
  doc.fillColor(INK);
}

/** Headline figures, rendered as a KPI strip under the masthead. */
function drawStats(
  sheet: Sheet,
  stats: { label: string; value: string }[],
): void {
  if (stats.length === 0) return;
  const { doc } = sheet;
  const columnWidth = sheet.width / stats.length;

  stats.forEach((stat, index) => {
    const x = sheet.left + columnWidth * index;
    doc
      .font(FONT)
      .fontSize(META_SIZE)
      .fillColor(MUTED)
      .text(stat.label.toUpperCase(), x, sheet.y, {
        width: columnWidth,
        lineBreak: false,
      });
    doc
      .font(FONT_BOLD)
      .fontSize(13)
      .fillColor(INK)
      .text(stat.value, x, sheet.y + META_SIZE + 3, {
        width: columnWidth,
        lineBreak: false,
      });
  });

  sheet.y += META_SIZE + 3 + 13 + 14;
  doc.fillColor(INK);
}

function drawRule(sheet: Sheet, strong: boolean): void {
  sheet.doc
    .lineWidth(strong ? 1 : 0.5)
    .strokeColor(strong ? RULE_STRONG : RULE)
    .moveTo(sheet.left, sheet.y)
    .lineTo(sheet.left + sheet.width, sheet.y)
    .stroke();
}

type RowStyle = "header" | "body" | "total";

function drawRow(
  sheet: Sheet,
  columns: SizedColumn[],
  cells: PdfCells,
  style: RowStyle,
): void {
  const { doc } = sheet;
  doc.font(style === "body" ? FONT : FONT_BOLD).fontSize(BODY_SIZE);
  doc.fillColor(style === "header" ? MUTED : INK);

  let x = sheet.left;
  for (const column of columns) {
    const inner = column.width - CELL_PADDING * 2;
    const raw = sanitizePdfText(cells[column.key] ?? "");
    const text = fitText(doc, raw, inner);
    if (text !== "") {
      doc.text(text, x + CELL_PADDING, sheet.y + 4, {
        width: inner,
        align: column.align ?? "left",
        lineBreak: false,
      });
    }
    x += column.width;
  }

  sheet.y += ROW_HEIGHT;
  drawRule(sheet, style !== "body");
  doc.fillColor(INK);
}

/**
 * A paginating table writer.
 *
 * Rows are written one at a time and the header row is redrawn after every
 * break, so a reader who lands on page 40 of a detailed export still knows
 * which column is which. Nothing about the table is retained between rows,
 * which is what keeps a 100k-row export flat in memory.
 */
type Table = {
  columns: SizedColumn[];
  row: (cells: PdfCells) => void;
  total: (cells: PdfCells) => void;
  empty: (message: string) => void;
};

function createTable(sheet: Sheet, definition: PdfColumn[]): Table {
  const columns = sizeColumns(definition, sheet.width);
  const headerCells: PdfCells = Object.fromEntries(
    columns.map((column) => [column.key, column.header]),
  );

  const writeHeader = (): void => {
    drawRow(sheet, columns, headerCells, "header");
  };

  const ensureSpace = (): void => {
    if (sheet.y + ROW_HEIGHT <= sheet.bottom) return;
    sheet.doc.addPage(pageOptions(sheet.layout));
    sheet.page += 1;
    sheet.y = sheet.top;
    drawContinuationHeader(sheet);
    drawFooter(sheet);
    writeHeader();
  };

  writeHeader();

  return {
    columns,
    row: (cells) => {
      ensureSpace();
      drawRow(sheet, columns, cells, "body");
    },
    total: (cells) => {
      ensureSpace();
      drawRow(sheet, columns, cells, "total");
    },
    empty: (message) => {
      ensureSpace();
      const first = columns[0];
      if (first === undefined) return;
      drawRow(sheet, columns, { [first.key]: message }, "body");
    },
  };
}

// ── document plumbing ────────────────────────────────────────────────

/**
 * Drain a PDFKit document into a single Buffer.
 *
 * pdfkit is a Node stream, so this is the one place that has to bridge
 * callback-land back into a promise. `doc.end()` must be called by the
 * builder BEFORE awaiting, otherwise the "end" event never fires and the
 * promise hangs forever — which is why `end()` lives here rather than in each
 * renderer.
 *
 * The "data" listener is attached before `build` runs so pages drain as they
 * are produced rather than piling up in the stream's internal buffer.
 */
async function bufferDocument(
  meta: PdfReportMeta,
  layout: PageLayout,
  build: (sheet: Sheet) => void,
): Promise<Buffer> {
  const doc = new PDFDocument(pageOptions(layout));
  doc.info.Title = sanitizePdfText(meta.title);
  doc.info.Creator = "Track Your Time";
  const chunks: Buffer[] = [];

  return new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", (error: Error) => reject(error));

    try {
      const sheet = createSheet(doc, meta, layout);
      drawFooter(sheet);
      drawTitleBlock(sheet);
      build(sheet);
      doc.end();
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

// ── renderers ────────────────────────────────────────────────────────

/** Render a grouped summary report. */
export async function renderSummaryPdf(
  result: SummaryReportResult,
  meta: PdfReportMeta,
): Promise<Buffer> {
  const currency = sanitizePdfText(result.currency || meta.currency);
  // Money is decided by the RESULT, which the report builder already
  // projected — the renderer never re-derives it from a visibility. With it
  // withheld the stat, the column and the total go entirely: a PDF has no
  // dash to explain, and an "Amount" column of blanks reads as zero.
  const money = result.moneyVisible !== false && result.totalAmount !== null;

  return bufferDocument(meta, "portrait", (sheet) => {
    drawStats(sheet, [
      { label: "Total tracked", value: formatDuration(result.totalSec, "hms") },
      { label: "Billable", value: formatDuration(result.billableSec, "hms") },
      ...(money
        ? [
            {
              label: `Amount (${currency})`,
              value: formatPdfAmount(result.totalAmount ?? 0),
            },
          ]
        : []),
    ]);

    const table = createTable(sheet, [
      { key: "label", header: "Group", width: null },
      { key: "duration", header: "Duration", width: 78, align: "right" },
      { key: "billable", header: "Billable", width: 78, align: "right" },
      ...(money
        ? [
            {
              key: "amount",
              header: `Amount (${currency})`,
              width: 90,
              align: "right" as const,
            },
          ]
        : []),
    ]);

    if (result.groups.length === 0) {
      table.empty("No time tracked in this range.");
    } else {
      for (const group of result.groups) {
        table.row({
          label: group.label,
          duration: formatDuration(group.seconds, "hms"),
          billable: formatDuration(group.billableSec, "hms"),
          ...(money ? { amount: formatPdfAmount(group.amount ?? 0) } : {}),
        });
      }
    }

    table.total({
      label: "Total",
      duration: formatDuration(result.totalSec, "hms"),
      billable: formatDuration(result.billableSec, "hms"),
      ...(money ? { amount: formatPdfAmount(result.totalAmount ?? 0) } : {}),
    });
  });
}

/** "09:00 - 10:30", or "09:00 - running" for an entry still on the clock. */
function entryClockRange(entry: DetailedEntry, timeZone: string): string {
  const start = formatClockInZone(entry.start, timeZone);
  if (entry.end === null) return `${start} - running`;
  return `${start} - ${formatClockInZone(entry.end, timeZone)}`;
}

/**
 * Render a flat, paginated entry log.
 *
 * The totals row is summed from the entries actually rendered rather than read
 * off `result.totalSec` / `result.totalAmount`: the export path assembles its
 * `DetailedReportResult` by concatenating paginated pages and leaves both
 * totals at 0, and a totals row that disagrees with the rows above it is worse
 * than no totals row at all.
 */
export async function renderDetailedPdf(
  result: DetailedReportResult,
  meta: PdfReportMeta,
): Promise<Buffer> {
  const timeZone = resolveTimeZone(meta.timeZone);
  const currency = sanitizePdfText(result.currency || meta.currency);
  const nowMs = Date.now();

  const totalSec = result.entries.reduce(
    (total, entry) => total + entryDurationSec(entry, nowMs),
    0,
  );
  // See `renderSummaryPdf`: withheld money removes the columns, not the
  // values. The total is summed only when every row may carry money.
  const money = result.moneyVisible !== false;
  const totalAmount = money
    ? sumAmounts(result.entries.map((entry) => entry.amount ?? 0))
    : 0;

  return bufferDocument(meta, "portrait", (sheet) => {
    drawStats(sheet, [
      { label: "Entries", value: String(result.entries.length) },
      { label: "Total tracked", value: formatDuration(totalSec, "hms") },
      ...(money
        ? [{ label: `Amount (${currency})`, value: formatPdfAmount(totalAmount) }]
        : []),
    ]);

    const table = createTable(sheet, [
      { key: "date", header: "Date", width: 54 },
      { key: "time", header: "Time", width: 72 },
      { key: "duration", header: "Duration", width: 46, align: "right" },
      { key: "description", header: "Description", width: null },
      { key: "project", header: "Project / Task", width: 100 },
      // A one-letter header is legible only because the column is a tick box:
      // "Y" or nothing. Anything wider would come out of the description.
      { key: "billable", header: "B", width: 16 },
      ...(money
        ? [
            {
              key: "amount",
              header: `Amount (${currency})`,
              width: 74,
              align: "right" as const,
            },
          ]
        : []),
    ]);

    if (result.entries.length === 0) {
      table.empty("No time tracked in this range.");
    } else {
      for (const entry of result.entries) {
        const project = entry.projectName ?? "No project";
        table.row({
          date: dayKeyInZone(Date.parse(entry.start), timeZone),
          time: entryClockRange(entry, timeZone),
          duration: formatDuration(entryDurationSec(entry, nowMs), "hms"),
          description: entry.description || "(no description)",
          project:
            entry.taskName === null ? project : `${project} / ${entry.taskName}`,
          billable: entry.billable ? "Y" : "",
          ...(money ? { amount: formatPdfAmount(entry.amount ?? 0) } : {}),
        });
      }
    }

    table.total({
      date: "Total",
      duration: formatDuration(totalSec, "hms"),
      ...(money ? { amount: formatPdfAmount(totalAmount) } : {}),
    });
  });
}

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** "Mon 09-01" — the weekday makes a bare date column readable at a glance. */
function weeklyDayHeader(dayKey: string): string {
  // The key is a plain "YYYY-MM-DD"; reading it as UTC keeps the weekday
  // independent of the server's own zone, which is the whole point of the
  // day-key representation.
  const ms = Date.parse(`${dayKey}T00:00:00Z`);
  if (Number.isNaN(ms)) return dayKey;
  const weekday = WEEKDAY_NAMES[new Date(ms).getUTCDay()] ?? "";
  return `${weekday} ${dayKey.slice(5)}`;
}

/**
 * Render a seven-day timesheet grid.
 *
 * Landscape, because nine columns (label + seven days + total) at a legible
 * size do not fit A4 portrait — the day columns would each get ~50pt, which is
 * narrower than "12:00:00" renders.
 */
export async function renderWeeklyPdf(
  result: WeeklyReportResult,
  meta: PdfReportMeta,
): Promise<Buffer> {
  const dayCount = result.days.length;

  return bufferDocument(meta, "landscape", (sheet) => {
    drawStats(sheet, [
      { label: "Total tracked", value: formatDuration(result.totalSec, "hms") },
      { label: "Rows", value: String(result.rows.length) },
      {
        label: "Week",
        value:
          dayCount === 0
            ? "—"
            : `${result.days[0]} to ${result.days[dayCount - 1]}`,
      },
    ]);

    const dayWidth = dayCount === 0 ? 0 : 72;
    const table = createTable(sheet, [
      { key: "label", header: "Project / Task", width: null },
      ...result.days.map((day, index) => ({
        key: `day:${index}`,
        header: weeklyDayHeader(day),
        width: dayWidth,
        align: "right" as const,
      })),
      { key: "total", header: "Total", width: 72, align: "right" as const },
    ]);

    const dayCells = (seconds: number[]): PdfCells => {
      const cells: PdfCells = {};
      for (let index = 0; index < dayCount; index += 1) {
        const value = seconds[index] ?? 0;
        // Blank rather than "0:00:00": an empty cell reads as "nothing here",
        // and a grid of zeroes buries the days that were actually worked.
        cells[`day:${index}`] = value === 0 ? "" : formatDuration(value, "hms");
      }
      return cells;
    };

    if (result.rows.length === 0) {
      table.empty("No time tracked in this week.");
    } else {
      for (const row of result.rows) {
        table.row({
          label: row.label,
          ...dayCells(row.daySeconds),
          total: formatDuration(row.totalSec, "hms"),
        });
      }
    }

    table.total({
      label: "Total",
      ...dayCells(result.dayTotals),
      total: formatDuration(result.totalSec, "hms"),
    });
  });
}
