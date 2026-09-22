import { describe, expect, it } from "vitest";

import {
  buildInvoice,
  computeTotals,
  DRAFT_STORAGE_KEY,
  emptyForm,
  emptyLine,
  isInvoiceForm,
  readDraft,
  removeDraft,
  validateLine,
  validLines,
  writeDraft,
  type DraftStorage,
  type InvoiceForm,
  type LineForm,
} from "./invoice-generator";

const GENERATED_AT = "2026-09-22T10:00:00.000Z";

const stdLine = (over: Partial<LineForm> = {}): LineForm => ({
  ...emptyLine("l1"),
  label: "Design review",
  quantity: "2",
  unit: "hour",
  unitPrice: "50",
  taxCategory: "S",
  vatRate: "19",
  ...over,
});

const formWith = (lines: LineForm[], over: Partial<InvoiceForm> = {}): InvoiceForm => ({
  ...emptyForm(),
  issuer: { ...emptyForm().issuer, legalName: "Acme GmbH" },
  recipient: { ...emptyForm().recipient, name: "Client Co" },
  number: "INV-1",
  lines,
  ...over,
});

describe("validateLine", () => {
  it("accepts a complete standard-rate line and prices it", () => {
    const line = validateLine(stdLine());
    expect(line).not.toBeNull();
    expect(line).toMatchObject({
      label: "Design review",
      quantity: 2,
      unit: "hour",
      unitPrice: 50,
      amount: 100,
      taxCategory: "S",
      taxRate: 19,
    });
    expect(line?.key.startsWith("manual:")).toBe(true);
  });

  it("rejects a line with no label", () => {
    expect(validateLine(stdLine({ label: "   " }))).toBeNull();
  });

  it("rejects a line with no unit price", () => {
    expect(validateLine(stdLine({ unitPrice: "" }))).toBeNull();
  });

  it("rejects a non-positive quantity", () => {
    expect(validateLine(stdLine({ quantity: "0" }))).toBeNull();
    expect(validateLine(stdLine({ quantity: "-1" }))).toBeNull();
  });

  it("rejects a standard-rate line at 0 %", () => {
    expect(validateLine(stdLine({ vatRate: "0" }))).toBeNull();
  });

  it("forces a non-standard category to 0 %, whatever the rate field says", () => {
    const line = validateLine(stdLine({ taxCategory: "E", vatRate: "19" }));
    expect(line?.taxCategory).toBe("E");
    expect(line?.taxRate).toBe(0);
  });

  it("keeps only the complete lines in order", () => {
    const form = formWith([stdLine({ id: "a" }), emptyLine("b"), stdLine({ id: "c", label: "Build" })]);
    const lines = validLines(form);
    expect(lines.map((l) => l.label)).toEqual(["Design review", "Build"]);
  });
});

describe("buildInvoice", () => {
  it("maps the complete lines and computes the totals", () => {
    const form = formWith([stdLine(), emptyLine("blank")]);
    const invoice = buildInvoice(form, "en", GENERATED_AT);

    expect(invoice.lineItems).toHaveLength(1);
    expect(invoice.lineItems[0]).toMatchObject({
      label: "Design review",
      amount: 100,
      quantity: 2,
      unit: "hour",
      unitPrice: 50,
      taxCategory: "S",
      taxRate: 19,
    });
    expect(invoice.subtotal).toBe(100);
    expect(invoice.taxAmount).toBe(19);
    expect(invoice.total).toBe(119);
    expect(invoice.currency).toBe("EUR");
    expect(invoice.locale).toBe("en");
    expect(invoice.number).toBe("INV-1");
    expect(invoice.issuer?.legalName).toBe("Acme GmbH");
    expect(invoice.clientName).toBe("Client Co");
  });

  it("matches computeTotals for the same lines", () => {
    const form = formWith([stdLine(), stdLine({ id: "l2", label: "Build", quantity: "1", unitPrice: "200" })]);
    const totals = computeTotals(validLines(form), "en");
    const invoice = buildInvoice(form, "en", GENERATED_AT);
    expect(invoice.subtotal).toBe(totals.subtotal);
    expect(invoice.taxAmount).toBe(totals.taxAmount);
    expect(invoice.total).toBe(totals.total);
    // 100 + 200 = 300 net, 19 % → 57 tax, 357 total.
    expect(invoice.total).toBe(357);
  });

  it("falls back to a DRAFT number when the field is blank", () => {
    const invoice = buildInvoice(formWith([stdLine()], { number: "  " }), "en", GENERATED_AT);
    expect(invoice.number).toBe("DRAFT");
  });

  it("carries the uploaded logo bytes onto the issuer", () => {
    const form = formWith([stdLine()], { logo: { dataUrl: "data:image/png;base64,AAAA", bytes: [1, 2, 3] } });
    const invoice = buildInvoice(form, "en", GENERATED_AT);
    expect(invoice.issuer?.logo?.data).toBeInstanceOf(Uint8Array);
    expect(Array.from(invoice.issuer?.logo?.data ?? [])).toEqual([1, 2, 3]);
  });
});

/** A Map-backed Storage for the round trip. */
function memStorage(): DraftStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

/** A Storage whose every method throws, like a private window's. */
const throwingStorage: DraftStorage = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
  removeItem: () => {
    throw new Error("blocked");
  },
};

describe("draft persistence", () => {
  it("round-trips a form through storage", () => {
    const storage = memStorage();
    const form = formWith([stdLine()], { notes: "Thanks" });
    writeDraft(storage, form);
    expect(storage.map.has(DRAFT_STORAGE_KEY)).toBe(true);
    expect(readDraft(storage)).toEqual(form);
  });

  it("returns null with no draft and forgets a saved one", () => {
    const storage = memStorage();
    expect(readDraft(storage)).toBeNull();
    writeDraft(storage, formWith([stdLine()]));
    removeDraft(storage);
    expect(readDraft(storage)).toBeNull();
  });

  it("returns null for a value that is not a form", () => {
    const storage = memStorage();
    storage.map.set(DRAFT_STORAGE_KEY, "not json{");
    expect(readDraft(storage)).toBeNull();
    storage.map.set(DRAFT_STORAGE_KEY, JSON.stringify({ nope: true }));
    expect(readDraft(storage)).toBeNull();
  });

  it("never throws when storage does", () => {
    expect(() => writeDraft(throwingStorage, formWith([stdLine()]))).not.toThrow();
    expect(() => removeDraft(throwingStorage)).not.toThrow();
    expect(readDraft(throwingStorage)).toBeNull();
  });

  it("guards the form shape", () => {
    expect(isInvoiceForm(emptyForm())).toBe(true);
    expect(isInvoiceForm(null)).toBe(false);
    expect(isInvoiceForm({ issuer: {}, recipient: {} })).toBe(false);
  });
});
