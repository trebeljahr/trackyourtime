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
 * The text hygiene is shared, though: `sanitizePdfText` is imported from the
 * report renderer so a description with a stray control character behaves
 * identically in both documents, and both format figures through
 * `services/pdf-format.ts`.
 *
 * Everything here renders from the PERSISTED `Invoice` wire object. Nothing is
 * looked up, nothing is re-derived — a document already sent to a customer has
 * to keep printing exactly the same page a year later. That includes the two
 * parties: `invoice.issuer` and `invoice.recipient` are snapshots taken at
 * creation, and an invoice from before they existed carries neither and
 * prints the client name alone, exactly as it always did.
 *
 * Every word on the page comes from the `invoice` server catalog, and every
 * figure is formatted, in the language snapshotted on the invoice
 * (`invoice.locale`) — never the viewer's preference, the client's current
 * setting or the request's headers, any of which can change after the invoice
 * was sent. An invoice without a `locale` predates localisation and renders in
 * English.
 *
 * The ZUGFeRD hybrid (`einvoice/pdfa3.ts`) is this same drawing with a
 * variant: see `InvoicePdfVariant`. The e-invoice data (VAT breakdown,
 * exemption reasons, VAT id and bank fields) prints only when the snapshot
 * carries it, through the pure helpers in `invoice-pdf-blocks.ts`.
 */
import PDFDocument from "pdfkit";
import {
  formatPostalAddress,
  type Invoice,
  type InvoiceIssuer,
  type InvoiceLineItem,
  type InvoiceRecipient,
  type Locale,
} from "@starter/shared";
import { serverT, type ServerTranslator } from "../i18n/index.js";
import { billedPeriodDates } from "./einvoice/format.js";
import {
  bankLines,
  breakdownTotalRows,
  exemptionReasons,
  omitsVatIds,
  taxIdentityLines,
} from "./invoice-pdf-blocks.js";
import { sanitizePdfText } from "./pdf.js";
import { pdfFormat, type PdfFormat } from "./pdf-format.js";

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

/**
 * The names every draw call uses. A variant may `registerFont()` these to
 * substitute embedded faces: pdfkit resolves a registered name before its
 * standard-14 table, so no drawing line changes. A literal standard-14 name
 * anywhere else in this file would put an unembedded font into every PDF/A.
 */
export const INVOICE_PDF_FONT_NAMES = { regular: FONT, bold: FONT_BOLD } as const;

/** Everything that makes a variant of the same drawing: document options, fonts, and what happens before end(). */
export type InvoicePdfVariant = {
  /** Spread over pageOptions() in the constructor only. addPage keeps using pageOptions(). */
  documentOptions: PDFKit.PDFDocumentOptions;
  /** After construction and the info fields, before the first draw. */
  prepare(doc: PDFKit.PDFDocument): void;
  /** After the last draw, immediately before doc.end(). */
  finish(doc: PDFKit.PDFDocument): void;
};

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
  t: ServerTranslator<"invoice">;
  format: PdfFormat;
  left: number;
  width: number;
  top: number;
  bottom: number;
  y: number;
  page: number;
};

const columnsFor = (
  t: ServerTranslator<"invoice">,
  width: number,
): SizedColumn[] => {
  const definition: Column[] = [
    { key: "label", header: t("columns.description"), width: null, align: "left" },
    { key: "hours", header: t("columns.hours"), width: 60, align: "right" },
    { key: "rate", header: t("columns.rate"), width: 70, align: "right" },
    { key: "amount", header: t("columns.amount"), width: 80, align: "right" },
  ];
  const fixed = definition.reduce((total, column) => total + (column.width ?? 0), 0);
  return definition.map((column) => ({
    ...column,
    width: column.width ?? Math.max(120, width - fixed),
  }));
};

function drawFooter(sheet: Sheet): void {
  const { doc, invoice, t } = sheet;
  const y = doc.page.height - MARGINS.bottom - 12;
  doc
    .font(FONT)
    .fontSize(META_SIZE)
    .fillColor(MUTED)
    .text(
      sanitizePdfText(
        t("footer", { number: invoice.number, client: invoice.clientName }),
      ),
      sheet.left,
      y,
      { width: sheet.width, align: "left", lineBreak: false },
    )
    .text(t("page", { page: String(sheet.page) }), sheet.left, y, {
      width: sheet.width,
      align: "right",
      lineBreak: false,
    });
  doc.fillColor(INK);
}

/**
 * The issuer's lines, in print order: name, address, tax ids, registration,
 * contact. The VAT id and tax number replace the legacy tax id when the
 * snapshot has either (see `taxIdentityLines`); a snapshot from before
 * e-invoicing has neither and prints as it always did.
 */
function issuerLines(
  issuer: InvoiceIssuer,
  t: ServerTranslator<"invoice">,
  omitVatId: boolean,
): PartyLine[] {
  const contact = [issuer.contactName ?? null, issuer.email, issuer.phone, issuer.website]
    .filter((part): part is string => part !== null && part !== undefined)
    .join(" · ");
  const registrationNumber = issuer.registrationNumber ?? null;
  return [
    ...(issuer.legalName ? [{ text: issuer.legalName, bold: true }] : []),
    ...formatPostalAddress(issuer).map((text) => ({ text, bold: false })),
    ...taxIdentityLines(issuer, t, { omitVatId }).map((text) => ({ text, bold: false })),
    ...(registrationNumber
      ? [{ text: t("registrationNumber", { registrationNumber }), bold: false }]
      : []),
    ...(contact ? [{ text: contact, bold: false }] : []),
  ];
}

/**
 * "Billed to", from the recipient snapshot. Without one — every invoice
 * created before billing details existed — the client name is the whole
 * block, which is what the document always printed.
 */
function recipientLines(
  invoice: Invoice,
  recipient: InvoiceRecipient | null,
  t: ServerTranslator<"invoice">,
  omitVatId: boolean,
): PartyLine[] {
  if (!recipient) return [{ text: invoice.clientName, bold: true }];
  const legalName =
    recipient.legalName && recipient.legalName !== recipient.name
      ? recipient.legalName
      : null;
  return [
    { text: recipient.name, bold: true },
    ...(legalName ? [{ text: legalName, bold: false }] : []),
    ...formatPostalAddress(recipient).map((text) => ({ text, bold: false })),
    ...taxIdentityLines(recipient, t, { omitVatId }).map((text) => ({ text, bold: false })),
    ...(recipient.email ? [{ text: recipient.email, bold: false }] : []),
    ...(recipient.reference
      ? [{ text: t("reference", { reference: recipient.reference }), bold: false }]
      : []),
  ];
}

type PartyLine = { text: string; bold: boolean };

/** One party block: a muted label, then one truncated line per entry. */
function drawParty(
  sheet: Sheet,
  x: number,
  y: number,
  width: number,
  label: string,
  lines: PartyLine[],
): number {
  const { doc } = sheet;
  doc
    .font(FONT)
    .fontSize(META_SIZE)
    .fillColor(MUTED)
    .text(label, x, y, { width, lineBreak: false });
  let cursor = y + META_SIZE + 5;
  for (const line of lines) {
    doc
      .font(line.bold ? FONT_BOLD : FONT)
      .fontSize(BODY_SIZE)
      .fillColor(INK);
    doc.text(fitText(doc, line.text, width), x, cursor, {
      width,
      lineBreak: false,
    });
    cursor += BODY_SIZE + 4;
  }
  return cursor;
}

/** The masthead: title, the two parties side by side, then the dates. */
function drawHeaderBlock(sheet: Sheet): void {
  const { doc, invoice, t, format } = sheet;

  doc
    .font(FONT_BOLD)
    .fontSize(TITLE_SIZE)
    .fillColor(INK)
    .text(
      fitText(doc, t("title", { number: invoice.number }), sheet.width),
      sheet.left,
      sheet.y,
      { width: sheet.width, lineBreak: false },
    );
  sheet.y += TITLE_SIZE + 10;

  const half = sheet.width / 2;
  const issuer = invoice.issuer ?? null;
  // BR-O-02: the XML of an invoice with a not-subject line carries no VAT id,
  // and the page it is the "Alternative" of may not show one either.
  const omitVatId = omitsVatIds(invoice);
  const recipientBottom = drawParty(
    sheet,
    sheet.left,
    sheet.y,
    half - 8,
    t("billedTo"),
    recipientLines(invoice, invoice.recipient ?? null, t, omitVatId),
  );
  const issuerBottom = issuer
    ? drawParty(
        sheet,
        sheet.left + half,
        sheet.y,
        half,
        t("from"),
        issuerLines(issuer, t, omitVatId),
      )
    : sheet.y;
  sheet.y = Math.max(recipientBottom, issuerBottom) + 8;

  // `to` is the exclusive bound, midnight of the day after the last billed
  // day; the page names the last billed day, as BT-74 does.
  const period = billedPeriodDates(invoice.from, invoice.to);
  const rows: [string, string][] = [
    [t("status"), t("statusValue", { status: invoice.status })],
    [t("issueDate"), format.date(invoice.issueDate)],
    [t("dueDate"), format.date(invoice.dueDate)],
    [
      t("period"),
      // An invoice created since e-invoicing (it froze a BT-20 sentence) ends
      // on the last billed day, the date its XML carries as BT-74. Older
      // invoices keep the exclusive `to` they were sent with: a re-render must
      // reproduce the page the customer already holds.
      invoice.paymentTerms
        ? t("periodRange", { from: format.date(period.start), to: format.date(period.end) })
        : t("periodRange", { from: format.date(invoice.from), to: format.date(invoice.to) }),
    ],
    [t("groupedBy"), t("groupByValue", { groupBy: invoice.groupBy })],
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
      sanitizePdfText(
        t("amountsIn", {
          currency: invoice.currency,
          generatedAt: format.timestamp(sheet.meta.generatedAt),
        }),
      ),
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
      sanitizePdfText(sheet.t("continued", { number: sheet.invoice.number })),
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

/** `2.5` → "2.50" ("2,50") — the quantity column always shows two decimals. */
const lineCells = (format: PdfFormat, line: InvoiceLineItem): Cells => ({
  label: line.label,
  hours: format.hours(line.hours),
  rate: format.amount(line.hourlyRate),
  amount: format.amount(line.amount),
});

/** The subtotal / tax / total stack, right-aligned under the amount column. */
function drawTotals(sheet: Sheet, columns: SizedColumn[]): void {
  const { doc, invoice, t, format } = sheet;
  const amountColumn = columns[columns.length - 1];
  if (amountColumn === undefined) return;

  const valueWidth = amountColumn.width - CELL_PADDING * 2;
  const labelWidth = 160;
  const valueX = sheet.left + sheet.width - amountColumn.width + CELL_PADDING;
  const labelX = valueX - labelWidth - 8;

  const rows: { label: string; value: string; strong: boolean }[] = [
    {
      label: t("subtotal", { currency: invoice.currency }),
      value: format.amount(invoice.subtotal),
      strong: false,
    },
  ];
  // A stored VAT breakdown prints one row per category and rate, each naming
  // its taxable amount. Without one — every invoice from before e-invoicing —
  // a null tax rate means the invoice carries no tax line at all; 0 is a real
  // 0% and still prints, because "no VAT charged" is a statement a customer
  // may need to see.
  const breakdown = breakdownTotalRows(invoice, t, format);
  if (breakdown.length > 0) {
    rows.push(...breakdown);
  } else if (invoice.taxRate !== null) {
    rows.push({
      label: t("tax", { rate: format.plain(invoice.taxRate) }),
      value: format.amount(invoice.taxAmount),
      strong: false,
    });
  }
  rows.push({
    label: t("total", { currency: invoice.currency }),
    value: format.amount(invoice.total),
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
 * When payment is due, in words: the frozen BT-20 sentence when the invoice
 * stores one, so the page and the e-invoice cannot state different terms, and
 * otherwise the same sentence built from the snapshot. Terms print only when
 * the issuer had terms at creation; the due date itself is always the
 * invoice's own field, which the person may have moved off the suggestion.
 */
function dueLine(
  invoice: Invoice,
  issuer: InvoiceIssuer,
  t: ServerTranslator<"invoice">,
  format: PdfFormat,
): string {
  // The sentence frozen at creation (BT-20) wins, so the page and the XML say
  // the same thing; invoices from before it existed keep the derived line.
  if (typeof invoice.paymentTerms === "string" && invoice.paymentTerms.trim() !== "") {
    return invoice.paymentTerms;
  }
  const date = format.date(invoice.dueDate);
  return issuer.paymentTermsDays === null
    ? t("dueBy", { date })
    : t("dueWithinTerms", { days: issuer.paymentTermsDays, date });
}

/**
 * A wrapped block of free text under an optional heading — notes, payment
 * details, the footer line. These are the only runs that may flow, so the
 * height is measured first and the cursor moved by the real height, and a
 * block that does not fit starts a new page instead of running into the
 * footer band.
 *
 * `keepLines` keeps the line breaks the person typed. Payment details are
 * written as lines (bank, IBAN, BIC) and read wrongly as one run; notes stay
 * collapsed, because invoices already sent printed them that way.
 */
function drawParagraph(
  sheet: Sheet,
  columns: SizedColumn[],
  heading: string | null,
  body: string | null,
  keepLines = false,
): void {
  if (body === null || body.trim() === "") return;
  const { doc } = sheet;
  const text = keepLines
    ? body
        .split(/\r\n|\r|\n/)
        .map(sanitizePdfText)
        .filter((line) => line !== "")
        .join("\n")
    : sanitizePdfText(body);
  const height = doc
    .font(FONT)
    .fontSize(BODY_SIZE)
    .heightOfString(text, { width: sheet.width });
  const headingHeight = heading ? META_SIZE + 4 : 0;
  ensureSpace(
    sheet,
    columns,
    Math.min(8 + headingHeight + height, sheet.bottom - sheet.top - ROW_HEIGHT * 2),
  );
  sheet.y += 8;
  if (heading) {
    doc
      .font(FONT_BOLD)
      .fontSize(META_SIZE)
      .fillColor(MUTED)
      .text(heading, sheet.left, sheet.y, { width: sheet.width, lineBreak: false });
    sheet.y += headingHeight;
  }
  doc.font(FONT).fontSize(BODY_SIZE).fillColor(INK);
  doc.text(text, sheet.left, sheet.y, {
    width: sheet.width,
    height: Math.min(height, sheet.bottom - sheet.y),
  });
  sheet.y += height;
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
  variant?: InvoicePdfVariant,
): Promise<Buffer> {
  const doc = new PDFDocument({ ...pageOptions(), ...variant?.documentOptions });
  // Absent = issued before localisation = English, forever.
  const locale: Locale = invoice.locale ?? "en";
  const t = serverT(locale, "invoice");
  const format = pdfFormat(locale);
  doc.info.Title = sanitizePdfText(t("title", { number: invoice.number }));
  doc.info.Creator = "Track Your Time";
  variant?.prepare(doc);
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
        t,
        format,
        left: MARGINS.left,
        width: doc.page.width - MARGINS.left - MARGINS.right,
        top: MARGINS.top,
        bottom: doc.page.height - MARGINS.bottom - FOOTER_BAND,
        y: MARGINS.top,
        page: 1,
      };

      drawFooter(sheet);
      drawHeaderBlock(sheet);

      const columns = columnsFor(t, sheet.width);
      drawRow(sheet, columns, headerCells(columns), "header");

      if (invoice.lineItems.length === 0) {
        drawRow(sheet, columns, { label: t("noLines") }, "body");
      } else {
        for (const line of invoice.lineItems) {
          ensureSpace(sheet, columns, ROW_HEIGHT);
          drawRow(sheet, columns, lineCells(format, line), "body");
        }
      }

      drawRule(sheet, false);
      drawTotals(sheet, columns);
      drawParagraph(sheet, columns, t("vatNote"), exemptionReasons(invoice).join("\n"), true);

      drawParagraph(sheet, columns, t("notes"), invoice.notes);

      const issuer = invoice.issuer ?? null;
      if (issuer) {
        drawParagraph(
          sheet,
          columns,
          t("paymentDetails"),
          [dueLine(invoice, issuer, t, sheet.format), ...bankLines(issuer, t), issuer.paymentDetails]
            .filter((part): part is string => part !== null)
            .join("\n"),
          true,
        );
        drawParagraph(sheet, columns, null, issuer.invoiceFooter, true);
      }

      variant?.finish(doc);
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
