// Manual lines and draft edits, without a database: the pure rules in
// services/invoice-lines.ts, the shared arithmetic they rest on, and what a
// manual or blank invoice looks like on the page and in the XML — while an
// invoice of time lines alone renders exactly as it did.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Invoice, InvoiceLineItem, UpdateInvoiceInput } from "@starter/shared";
import { manualLineAmount, lineKind, lineQuantity, lineUnit, lineUnitPrice } from "@starter/shared/invoice-lines";
import { toClientInvoice, type InvoiceDocLike } from "../models/Invoice.js";
import { buildCiiXml } from "../services/einvoice/cii.js";
import { assertEinvoiceReady } from "../services/einvoice/validate.js";
import {
  InvoiceLinesError,
  manualLineItems,
  mergeDraftLines,
} from "../services/invoice-lines.js";
import { renderInvoicePdf } from "../services/invoice-pdf.js";
import { einvoiceCase, legacyInvoiceFixture } from "./fixtures/einvoice/cases.js";
import { pageTexts } from "./support/pdf-text.js";

const timeLine = (overrides: Partial<InvoiceLineItem> = {}): InvoiceLineItem => ({
  key: "p1",
  label: "Website",
  projectId: "p1",
  taskId: null,
  seconds: 3 * 3600,
  hours: 3,
  hourlyRate: 100,
  currency: "EUR",
  amount: 300,
  ...overrides,
});

const keys = (() => {
  let n = 0;
  return () => `manual:k${++n}`;
})();

describe("manualLineAmount", () => {
  it("rounds once, half away from zero, in integer arithmetic", () => {
    assert.equal(manualLineAmount(3, 49.99), 149.97);
    assert.equal(manualLineAmount(1.5, 900), 1350);
    // 0.125 × 100 = 12.5 → 12.50 exactly; 1.005 × 100 would be 100.49999… as a float.
    assert.equal(manualLineAmount(0.125, 100), 12.5);
    assert.equal(manualLineAmount(1.005, 100), 100.5);
    assert.equal(manualLineAmount(0.001, 0.01), 0);
    assert.equal(manualLineAmount(2, 0), 0);
  });
});

describe("the line readers", () => {
  it("read a legacy row as a time line in hours at its hourly rate", () => {
    const line = timeLine();
    assert.equal(lineKind(line), "time");
    assert.equal(lineQuantity(line), 3);
    assert.equal(lineUnit(line), "hour");
    assert.equal(lineUnitPrice(line), 100);
  });

  it("read a manual row's own quantity, unit and price", () => {
    const [line] = manualLineItems(
      [{ label: "Workshop", quantity: 2, unit: "day", unitPrice: 800 }],
      "EUR",
      new Set(),
      keys,
    ).lines;
    assert.ok(line);
    assert.equal(lineKind(line), "manual");
    assert.equal(lineQuantity(line), 2);
    assert.equal(lineUnit(line), "day");
    assert.equal(lineUnitPrice(line), 800);
  });
});

describe("manualLineItems", () => {
  it("prices each line, zeroes its time fields and mirrors the price as the rate", () => {
    const built = manualLineItems(
      [
        { label: "Workshop", quantity: 2, unit: "day", unitPrice: 800 },
        { label: "Licence", quantity: 3, unit: "piece", unitPrice: 49.99, tax: { category: "S", rate: 7 } },
      ],
      "CHF",
      new Set(),
      keys,
    );
    assert.deepEqual(
      built.lines.map((line) => [line.kind, line.seconds, line.hours, line.hourlyRate, line.amount, line.currency]),
      [
        ["manual", 0, 0, 800, 1600, "CHF"],
        ["manual", 0, 0, 49.99, 149.97, "CHF"],
      ],
    );
    assert.ok(built.lines.every((line) => line.projectId === null && line.taskId === null));
    // Only the line that carried its own VAT is in the per-line list.
    assert.deepEqual(built.lineTax, [{ key: built.lines[1]?.key, category: "S", rate: 7 }]);
  });

  it("keeps a client-chosen key and assigns one otherwise", () => {
    const built = manualLineItems(
      [
        { key: "manual:abc", label: "A", quantity: 1, unit: "piece", unitPrice: 1 },
        { label: "B", quantity: 1, unit: "piece", unitPrice: 1 },
      ],
      "EUR",
      new Set(),
      () => "manual:fresh",
    );
    assert.deepEqual(built.lines.map((line) => line.key), ["manual:abc", "manual:fresh"]);
  });

  it("refuses a key the invoice already uses", () => {
    assert.throws(
      () =>
        manualLineItems(
          [{ key: "manual:abc", label: "A", quantity: 1, unit: "piece", unitPrice: 1 }],
          "EUR",
          new Set(["manual:abc"]),
        ),
      InvoiceLinesError,
    );
  });

  it("never assigns a key that is taken", () => {
    let calls = 0;
    const built = manualLineItems(
      [{ label: "A", quantity: 1, unit: "piece", unitPrice: 1 }],
      "EUR",
      new Set(["manual:one"]),
      () => (++calls === 1 ? "manual:one" : "manual:two"),
    );
    assert.equal(built.lines[0]?.key, "manual:two");
  });
});

describe("mergeDraftLines", () => {
  const stored: InvoiceLineItem[] = [
    timeLine({ key: "p1", label: "Website" }),
    timeLine({ key: "p2", label: "App", amount: 300 }),
    ...manualLineItems([{ key: "manual:old", label: "Old fee", quantity: 1, unit: "piece", unitPrice: 50 }], "EUR").lines,
  ];

  it("keeps the stored lines untouched when the edit sends none", () => {
    const built = mergeDraftLines(stored, undefined, "EUR");
    assert.deepEqual(built.lines, stored);
    assert.notEqual(built.lines, stored);
    assert.deepEqual(built.lineTax, []);
  });

  it("relabels a time line and changes nothing else on it", () => {
    const built = mergeDraftLines(
      stored,
      [
        { kind: "time", key: "p2", label: "Mobile app" },
        { kind: "time", key: "p1" },
      ],
      "EUR",
    );
    assert.deepEqual(built.lines, [{ ...stored[1], label: "Mobile app" }, stored[0]]);
  });

  it("adds, edits and removes manual lines in the order given", () => {
    const edits: UpdateInvoiceInput["lines"] = [
      { kind: "manual", label: "New fee", quantity: 2, unit: "day", unitPrice: 600 },
      { kind: "time", key: "p1" },
      { kind: "manual", key: "manual:old", label: "Old fee, raised", quantity: 1, unit: "piece", unitPrice: 75 },
      { kind: "time", key: "p2" },
    ];
    const built = mergeDraftLines(stored, edits, "EUR", () => "manual:new");
    assert.deepEqual(
      built.lines.map((line) => [line.key, line.label, line.amount]),
      [
        ["manual:new", "New fee", 1200],
        ["p1", "Website", 300],
        ["manual:old", "Old fee, raised", 75],
        ["p2", "App", 300],
      ],
    );
  });

  it("drops a stored manual line the edit leaves out", () => {
    const built = mergeDraftLines(
      stored,
      [
        { kind: "time", key: "p1" },
        { kind: "time", key: "p2" },
      ],
      "EUR",
    );
    assert.deepEqual(built.lines.map((line) => line.key), ["p1", "p2"]);
  });

  it("refuses to drop a time line: its entries would stay claimed", () => {
    assert.throws(
      () => mergeDraftLines(stored, [{ kind: "time", key: "p1" }], "EUR"),
      (error: unknown) => error instanceof InvoiceLinesError && /p2/.test(error.message),
    );
  });

  it("refuses a time line the invoice does not have, and one listed twice", () => {
    assert.throws(
      () =>
        mergeDraftLines(stored, [
          { kind: "time", key: "p1" },
          { kind: "time", key: "p2" },
          { kind: "time", key: "p3" },
        ], "EUR"),
      InvoiceLinesError,
    );
    assert.throws(
      () =>
        mergeDraftLines(stored, [
          { kind: "time", key: "p1" },
          { kind: "time", key: "p2" },
          { kind: "time", key: "p2" },
        ], "EUR"),
      InvoiceLinesError,
    );
  });

  it("refuses a manual line under a time line's key", () => {
    assert.throws(
      () =>
        mergeDraftLines(stored, [
          { kind: "time", key: "p1" },
          { kind: "time", key: "p2" },
          { kind: "manual", key: "p1" as `manual:${string}`, label: "X", quantity: 1, unit: "piece", unitPrice: 1 },
        ], "EUR"),
      InvoiceLinesError,
    );
  });

  it("collects each line's own VAT by key", () => {
    const built = mergeDraftLines(
      stored,
      [
        { kind: "time", key: "p1", tax: { category: "S", rate: 7 } },
        { kind: "time", key: "p2" },
        { kind: "manual", key: "manual:old", label: "Old fee", quantity: 1, unit: "piece", unitPrice: 50, tax: { category: "AE", rate: 0 } },
      ],
      "EUR",
    );
    assert.deepEqual(built.lineTax, [
      { key: "p1", category: "S", rate: 7 },
      { key: "manual:old", category: "AE", rate: 0 },
    ]);
  });
});

// ── the page ─────────────────────────────────────────────────────────

const GENERATED_AT = "2026-10-01T08:00:00.000Z";

const text = async (invoice: Invoice): Promise<string> =>
  pageTexts(await renderInvoicePdf(invoice, { generatedAt: GENERATED_AT })).join("");

describe("the PDF with manual lines", () => {
  it("names every quantity's unit and heads the columns Quantity and Price", async () => {
    const page = await text(einvoiceCase("manual-lines").invoice());
    assert.ok(page.includes("DescriptionQuantityPriceAmount"), page);
    assert.ok(page.includes("Website relaunch – development12.50 h95.001,187.50"), page);
    assert.ok(page.includes("Workshop2.00 days800.001,600.00"), page);
    assert.ok(page.includes("Licence1.00 pc250.00250.00"), page);
    assert.ok(page.includes("Period2026-09-01 to 2026-09-30"), page);
  });

  it("prints a blank invoice with no Period row", async () => {
    const page = await text(einvoiceCase("blank").invoice());
    assert.ok(!page.includes("Period"), page);
    assert.ok(page.includes("Due date2026-10-15Grouped byProject"), page);
    assert.ok(page.includes("Consulting day1.50 days900.001,350.00"), page);
    assert.ok(page.includes("Support ticket3.00 pcs49.99149.97"), page);
  });

  it("says the units in German", async () => {
    const page = await text({ ...einvoiceCase("manual-lines").invoice(), locale: "de" });
    assert.ok(page.includes("BeschreibungMengePreisBetrag"), page);
    assert.ok(page.includes("Workshop2,00 Tage800,001.600,00"), page);
    assert.ok(page.includes("Licence1,00 Stk.250,00250,00"), page);
    assert.ok(page.includes("12,50 h"), page);
  });

  it("keeps an invoice of time lines alone as it was: Hours, Rate, no units", async () => {
    const page = await text(legacyInvoiceFixture());
    assert.ok(page.includes("DescriptionHoursRateAmount"), page);
    assert.ok(page.includes("Website relaunch – development12.5095.001,187.50"), page);
    assert.ok(!page.includes(" h95.00"), page);
  });

  it("renders a stored blank row read back through the model", async () => {
    const doc: InvoiceDocLike = {
      _id: "64b7f9c2e13a4d5f6a7b8c9e",
      workspaceId: "ws",
      createdBy: "u",
      number: "2026-020",
      clientId: "c1",
      clientName: "Acme GmbH",
      status: "draft",
      issueDate: new Date("2026-09-01T00:00:00.000Z"),
      dueDate: new Date("2026-09-15T00:00:00.000Z"),
      from: null,
      to: null,
      groupBy: "project",
      lineItems: manualLineItems([{ label: "Retainer", quantity: 1, unit: "piece", unitPrice: 2000 }], "EUR").lines,
      subtotal: 2000,
      taxRate: null,
      taxAmount: 0,
      total: 2000,
      currency: "EUR",
      entryIds: [],
      notes: null,
      createdAt: new Date("2026-09-01T08:00:00.000Z"),
      updatedAt: new Date("2026-09-01T08:00:00.000Z"),
    };
    const wire = toClientInvoice(doc);
    assert.equal(wire.from, null);
    assert.equal(wire.to, null);
    assert.equal(wire.lineItems[0]?.kind, "manual");
    assert.equal(wire.lineItems[0]?.unit, "piece");
    const page = await text(wire);
    assert.ok(page.includes("Retainer1.00 pc2,000.002,000.00"), page);
    assert.ok(!page.includes("Period"), page);
  });
});

// ── the XML ──────────────────────────────────────────────────────────

describe("the CII with manual lines", () => {
  it("writes each line's unit code and its stored quantity", () => {
    const xml = buildCiiXml(assertEinvoiceReady(einvoiceCase("manual-lines").invoice(), "en16931"), "en16931");
    const quantities = [...xml.matchAll(/<ram:BilledQuantity unitCode="([A-Z0-9]+)">([^<]+)</g)].map((m) => [m[1], m[2]]);
    assert.deepEqual(quantities, [
      ["HUR", "12.5"],
      ["DAY", "2.00"],
      ["C62", "1.00"],
    ]);
    assert.ok(xml.includes("<ram:BillingSpecifiedPeriod>"));
  });

  it("writes a blank invoice without a period and delivered on its issue date", () => {
    const xml = buildCiiXml(assertEinvoiceReady(einvoiceCase("blank").invoice(), "xrechnung"), "xrechnung");
    assert.ok(!xml.includes("BillingSpecifiedPeriod"));
    assert.match(
      xml,
      /<ram:ActualDeliverySupplyChainEvent>\s*<ram:OccurrenceDateTime>\s*<udt:DateTimeString format="102">20261001</,
    );
  });

  it("refuses a manual line whose amount is not quantity times price", () => {
    const invoice = einvoiceCase("blank").invoice();
    const [first] = invoice.lineItems;
    assert.ok(first);
    first.amount = 1349;
    invoice.subtotal = 1349 + 149.97;
    assert.throws(() => assertEinvoiceReady(invoice, "en16931"), /LINE_AMOUNT_INCONSISTENT|quantity/);
  });
});
