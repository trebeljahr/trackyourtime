// VAT categories at create: chosen from the request, then the client's and the
// profile's defaults — and never guessed when nothing names one.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_EXEMPTION_NOTES,
  normalizeBusinessProfile,
  normalizeClientBilling,
  type BusinessProfileFields,
  type ClientBillingFields,
  type InvoiceLineItem,
} from "@starter/shared";
import {
  applyInvoiceTax,
  invoiceTotals,
  resolveInvoiceTax,
  type InvoiceTaxDefaults,
} from "../services/einvoice/resolve-tax.js";

const KEYS = ["project:a", "project:b"];

const defaults = (
  profile: BusinessProfileFields = {},
  client: ClientBillingFields | null = null,
  locale: "en" | "de" = "en",
): InvoiceTaxDefaults => ({
  profile: normalizeBusinessProfile({ legalName: "Example GmbH", ...profile }),
  client: client ? normalizeClientBilling(client) : null,
  locale,
});

const line = (key: string, amount: number, seconds = 3600, hourlyRate = amount): InvoiceLineItem => ({
  key,
  label: key,
  projectId: null,
  taskId: null,
  seconds,
  hours: seconds / 3600,
  hourlyRate,
  currency: "EUR",
  amount,
});

describe("resolveInvoiceTax", () => {
  it("uses tax for every line, and lineTax per key over it", () => {
    const resolved = resolveInvoiceTax(
      KEYS,
      { tax: { category: "S", rate: 19 }, lineTax: [{ key: "project:b", category: "S", rate: 7 }] },
      defaults(),
    );
    assert.deepEqual(resolved, {
      kind: "resolved",
      lines: [
        { key: "project:a", category: "S", rate: 19 },
        { key: "project:b", category: "S", rate: 7 },
      ],
      notes: {},
    });
  });

  it("refuses override keys that match no line", () => {
    assert.deepEqual(
      resolveInvoiceTax(KEYS, { lineTax: [{ key: "project:z", category: "E", rate: 0 }, { key: "project:z", category: "E", rate: 0 }] }, defaults()),
      { kind: "unknownKeys", keys: ["project:z"] },
    );
  });

  it("reads an old client's positive taxRate as standard rated", () => {
    const resolved = resolveInvoiceTax(KEYS, { taxRate: 19 }, defaults());
    assert.equal(resolved.kind, "resolved");
    assert.deepEqual(resolved.kind === "resolved" ? resolved.lines.map((l) => l.category + l.rate) : [], ["S19", "S19"]);
  });

  it("falls back to the client's default category", () => {
    const resolved = resolveInvoiceTax(KEYS, { taxRate: 0 }, defaults({}, { city: "Wien", defaultTaxCategory: "AE" }, "de"));
    assert.equal(resolved.kind, "resolved");
    if (resolved.kind !== "resolved") return;
    assert.deepEqual(resolved.lines[0], { key: "project:a", category: "AE", rate: 0 });
    assert.equal(resolved.notes.AE, DEFAULT_EXEMPTION_NOTES.de.AE);
  });

  it("uses a client's S default only with a profile rate above 0", () => {
    const client = { city: "Berlin", defaultTaxCategory: "S" as const };
    assert.equal(resolveInvoiceTax(KEYS, {}, defaults({}, client)).kind, "unresolved");
    const resolved = resolveInvoiceTax(KEYS, {}, defaults({ defaultTaxCategory: "S", defaultTaxRate: 19 }, client));
    assert.equal(resolved.kind === "resolved" ? resolved.lines[0]?.rate : null, 19);
  });

  it("takes E for a small business, with the profile's own note or the default one", () => {
    const own = resolveInvoiceTax(KEYS, {}, defaults({ smallBusiness: true, smallBusinessNote: "Kleinunternehmer nach § 19" }));
    assert.equal(own.kind === "resolved" ? own.notes.E : null, "Kleinunternehmer nach § 19");
    const fallback = resolveInvoiceTax(KEYS, {}, defaults({ smallBusiness: true }, null, "de"));
    assert.equal(fallback.kind === "resolved" ? fallback.lines[0]?.category : null, "E");
    assert.equal(fallback.kind === "resolved" ? fallback.notes.E : null, DEFAULT_EXEMPTION_NOTES.de.E);
  });

  it("prefers the client's default over the small-business rule, as the order says", () => {
    const resolved = resolveInvoiceTax(KEYS, {}, defaults({ smallBusiness: true }, { city: "Paris", defaultTaxCategory: "O" }));
    assert.equal(resolved.kind === "resolved" ? resolved.lines[0]?.category : null, "O");
  });

  it("falls back to the profile's default category and rate", () => {
    const resolved = resolveInvoiceTax(KEYS, {}, defaults({ defaultTaxCategory: "S", defaultTaxRate: 7 }));
    assert.equal(resolved.kind === "resolved" ? resolved.lines[1]?.rate : null, 7);
    assert.equal(resolveInvoiceTax(KEYS, {}, defaults({ defaultTaxCategory: "S", defaultTaxRate: null })).kind, "unresolved");
  });

  it("leaves the WHOLE invoice unresolved when one line has nothing", () => {
    assert.deepEqual(
      resolveInvoiceTax(KEYS, { taxRate: null, lineTax: [{ key: "project:a", category: "S", rate: 19 }] }, defaults()),
      { kind: "unresolved" },
    );
    assert.deepEqual(resolveInvoiceTax(KEYS, { taxRate: 0 }, defaults()), { kind: "unresolved" });
  });

  it("uses a typed note, and gives a non-small-business E line no note", () => {
    const typed = resolveInvoiceTax(KEYS, { tax: { category: "E", rate: 0 }, exemptionNotes: { E: " § 4 Nr. 21 UStG " } }, defaults());
    assert.equal(typed.kind === "resolved" ? typed.notes.E : undefined, "§ 4 Nr. 21 UStG");
    const none = resolveInvoiceTax(KEYS, { tax: { category: "E", rate: 0 } }, defaults());
    assert.equal(none.kind === "resolved" ? none.notes.E : undefined, null);
    const blank = resolveInvoiceTax(KEYS, { tax: { category: "O", rate: 0 }, exemptionNotes: { O: null } }, defaults());
    assert.equal(blank.kind === "resolved" ? blank.notes.O : undefined, DEFAULT_EXEMPTION_NOTES.en.O);
  });

  it("gives notes only for the categories in use", () => {
    const resolved = resolveInvoiceTax(KEYS, { tax: { category: "S", rate: 19 }, exemptionNotes: { AE: "unused" } }, defaults());
    assert.deepEqual(resolved.kind === "resolved" ? resolved.notes : null, {});
  });
});

describe("applyInvoiceTax", () => {
  const lines = [line("project:a", 100), line("project:b", 33.33)];

  it("stamps each line and computes EN 16931 figures", () => {
    const figures = applyInvoiceTax(
      lines,
      resolveInvoiceTax(KEYS, { tax: { category: "S", rate: 19 }, lineTax: [{ key: "project:b", category: "S", rate: 7 }] }, defaults()),
      null,
    );
    assert.deepEqual(figures.lineItems.map((l) => [l.taxCategory, l.taxRate]), [["S", 19], ["S", 7]]);
    // 100 × 19 % = 19.00; 33.33 × 7 % = 2.3331 → 2.33
    assert.equal(figures.subtotal, 133.33);
    assert.equal(figures.taxAmount, 21.33);
    assert.equal(figures.total, 154.66);
    assert.equal(figures.taxRate, null, "lines at different rates share no invoice rate");
    assert.equal(figures.taxBreakdown?.length, 2);
  });

  it("stores the common rate when every line shares one", () => {
    const figures = applyInvoiceTax(lines, resolveInvoiceTax(KEYS, { taxRate: 19 }, defaults()), 19);
    assert.equal(figures.taxRate, 19);
  });

  it("computes exactly the old figures when unresolved, and stamps nothing", () => {
    const figures = applyInvoiceTax(lines, { kind: "unresolved" }, 19);
    assert.deepEqual(
      { subtotal: figures.subtotal, taxAmount: figures.taxAmount, total: figures.total },
      invoiceTotals(lines, 19),
    );
    assert.equal(figures.taxBreakdown, null);
    assert.equal(figures.taxRate, 19);
    assert.equal("taxCategory" in (figures.lineItems[0] ?? {}), false);
  });

  it("refuses to apply unknown keys", () => {
    assert.throws(() => applyInvoiceTax(lines, { kind: "unknownKeys", keys: ["x"] }, null));
  });
});

describe("invoiceTotals (the category-less path)", () => {
  it("keeps main's results", () => {
    assert.deepEqual(invoiceTotals([line("a", 100), line("b", 33.33)], 19), { subtotal: 133.33, taxAmount: 25.33, total: 158.66 });
    assert.deepEqual(invoiceTotals([line("a", 0.07), line("b", 0.07)], 7.5), { subtotal: 0.14, taxAmount: 0.01, total: 0.15 });
    assert.deepEqual(invoiceTotals([], 19), { subtotal: 0, taxAmount: 0, total: 0 });
    assert.deepEqual(invoiceTotals([line("a", 100)], null), { subtotal: 100, taxAmount: 0, total: 100 });
  });

  it("rounds a tie away from zero, as the EN 16931 path does", () => {
    // 0.50 × 19 % = 0.095 → 0.10
    assert.equal(invoiceTotals([line("a", 0.5)], 19).taxAmount, 0.1);
  });

  it("still computes a rate with more than 2 decimals", () => {
    assert.equal(invoiceTotals([line("a", 100)], 7.125).taxAmount, 7.13);
  });
});
