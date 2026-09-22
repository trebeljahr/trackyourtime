import { describe, expect, it } from "vitest";
import type { Invoice, InvoiceLineItem } from "@starter/shared";

import {
  buildUpdateInput,
  checkManualLine,
  decimalInput,
  editorSubtotal,
  invalidManualLines,
  lineAmount,
  linesChanged,
  linesFromInvoice,
  manualLinesInput,
  newManualLineDraft,
  parseDecimalInput,
  type EditableLine,
  type ManualLineDraft,
} from "./line-editor";

const timeLine = (overrides: Partial<InvoiceLineItem> = {}): InvoiceLineItem => ({
  key: "p1",
  label: "Website",
  projectId: "p1",
  taskId: null,
  seconds: 5400,
  hours: 1.5,
  hourlyRate: 120,
  currency: "EUR",
  amount: 180,
  taxCategory: "S",
  taxRate: 19,
  ...overrides,
});

const manualLine = (overrides: Partial<InvoiceLineItem> = {}): InvoiceLineItem => ({
  key: "manual:travel",
  label: "Travel",
  projectId: null,
  taskId: null,
  kind: "manual",
  seconds: 0,
  hours: 0,
  hourlyRate: 60,
  currency: "EUR",
  amount: 120,
  quantity: 2,
  unit: "piece",
  unitPrice: 60,
  taxCategory: "S",
  taxRate: 19,
  ...overrides,
});

const invoice = (overrides: Partial<Invoice> = {}): Invoice => ({
  id: "inv1",
  workspaceId: "ws",
  createdBy: "u",
  number: "2026-014",
  clientId: "c1",
  clientName: "Acme",
  status: "draft",
  issueDate: "2026-09-01T00:00:00.000Z",
  dueDate: "2026-09-15T00:00:00.000Z",
  from: "2026-08-01T00:00:00.000Z",
  to: "2026-09-01T00:00:00.000Z",
  groupBy: "project",
  lineItems: [timeLine(), manualLine()],
  subtotal: 300,
  taxRate: 19,
  taxAmount: 57,
  total: 357,
  currency: "EUR",
  entryIds: ["e1"],
  notes: null,
  locale: "en",
  createdAt: "2026-09-01T08:00:00.000Z",
  updatedAt: "2026-09-01T08:00:00.000Z",
  ...overrides,
});

const draft = (overrides: Partial<ManualLineDraft> = {}): ManualLineDraft => ({
  kind: "manual",
  key: "manual:abc",
  label: "Fee",
  quantity: "1",
  unit: "piece",
  unitPrice: "100",
  ...overrides,
});

/** The edits of an untouched form: the invoice's own values back. */
const unchanged = (inv: Invoice, lines: EditableLine[] = linesFromInvoice(inv)) => ({
  number: inv.number,
  issueDate: "2026-09-01",
  dueDate: "2026-09-15",
  notes: inv.notes ?? "",
  locale: null,
  lines,
  tax: null,
});

describe("parseDecimalInput", () => {
  it("reads a dot, a comma and blanks", () => {
    expect(parseDecimalInput("7.5")).toBe(7.5);
    expect(parseDecimalInput("7,5")).toBe(7.5);
    expect(parseDecimalInput(" 2 ")).toBe(2);
    expect(parseDecimalInput(".5")).toBe(0.5);
    expect(parseDecimalInput("")).toBeNull();
    expect(parseDecimalInput("abc")).toBeNull();
    expect(parseDecimalInput("1.2.3")).toBeNull();
  });

  it("round-trips a stored figure through decimalInput", () => {
    expect(decimalInput(49.99)).toBe("49.99");
    expect(decimalInput(2)).toBe("2");
    expect(decimalInput(0.125)).toBe("0.125");
    expect(parseDecimalInput(decimalInput(1.5))).toBe(1.5);
  });
});

describe("the editor's arithmetic", () => {
  it("prices a manual line with the server's rounding, or shows nothing while unparseable", () => {
    expect(lineAmount(draft({ quantity: "3", unitPrice: "49.99" }))).toBe(149.97);
    expect(lineAmount(draft({ quantity: "1,5", unitPrice: "900" }))).toBe(1350);
    expect(lineAmount(draft({ quantity: "1,005", unitPrice: "100" }))).toBe(100.5);
    expect(lineAmount(draft({ quantity: "", unitPrice: "100" }))).toBeNull();
    expect(lineAmount(draft({ quantity: "2", unitPrice: "x" }))).toBeNull();
  });

  it("reads a time line's stored amount and sums every line in cents", () => {
    const lines = linesFromInvoice(invoice());
    expect(lineAmount(lines[0]!)).toBe(180);
    expect(editorSubtotal([...lines, draft({ quantity: "3", unitPrice: "0.1" })])).toBe(300.3);
    expect(editorSubtotal([draft({ quantity: "", unitPrice: "1" })])).toBe(0);
  });

  it("checks a manual line with the shared rules", () => {
    expect(checkManualLine(draft())).toEqual({
      ok: true,
      input: { key: "manual:abc", label: "Fee", quantity: 1, unit: "piece", unitPrice: 100 },
    });
    expect(checkManualLine(draft({ label: "  " }))).toEqual({ ok: false, errors: ["label"] });
    expect(checkManualLine(draft({ quantity: "0" }))).toEqual({ ok: false, errors: ["quantity"] });
    expect(checkManualLine(draft({ quantity: "1.2345" }))).toEqual({ ok: false, errors: ["quantity"] });
    expect(checkManualLine(draft({ unitPrice: "-1" }))).toEqual({ ok: false, errors: ["unitPrice"] });
    expect(checkManualLine(draft({ unitPrice: "1.005" }))).toEqual({ ok: false, errors: ["unitPrice"] });
    expect(checkManualLine(draft({ unitPrice: "0" })).ok).toBe(true);
    expect(checkManualLine(draft({ label: "", quantity: "", unitPrice: "" }))).toEqual({
      ok: false,
      errors: ["label", "quantity", "unitPrice"],
    });
  });

  it("lists the invalid manual lines and sends only the complete ones", () => {
    const lines: EditableLine[] = [
      ...linesFromInvoice(invoice()),
      draft({ key: "manual:new", label: "", quantity: "1", unitPrice: "5" }),
    ];
    expect([...invalidManualLines(lines).keys()]).toEqual(["manual:new"]);
    expect(manualLinesInput(lines)).toEqual([
      { key: "manual:travel", label: "Travel", quantity: 2, unit: "piece", unitPrice: 60 },
    ]);
  });

  it("starts a fresh line at one hour with a manual key", () => {
    const line = newManualLineDraft(() => 0);
    expect(line.key).toMatch(/^manual:[a-z0-9]{12}$/);
    expect(line.quantity).toBe("1");
    expect(line.unit).toBe("hour");
    expect(line.unitPrice).toBe("");
  });
});

describe("linesFromInvoice and linesChanged", () => {
  it("turns stored lines into editable ones, time lines keeping their original", () => {
    const [time, manual] = linesFromInvoice(invoice());
    expect(time).toEqual({ kind: "time", key: "p1", label: "Website", original: timeLine() });
    expect(manual).toEqual({
      kind: "manual",
      key: "manual:travel",
      label: "Travel",
      quantity: "2",
      unit: "piece",
      unitPrice: "60",
    });
  });

  it("reads a legacy row as a time line", () => {
    const [line] = linesFromInvoice(invoice({ lineItems: [timeLine({ taxCategory: undefined, taxRate: undefined })] }));
    expect(line?.kind).toBe("time");
  });

  it("sees a relabel, a reorder, a changed figure and a removed line, not a retyped equal number", () => {
    const inv = invoice();
    const same = linesFromInvoice(inv);
    expect(linesChanged(inv, same)).toBe(false);
    expect(linesChanged(inv, [same[1]!, same[0]!])).toBe(true);
    expect(linesChanged(inv, [{ ...same[0]!, label: "Site" } as EditableLine, same[1]!])).toBe(true);
    expect(linesChanged(inv, [same[0]!, { ...(same[1] as ManualLineDraft), unitPrice: "60,00" }])).toBe(false);
    expect(linesChanged(inv, [same[0]!, { ...(same[1] as ManualLineDraft), unitPrice: "61" }])).toBe(true);
    expect(linesChanged(inv, [same[0]!])).toBe(true);
  });
});

describe("buildUpdateInput", () => {
  it("sends nothing but the id and updatedAt for an untouched form", () => {
    const inv = invoice();
    const built = buildUpdateInput(inv, unchanged(inv));
    expect(built).toEqual({
      ok: true,
      changed: false,
      input: { id: "inv1", updatedAt: "2026-09-01T08:00:00.000Z" },
    });
  });

  it("sends only what differs", () => {
    const inv = invoice();
    const built = buildUpdateInput(inv, {
      ...unchanged(inv),
      number: " 2026-015 ",
      dueDate: "2026-09-30",
      notes: "Thanks",
      locale: "de",
    });
    expect(built).toEqual({
      ok: true,
      changed: true,
      input: {
        id: "inv1",
        updatedAt: "2026-09-01T08:00:00.000Z",
        number: "2026-015",
        dueDate: "2026-09-30",
        notes: "Thanks",
        locale: "de",
      },
    });
  });

  it("clears notes with null and keeps the invoice's own language out", () => {
    const inv = invoice({ notes: "Old" });
    const built = buildUpdateInput(inv, { ...unchanged(inv), notes: "  ", locale: "en" });
    expect(built.ok && built.input.notes).toBeNull();
    expect(built.ok && "locale" in built.input).toBe(false);
  });

  it("sends the whole line list when a line changed: time lines by key, relabelled ones with a label, manual lines in full", () => {
    const inv = invoice();
    const lines = linesFromInvoice(inv);
    const edited: EditableLine[] = [
      draft({ key: "manual:new", label: "Setup", quantity: "0.5", unit: "day", unitPrice: "1000" }),
      { ...lines[0]!, label: " Site relaunch " } as EditableLine,
      { ...(lines[1] as ManualLineDraft), unitPrice: "65" },
    ];
    const built = buildUpdateInput(inv, { ...unchanged(inv, edited) });
    expect(built.ok && built.input.lines).toEqual([
      { kind: "manual", key: "manual:new", label: "Setup", quantity: 0.5, unit: "day", unitPrice: 1000 },
      { kind: "time", key: "p1", label: "Site relaunch" },
      { kind: "manual", key: "manual:travel", label: "Travel", quantity: 2, unit: "piece", unitPrice: 65 },
    ]);
    // An unchanged time line travels as its key alone.
    const reordered = buildUpdateInput(inv, unchanged(inv, [lines[1]!, lines[0]!]));
    expect(reordered.ok && reordered.input.lines).toEqual([
      { kind: "manual", key: "manual:travel", label: "Travel", quantity: 2, unit: "piece", unitPrice: 60 },
      { kind: "time", key: "p1" },
    ]);
  });

  it("carries the VAT inputs when given", () => {
    const inv = invoice();
    const built = buildUpdateInput(inv, {
      ...unchanged(inv),
      tax: {
        tax: { category: "S", rate: 7 },
        lineTax: [{ key: "manual:travel", category: "AE", rate: 0 }],
        exemptionNotes: { AE: "Reverse charge." },
        taxRate: 7,
      },
    });
    expect(built.ok && built.input).toEqual({
      id: "inv1",
      updatedAt: "2026-09-01T08:00:00.000Z",
      taxRate: 7,
      tax: { category: "S", rate: 7 },
      lineTax: [{ key: "manual:travel", category: "AE", rate: 0 }],
      exemptionNotes: { AE: "Reverse charge." },
    });
  });

  it("refuses an empty number, a due date before the issue date and an incomplete line", () => {
    const inv = invoice();
    expect(buildUpdateInput(inv, { ...unchanged(inv), number: " " })).toEqual({ ok: false, reason: "number" });
    expect(buildUpdateInput(inv, { ...unchanged(inv), dueDate: "2026-08-31" })).toEqual({ ok: false, reason: "dates" });
    expect(
      buildUpdateInput(inv, unchanged(inv, [...linesFromInvoice(inv), draft({ key: "manual:x", unitPrice: "" })])),
    ).toEqual({ ok: false, reason: "invalid-lines" });
  });
});
