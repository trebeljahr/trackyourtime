import assert from "node:assert/strict";
import { describe, it } from "node:test";
// Type-only import: erased at compile time, so this never hits the bare-named
// import from "@starter/shared" that throws under tsx (see duration.test.ts).
import type { Invoice, InvoiceLineItem } from "@starter/shared";
import {
  bumpInvoiceNumber,
  formatInvoiceNumber,
  invoiceNumberCandidates,
  nextInvoiceNumber,
  parseInvoiceNumber,
  yearOfIsoDate,
} from "../services/invoice-number.js";
import { invoicePdfFilename, renderInvoicePdf } from "../services/invoice-pdf.js";
import { pdfFormat } from "../services/pdf-format.js";
import { pageTexts } from "./support/pdf-bytes.js";
import {
  invoiceLineItems,
  invoiceTotals,
  isValidStatusTransition,
  selectBillableEntries,
  type BillableCandidate,
  type BillableEntry,
} from "../trpc/routers/invoices.js";

const HOUR = 3600;

const candidate = (
  overrides: Partial<BillableCandidate> = {},
): BillableCandidate => ({
  id: "e1",
  projectId: "p1",
  projectName: "Website",
  taskId: null,
  taskName: null,
  seconds: HOUR,
  hourlyRate: 100,
  currency: "EUR",
  invoiceId: null,
  ...overrides,
});

const billable = (overrides: Partial<BillableEntry> = {}): BillableEntry => ({
  ...(candidate() as BillableEntry),
  hourlyRate: 100,
  ...overrides,
});

// ── the billable set ─────────────────────────────────────────────────

describe("selectBillableEntries", () => {
  it("keeps stopped, rated, un-invoiced time", () => {
    const selection = selectBillableEntries([candidate()]);
    assert.equal(selection.billable.length, 1);
    assert.equal(selection.skippedInvoiced, 0);
    assert.equal(selection.skippedMissingRate, 0);
  });

  it("NEVER bills an entry that already carries an invoiceId", () => {
    // This is the whole point of the feature: an hour already on invoice
    // 2026-003 must not appear on 2026-004 as well. Billing a customer twice
    // for the same hour is the worst bug this code can have.
    const selection = selectBillableEntries([
      candidate({ id: "fresh" }),
      candidate({ id: "already-billed", invoiceId: "inv-1" }),
    ]);

    assert.deepEqual(
      selection.billable.map((entry) => entry.id),
      ["fresh"],
    );
    assert.equal(selection.skippedInvoiced, 1);
  });

  it("counts entries excluded for a missing rate instead of billing zero", () => {
    const selection = selectBillableEntries([
      candidate({ id: "a" }),
      candidate({ id: "b", hourlyRate: null }),
      candidate({ id: "c", hourlyRate: null }),
    ]);

    assert.equal(selection.billable.length, 1);
    assert.equal(selection.skippedMissingRate, 2);
  });

  it("bills a rate of zero — 0 is a real rate, null is a missing one", () => {
    const selection = selectBillableEntries([candidate({ hourlyRate: 0 })]);
    assert.equal(selection.billable.length, 1);
    assert.equal(selection.skippedMissingRate, 0);
  });

  it("drops zero-length entries without raising a warning", () => {
    const selection = selectBillableEntries([candidate({ seconds: 0 })]);
    assert.equal(selection.billable.length, 0);
    assert.equal(selection.skippedMissingRate, 0);
    assert.equal(selection.skippedInvoiced, 0);
  });

  it("reports every currency it saw, so the router can refuse a mixed range", () => {
    const selection = selectBillableEntries([
      candidate({ id: "a", currency: "EUR" }),
      candidate({ id: "b", currency: "USD" }),
      candidate({ id: "c", currency: "EUR" }),
    ]);
    assert.deepEqual(selection.currencies, ["EUR", "USD"]);
  });

  it("does not count an already-invoiced entry as missing a rate", () => {
    // The invoiced check has to win: the entry is excluded because it is
    // billed, not because something is wrong with it.
    const selection = selectBillableEntries([
      candidate({ hourlyRate: null, invoiceId: "inv-1" }),
    ]);
    assert.equal(selection.skippedInvoiced, 1);
    assert.equal(selection.skippedMissingRate, 0);
  });
});

// ── grouping ─────────────────────────────────────────────────────────

describe("invoiceLineItems — grouping by project", () => {
  it("rolls every entry of a project into one line", () => {
    const lines = invoiceLineItems(
      [
        billable({ id: "a", seconds: HOUR }),
        billable({ id: "b", seconds: 2 * HOUR }),
      ],
      "project",
    );

    assert.equal(lines.length, 1);
    assert.equal(lines[0]?.key, "p1");
    assert.equal(lines[0]?.label, "Website");
    assert.equal(lines[0]?.seconds, 3 * HOUR);
    assert.equal(lines[0]?.hours, 3);
    assert.equal(lines[0]?.amount, 300);
  });

  it("keeps separate projects on separate lines, sorted by label", () => {
    const lines = invoiceLineItems(
      [
        billable({ id: "a", projectId: "p2", projectName: "Zebra" }),
        billable({ id: "b", projectId: "p1", projectName: "Alpha" }),
      ],
      "project",
    );
    assert.deepEqual(
      lines.map((line) => line.label),
      ["Alpha", "Zebra"],
    );
  });

  it("rounds money once from the line's seconds, not per entry", () => {
    // Three 10-second slivers at 100/h are 0.2777... each — 0.28 apiece if
    // rounded per entry, but the line is 30 seconds = 0.83. Rounding per
    // entry would over-bill by a cent on this line alone.
    const lines = invoiceLineItems(
      [
        billable({ id: "a", seconds: 10 }),
        billable({ id: "b", seconds: 10 }),
        billable({ id: "c", seconds: 10 }),
      ],
      "project",
    );
    assert.equal(lines[0]?.seconds, 30);
    assert.equal(lines[0]?.amount, 0.83);
  });
});

describe("invoiceLineItems — grouping by task", () => {
  it("names the line with its project and task", () => {
    const lines = invoiceLineItems(
      [billable({ taskId: "t1", taskName: "Copywriting" })],
      "task",
    );
    assert.equal(lines[0]?.key, "t1");
    assert.equal(lines[0]?.label, "Website — Copywriting");
    assert.equal(lines[0]?.taskId, "t1");
  });

  it("keeps untasked time of two projects apart", () => {
    // A shared "none" key would collapse unrelated work from two projects
    // into a single line the customer cannot check.
    const lines = invoiceLineItems(
      [
        billable({ id: "a", projectId: "p1", projectName: "Website" }),
        billable({ id: "b", projectId: "p2", projectName: "App" }),
      ],
      "task",
    );
    assert.equal(lines.length, 2);
    assert.deepEqual(
      lines.map((line) => line.key).sort(),
      ["p1:none", "p2:none"],
    );
  });
});

describe("invoiceLineItems — one line per distinct snapshotted rate", () => {
  it("splits a group whose entries were billed at different rates", () => {
    // The project's rate rose from 80 to 100 mid-range. Averaging to 90 would
    // print a rate that was never agreed for any of these hours.
    const lines = invoiceLineItems(
      [
        billable({ id: "a", seconds: 2 * HOUR, hourlyRate: 80 }),
        billable({ id: "b", seconds: HOUR, hourlyRate: 100 }),
      ],
      "project",
    );

    assert.equal(lines.length, 2);
    assert.deepEqual(
      lines.map((line) => line.hourlyRate),
      [80, 100],
    );
    assert.deepEqual(
      lines.map((line) => line.amount),
      [160, 100],
    );
    assert.deepEqual(
      lines.map((line) => line.key),
      ["p1@80", "p1@100"],
    );
    assert.ok(lines[0]?.label.includes("80.00/h"));
    assert.ok(lines[1]?.label.includes("100.00/h"));
  });

  it("leaves a single-rate group's key and label plain", () => {
    const lines = invoiceLineItems([billable({ hourlyRate: 80 })], "project");
    assert.equal(lines[0]?.key, "p1");
    assert.equal(lines[0]?.label, "Website");
  });

  it("splits without losing a second or a cent", () => {
    const entries = [
      billable({ id: "a", seconds: 90 * 60, hourlyRate: 80 }),
      billable({ id: "b", seconds: 30 * 60, hourlyRate: 100 }),
    ];
    const lines = invoiceLineItems(entries, "project");

    const seconds = lines.reduce((total, line) => total + line.seconds, 0);
    assert.equal(seconds, 2 * HOUR);
    assert.equal(invoiceTotals(lines, null).subtotal, 120 + 50);
  });
});

// ── totals ───────────────────────────────────────────────────────────

const line = (amount: number): InvoiceLineItem => ({
  key: `k${amount}`,
  label: `Line ${amount}`,
  projectId: "p1",
  taskId: null,
  seconds: HOUR,
  hours: 1,
  hourlyRate: amount,
  currency: "EUR",
  amount,
});

describe("invoiceTotals", () => {
  it("sums the lines in whole cents", () => {
    // 0.1 + 0.2 is 0.30000000000000004 in float; an invoice may not be.
    const totals = invoiceTotals([line(0.1), line(0.2)], null);
    assert.equal(totals.subtotal, 0.3);
  });

  it("charges no tax when the rate is null", () => {
    const totals = invoiceTotals([line(100)], null);
    assert.equal(totals.taxAmount, 0);
    assert.equal(totals.total, 100);
  });

  it("applies tax to the subtotal and rounds once", () => {
    const totals = invoiceTotals([line(100), line(33.33)], 19);
    assert.equal(totals.subtotal, 133.33);
    assert.equal(totals.taxAmount, 25.33);
    assert.equal(totals.total, 158.66);
  });

  it("treats 0% as a real tax line, not as no tax", () => {
    const totals = invoiceTotals([line(100)], 0);
    assert.equal(totals.taxAmount, 0);
    assert.equal(totals.total, 100);
  });

  it("totals an empty invoice to zero rather than NaN", () => {
    const totals = invoiceTotals([], 19);
    assert.deepEqual(totals, { subtotal: 0, taxAmount: 0, total: 0 });
  });

  it("keeps the total a clean cent value, not a float sum", () => {
    // 0.14 + 0.01 in floats is 0.15000000000000002 — a number no invoice may
    // print. The total is summed in cents, so it comes out exactly 0.15.
    const totals = invoiceTotals([line(0.07), line(0.07)], 7.5);
    assert.equal(totals.subtotal, 0.14);
    assert.equal(totals.taxAmount, 0.01);
    assert.equal(totals.total, 0.15);
  });
});

// ── numbering ────────────────────────────────────────────────────────

describe("invoice numbers", () => {
  it("pads the sequence to three digits", () => {
    assert.equal(formatInvoiceNumber(2026, 1), "2026-001");
    assert.equal(formatInvoiceNumber(2026, 14), "2026-014");
    assert.equal(formatInvoiceNumber(2026, 999), "2026-999");
  });

  it("grows past three digits rather than wrapping", () => {
    assert.equal(formatInvoiceNumber(2026, 1000), "2026-1000");
  });

  it("round-trips through the parser", () => {
    assert.deepEqual(parseInvoiceNumber("2026-014"), {
      year: 2026,
      sequence: 14,
    });
  });

  it("does not recognise a foreign format", () => {
    assert.equal(parseInvoiceNumber("INV-2024-7"), null);
    assert.equal(parseInvoiceNumber("2026-14"), null);
    assert.equal(parseInvoiceNumber(""), null);
  });

  it("starts a year at 001", () => {
    assert.equal(nextInvoiceNumber([], 2026), "2026-001");
  });

  it("continues from the highest sequence of that year", () => {
    assert.equal(
      nextInvoiceNumber(["2026-001", "2026-013", "2026-007"], 2026),
      "2026-014",
    );
  });

  it("restarts the sequence each year", () => {
    assert.equal(nextInvoiceNumber(["2025-140", "2025-141"], 2026), "2026-001");
  });

  it("ignores numbers imported from another system", () => {
    // An "INV-2024-7" carried over from an old tool must not push this year's
    // sequence anywhere.
    assert.equal(nextInvoiceNumber(["INV-2024-7", "2026-002"], 2026), "2026-003");
  });

  it("offers the next candidate after a duplicate-key collision", () => {
    assert.equal(bumpInvoiceNumber("2026-014"), "2026-015");
    assert.equal(bumpInvoiceNumber("2026-999"), "2026-1000");
  });

  it("refuses to renumber a caller-supplied number", () => {
    assert.equal(bumpInvoiceNumber("ACME-7"), null);
  });

  it("builds a bounded retry ladder", () => {
    assert.deepEqual(invoiceNumberCandidates("2026-014", 3), [
      "2026-014",
      "2026-015",
      "2026-016",
    ]);
  });

  it("yields exactly one attempt for a number it cannot bump", () => {
    assert.deepEqual(invoiceNumberCandidates("ACME-7", 5), ["ACME-7"]);
  });
});

// ── issue-year extraction ────────────────────────────────────────────

describe("yearOfIsoDate", () => {
  it("reads the year the string names, for a date-only value", () => {
    assert.equal(yearOfIsoDate("2026-01-15"), 2026);
    assert.equal(yearOfIsoDate("2025-12-31"), 2025);
  });

  it("does NOT shift a 1 January date the way a host-zone Date read would", () => {
    // This is the whole point of the helper. `new Date("2026-01-01")` is UTC
    // midnight; asked for its year in any zone west of UTC it answers 2025,
    // which would number the first invoice of the year into the year that
    // just ended. The string says 2026, so the number says 2026.
    assert.equal(yearOfIsoDate("2026-01-01"), 2026);
  });

  it("takes the year from an offset datetime as written, not as UTC", () => {
    // 00:30 on 1 Jan in Berlin is still 31 Dec in UTC. The writer meant 2026.
    assert.equal(yearOfIsoDate("2026-01-01T00:30:00+01:00"), 2026);
  });

  it("returns null for anything that is not an ISO date, so the caller chooses", () => {
    assert.equal(yearOfIsoDate("not a date"), null);
    assert.equal(yearOfIsoDate(""), null);
    assert.equal(yearOfIsoDate("26-01-01"), null);
  });

  it("sequences a new year from 001 even when last year has high numbers", () => {
    const existing = ["2025-014", "2025-013"];
    assert.equal(
      nextInvoiceNumber(existing, yearOfIsoDate("2026-01-01") ?? 0),
      "2026-001",
    );
  });
});

// ── status transitions ───────────────────────────────────────────────

describe("isValidStatusTransition", () => {
  it("walks draft → sent → paid", () => {
    assert.equal(isValidStatusTransition("draft", "sent"), true);
    assert.equal(isValidStatusTransition("sent", "paid"), true);
  });

  it("walks back one step at a time", () => {
    assert.equal(isValidStatusTransition("paid", "sent"), true);
    assert.equal(isValidStatusTransition("sent", "draft"), true);
  });

  it("refuses to skip the middle in either direction", () => {
    // Money for a document nobody sent means the records disagree with
    // reality; a paid invoice does not become a draft in one step either.
    assert.equal(isValidStatusTransition("draft", "paid"), false);
    assert.equal(isValidStatusTransition("paid", "draft"), false);
  });

  it("accepts a no-op so a retried mutation does not fail", () => {
    assert.equal(isValidStatusTransition("sent", "sent"), true);
  });
});

// ── the document ─────────────────────────────────────────────────────

describe("invoicePdfFilename", () => {
  it("names the file after the invoice", () => {
    assert.equal(invoicePdfFilename("2026-014"), "invoice-2026-014.pdf");
  });

  it("folds anything path-like out of a caller-supplied number", () => {
    assert.equal(invoicePdfFilename("../../etc/passwd"), "invoice-etc-passwd.pdf");
    assert.equal(invoicePdfFilename("  "), "invoice-document.pdf");
  });
});

const invoice = (overrides: Partial<Invoice> = {}): Invoice => ({
  id: "inv1",
  workspaceId: "workspace-1",
  createdBy: "user-1",
  number: "2026-014",
  clientId: "c1",
  clientName: "Acme GmbH",
  status: "draft",
  issueDate: "2026-09-01T00:00:00.000Z",
  dueDate: "2026-09-15T00:00:00.000Z",
  from: "2026-08-01T00:00:00.000Z",
  to: "2026-09-01T00:00:00.000Z",
  groupBy: "project",
  lineItems: [
    {
      key: "p1",
      label: "Website",
      projectId: "p1",
      taskId: null,
      seconds: 3 * HOUR,
      hours: 3,
      hourlyRate: 100,
      currency: "EUR",
      amount: 300,
    },
  ],
  subtotal: 300,
  taxRate: 19,
  taxAmount: 57,
  total: 357,
  currency: "EUR",
  entryIds: ["e1"],
  notes: null,
  createdAt: "2026-09-01T08:00:00.000Z",
  updatedAt: "2026-09-01T08:00:00.000Z",
  ...overrides,
});

/**
 * A PDF is a container format, so "did it render" is checked structurally —
 * header, trailer, and a byte count no empty page could produce. Pixel-level
 * assertions would pin the layout rather than the contract.
 */
const assertPdf = (bytes: Buffer): void => {
  assert.ok(Buffer.isBuffer(bytes));
  assert.equal(bytes.subarray(0, 5).toString("latin1"), "%PDF-");
  assert.ok(bytes.subarray(-1024).toString("latin1").includes("%%EOF"));
  assert.ok(bytes.length > 800);
};

describe("renderInvoicePdf", () => {
  it("renders a document", async () => {
    assertPdf(
      await renderInvoicePdf(invoice(), {
        generatedAt: "2026-09-01T08:00:00.000Z",
      }),
    );
  });

  it("renders an invoice with no lines, no tax and long notes", async () => {
    assertPdf(
      await renderInvoicePdf(
        invoice({
          lineItems: [],
          subtotal: 0,
          taxRate: null,
          taxAmount: 0,
          total: 0,
          notes: "Payment within 14 days. ".repeat(40),
        }),
        { generatedAt: "2026-09-01T08:00:00.000Z" },
      ),
    );
  });

  it("survives a label long enough to overflow its column", async () => {
    assertPdf(
      await renderInvoicePdf(
        invoice({
          lineItems: Array.from({ length: 80 }, (_unused, index) => ({
            key: `p${index}`,
            label: `Project ${index} ${"very long name ".repeat(12)}`,
            projectId: `p${index}`,
            taskId: null,
            seconds: HOUR,
            hours: 1,
            hourlyRate: 100,
            currency: "EUR",
            amount: 100,
          })),
        }),
        { generatedAt: "2026-09-01T08:00:00.000Z" },
      ),
    );
  });

  it("stays a plain PDF 1.3 with the standard font and no attachment", async () => {
    // The ZUGFeRD variant shares this renderer; without a variant nothing of
    // PDF/A may leak into the plain export.
    const bytes = await renderInvoicePdf(invoice(), {
      generatedAt: "2026-09-01T08:00:00.000Z",
    });
    const raw = bytes.toString("latin1");
    assert.equal(raw.slice(0, 8), "%PDF-1.3");
    assert.ok(raw.includes("/BaseFont /Helvetica"));
    assert.ok(!raw.includes("/EmbeddedFiles"));
    assert.ok(!raw.includes("/Metadata"));
  });

  it("prints the last billed day as the end of the period on an invoice with frozen terms", async () => {
    // `to` is midnight of the day AFTER the last billed day (server-local).
    const range = { from: new Date(2026, 7, 1).toISOString(), to: new Date(2026, 8, 1).toISOString() };
    const meta = { generatedAt: "2026-09-01T08:00:00.000Z" };
    const current = await renderInvoicePdf(
      invoice({ ...range, paymentTerms: "Payable by 2026-09-15." }),
      meta,
    );
    assert.ok(pageTexts(current).join("\n").includes("2026-08-01 to 2026-08-31"));
    // Without the BT-20 snapshot the invoice predates e-invoicing and keeps
    // the exclusive bound it was sent with.
    const legacy = await renderInvoicePdf(invoice(range), meta);
    const f = pdfFormat("en");
    assert.ok(pageTexts(legacy).join("\n").includes(`${f.date(range.from)} to ${f.date(range.to)}`));
  });
});
