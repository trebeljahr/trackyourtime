/**
 * The invoice document, as a PDF.
 *
 * Deliberately a separate module from `services/pdf.ts` even though both draw
 * with pdfkit, because the two answer different questions. A report is a
 * TABLE: an arbitrary number of rows, paginated, summarising a query that can
 * be re-run. An invoice is a DOCUMENT: a header block naming the parties and
 * dates, a short list of lines, and a totals stack anchored under them — and
 * every figure on it is a snapshot that must never be recomputed. Bending the
 * report renderer to also produce that shape would make both harder to read.
 *
 * The text hygiene is shared, though: `sanitizePdfText` and `formatPdfAmount`
 * are imported from the report renderer so a description with a stray control
 * character or an amount with a thousands separator behaves identically in
 * both documents.
 *
 * Everything here renders from the PERSISTED `Invoice` wire object. Nothing is
 * looked up, nothing is re-derived — a document already sent to a customer has
 * to keep printing exactly the same page a year later.
 */
import PDFDocument from "pdfkit";
import type { Invoice, InvoiceLineItem } from "@starter/shared";
import { formatPdfAmount, sanitizePdfText } from "./pdf.js";

/** The only thing not already on the invoice: when this copy was printed. */
export type InvoicePdfMeta = {
  /** ISO datetime the document was rendered at. */
  generatedAt: string;
};

const MARGINS = { top: 48, bottom: 30, left: 48, right: 48 } as const;

/**
 * Reserved band above the bottom margin for the footer. pdfkit starts a new
 * page the moment a text run would cross `maxY`, so drawing "below the
 * content" would silently emit a blank page per page; keeping every row above
 * the band means this module owns each page break.
 */
const FOOTER_BAND = 18;

const FONT = "Helvetica";
const FONT_BOLD = "Helvetica-Bold";

const TITLE_SIZE = 20;
const HEADING_SIZE = 9;
const BODY_SIZE = 9;
const META_SIZE = 8;

const ROW_HEIGHT = 16;
const CELL_PADDING = 4;

const INK = "#111111";
const MUTED = "#666666";
const RULE = "#cccccc";
const RULE_STRONG = "#888888";

const pageOptions = (): PDFKit.PDFDocumentOptions => ({
  size: "A4",
  layout: "portrait",
  margins: { ...MARGINS },
});

const ELLIPSIS = "...";

/**
 * Truncate to the column width, measured in the font actually being drawn.
 *
 * A project name is user input with no length limit worth trusting, and an
 * overflowing cell in pdfkit does not clip — it wraps into the row below and
 * shears the whole table.
 */
function fitText(
  doc: PDFKit.PDFDocument,
  value: string,
  width: number,
): string {
  const clean = sanitizePdfText(value);
  if (clean === "" || doc.widthOfString(clean) <= width) return clean;

  let low = 0;
  let high = clean.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = `${clean.slice(0, middle)}${ELLIPSIS}`;
    if (doc.widthOfString(candidate) <= width) low = middle;
    else high = middle - 1;
  }
  return low <= 0 ? ELLIPSIS : `${clean.slice(0, low)}${ELLIPSIS}`;
}

type Column = {
  key: keyof Cells;
  header: string;
  /** `null` shares whatever width the fixed columns leave over. */
  width: number | null;
  align: "left" | "right";
};

type Cells = {
  label: string;
  hours: string;
  rate: string;
  amount: string;
};

type SizedColumn = Column & { width: number };

type Sheet = {
  doc: PDFKit.PDFDocument;
  invoice: Invoice;
  meta: InvoicePdfMeta;
  left: number;
  width: number;
  top: number;
  bottom: number;
  y: number;
  page: number;
};

/** "2026-08-31T22:00:00.000Z" → "2026-08-31". Dates on an invoice are dates. */
const isoDate = (value: string): string => sanitizePdfText(value).slice(0, 10);

const columnsFor = (doc: PDFKit.PDFDocument, width: number): SizedColumn[] => {
  const definition: Column[] = [
    { key: "label", header: "Description", width: null, align: "left" },
    { key: "hours", header: "Hours", width: 60, align: "right" },
    { key: "rate", header: "Rate", width: 70, align: "right" },
    { key: "amount", header: "Amount", width: 80, align: "right" },
  ];
  void doc;
  const fixed = definition.reduce((total, column) => total + (column.width ?? 0), 0);
  return definition.map((column) => ({
    ...column,
    width: column.width ?? Math.max(120, width - fixed),
  }));
};

function drawFooter(sheet: Sheet): void {
  const { doc, invoice } = sheet;
  const y = doc.page.height - MARGINS.bottom - 12;
  doc
    .font(FONT)
    .fontSize(META_SIZE)
    .fillColor(MUTED)
    .text(
      `Invoice ${sanitizePdfText(invoice.number)} · ${sanitizePdfText(invoice.clientName)}`,
      sheet.left,
      y,
      { width: sheet.width, align: "left", lineBreak: false },
    )
    .text(`Page ${sheet.page}`, sheet.left, y, {
      width: sheet.width,
      align: "right",
      lineBreak: false,
    });
  doc.fillColor(INK);
}

/** Two-column key/value block — the parties-and-dates masthead. */
function drawHeaderBlock(sheet: Sheet): void {
  const { doc, invoice } = sheet;

  doc
    .font(FONT_BOLD)
    .fontSize(TITLE_SIZE)
    .fillColor(INK)
    .text(`Invoice ${sanitizePdfText(invoice.number)}`, sheet.left, sheet.y, {
      width: sheet.width,
      lineBreak: false,
    });
  sheet.y += TITLE_SIZE + 10;

  const half = sheet.width / 2;
  const rows: [string, string][] = [
    ["Billed to", sanitizePdfText(invoice.clientName)],
    ["Status", invoice.status],
    ["Issue date", isoDate(invoice.issueDate)],
    ["Due date", isoDate(invoice.dueDate)],
    [
      "Period",
      `${isoDate(invoice.from)} to ${isoDate(invoice.to)}`,
    ],
    ["Grouped by", invoice.groupBy],
  ];

  for (const [label, value] of rows) {
    doc
      .font(FONT)
      .fontSize(META_SIZE)
      .fillColor(MUTED)
      .text(label, sheet.left, sheet.y, { width: half - 8, lineBreak: false });
    doc
      .font(FONT_BOLD)
      .fontSize(BODY_SIZE)
      .fillColor(INK)
      .text(fitText(doc, value, half - 8), sheet.left + half, sheet.y - 1, {
        width: half,
        lineBreak: false,
      });
    sheet.y += ROW_HEIGHT - 2;
  }

  sheet.y += 6;
  doc
    .font(FONT)
    .fontSize(META_SIZE)
    .fillColor(MUTED)
    .text(
      `Amounts in ${sanitizePdfText(invoice.currency)} · generated ${sanitizePdfText(
        sheet.meta.generatedAt,
      )}`,
      sheet.left,
      sheet.y,
      { width: sheet.width, lineBreak: false },
    );
  sheet.y += META_SIZE + 12;
  doc.fillColor(INK);
}

function drawRule(sheet: Sheet, strong: boolean): void {
  sheet.doc
    .save()
    .lineWidth(strong ? 1 : 0.5)
    .strokeColor(strong ? RULE_STRONG : RULE)
    .moveTo(sheet.left, sheet.y)
    .lineTo(sheet.left + sheet.width, sheet.y)
    .stroke()
    .restore();
  sheet.y += 4;
}

type RowStyle = "header" | "body" | "total";

function drawRow(
  sheet: Sheet,
  columns: SizedColumn[],
  cells: Partial<Cells>,
  style: RowStyle,
): void {
  const { doc } = sheet;
  const bold = style !== "body";
  let x = sheet.left;

  doc
    .font(bold ? FONT_BOLD : FONT)
    .fontSize(BODY_SIZE)
    .fillColor(style === "header" ? MUTED : INK);

  for (const column of columns) {
    const raw = cells[column.key] ?? "";
    const inner = column.width - CELL_PADDING * 2;
    doc.text(fitText(doc, raw, inner), x + CELL_PADDING, sheet.y + 3, {
      width: inner,
      align: column.align,
      lineBreak: false,
    });
    x += column.width;
  }

  sheet.y += ROW_HEIGHT;
  doc.fillColor(INK);
  if (style !== "body") drawRule(sheet, style === "total");
}

/** Start a fresh page when the next row would cross the footer band. */
function ensureSpace(sheet: Sheet, columns: SizedColumn[], needed: number): void {
  if (sheet.y + needed <= sheet.bottom) return;
  sheet.doc.addPage(pageOptions());
  sheet.page += 1;
  sheet.y = sheet.top;
  sheet.doc
    .font(FONT_BOLD)
    .fontSize(HEADING_SIZE)
    .fillColor(INK)
    .text(
      `Invoice ${sanitizePdfText(sheet.invoice.number)} · continued`,
      sheet.left,
      sheet.y,
      { width: sheet.width, lineBreak: false },
    );
  sheet.y += HEADING_SIZE + 10;
  drawFooter(sheet);
  drawRow(sheet, columns, headerCells(columns), "header");
}

const headerCells = (columns: SizedColumn[]): Partial<Cells> =>
  Object.fromEntries(
    columns.map((column) => [column.key, column.header]),
  ) as Partial<Cells>;

/** `2.5` → "2.50" — the quantity column always shows two decimals. */
const formatHours = (hours: number): string =>
  Number.isFinite(hours) ? hours.toFixed(2) : "0.00";

const lineCells = (line: InvoiceLineItem): Cells => ({
  label: line.label,
  hours: formatHours(line.hours),
  rate: formatPdfAmount(line.hourlyRate),
  amount: formatPdfAmount(line.amount),
});

/** The subtotal / tax / total stack, right-aligned under the amount column. */
function drawTotals(sheet: Sheet, columns: SizedColumn[]): void {
  const { doc, invoice } = sheet;
  const amountColumn = columns[columns.length - 1];
  if (amountColumn === undefined) return;

  const valueWidth = amountColumn.width - CELL_PADDING * 2;
  const labelWidth = 160;
  const valueX = sheet.left + sheet.width - amountColumn.width + CELL_PADDING;
  const labelX = valueX - labelWidth - 8;

  const rows: { label: string; value: string; strong: boolean }[] = [
    {
      label: `Subtotal (${sanitizePdfText(invoice.currency)})`,
      value: formatPdfAmount(invoice.subtotal),
      strong: false,
    },
  ];
  // A null tax rate means the invoice carries no tax line at all; 0 is a real
  // 0% and still prints, because "no VAT charged" is a statement a customer
  // may need to see.
  if (invoice.taxRate !== null) {
    rows.push({
      label: `Tax (${invoice.taxRate}%)`,
      value: formatPdfAmount(invoice.taxAmount),
      strong: false,
    });
  }
  rows.push({
    label: `Total (${sanitizePdfText(invoice.currency)})`,
    value: formatPdfAmount(invoice.total),
    strong: true,
  });

  sheet.y += 6;
  for (const row of rows) {
    ensureSpace(sheet, columns, ROW_HEIGHT);
    doc
      .font(row.strong ? FONT_BOLD : FONT)
      .fontSize(BODY_SIZE)
      .fillColor(row.strong ? INK : MUTED)
      .text(fitText(doc, row.label, labelWidth), labelX, sheet.y + 3, {
        width: labelWidth,
        align: "right",
        lineBreak: false,
      });
    doc
      .font(FONT_BOLD)
      .fillColor(INK)
      .text(fitText(doc, row.value, valueWidth), valueX, sheet.y + 3, {
        width: valueWidth,
        align: "right",
        lineBreak: false,
      });
    sheet.y += ROW_HEIGHT;
    if (row.strong) drawRule(sheet, true);
  }
  doc.fillColor(INK);
}

/**
 * Render one persisted invoice.
 *
 * pdfkit is a Node stream, so this is where callback-land is bridged back
 * into a promise. `doc.end()` has to be called before the await, otherwise
 * the "end" event never fires and the promise hangs.
 */
export async function renderInvoicePdf(
  invoice: Invoice,
  meta: InvoicePdfMeta,
): Promise<Buffer> {
  const doc = new PDFDocument(pageOptions());
  doc.info.Title = sanitizePdfText(`Invoice ${invoice.number}`);
  doc.info.Creator = "Track Your Time";
  const chunks: Buffer[] = [];

  return new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", (error: Error) => reject(error));

    try {
      const sheet: Sheet = {
        doc,
        invoice,
        meta,
        left: MARGINS.left,
        width: doc.page.width - MARGINS.left - MARGINS.right,
        top: MARGINS.top,
        bottom: doc.page.height - MARGINS.bottom - FOOTER_BAND,
        y: MARGINS.top,
        page: 1,
      };

      drawFooter(sheet);
      drawHeaderBlock(sheet);

      const columns = columnsFor(doc, sheet.width);
      drawRow(sheet, columns, headerCells(columns), "header");

      if (invoice.lineItems.length === 0) {
        drawRow(sheet, columns, { label: "No billable time in this range." }, "body");
      } else {
        for (const line of invoice.lineItems) {
          ensureSpace(sheet, columns, ROW_HEIGHT);
          drawRow(sheet, columns, lineCells(line), "body");
        }
      }

      drawRule(sheet, false);
      drawTotals(sheet, columns);

      if (invoice.notes && invoice.notes.trim() !== "") {
        ensureSpace(sheet, columns, ROW_HEIGHT * 3);
        sheet.y += 8;
        doc
          .font(FONT_BOLD)
          .fontSize(META_SIZE)
          .fillColor(MUTED)
          .text("Notes", sheet.left, sheet.y, {
            width: sheet.width,
            lineBreak: false,
          });
        sheet.y += META_SIZE + 4;
        // Notes are the one place a wrap is wanted, so this is the only text
        // run that may flow — height is measured first and the y cursor moved
        // by the real height so nothing lands on top of it.
        const text = sanitizePdfText(invoice.notes);
        const height = doc
          .font(FONT)
          .fontSize(BODY_SIZE)
          .fillColor(INK)
          .heightOfString(text, { width: sheet.width });
        doc.text(text, sheet.left, sheet.y, {
          width: sheet.width,
          height: Math.min(height, sheet.bottom - sheet.y),
        });
        sheet.y += height;
      }

      doc.end();
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/**
 * A filename an accountant can sort: `invoice-2026-014.pdf`.
 *
 * The number is user-influenced (a caller may supply their own), so anything
 * that is not a letter, digit, dash or underscore is folded to a dash —
 * a slash or a "..\" in a filename is a path, not a name.
 */
export function invoicePdfFilename(number: string): string {
  const safe = sanitizePdfText(number)
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `invoice-${safe === "" ? "document" : safe}.pdf`;
}
