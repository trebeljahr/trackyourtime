import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Invoice } from "@starter/shared";
import { coverInvoiceText, coverText } from "../services/einvoice/glyph-coverage.js";
import { einvoiceCase, issuerFixture, recipientFixture } from "./fixtures/einvoice/cases.js";

/** A font with ASCII only, so every non-ASCII character is visibly replaced. */
const asciiOnly = (codePoint: number): boolean => codePoint >= 0x20 && codePoint < 0x7f;

const MARK = "Ä";

/** Every string leaf of a value, with its dotted path. */
function stringLeaves(value: unknown, path = ""): [string, string][] {
  if (typeof value === "string") return [[path, value]];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => stringLeaves(item, `${path}[${index}]`));
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, item]) =>
      stringLeaves(item, path === "" ? key : `${path}.${key}`),
    );
  }
  return [];
}

/** Paths the renderer never draws: ids, dates, codes. Everything else must be covered. */
const UNDRAWN =
  /^(id|workspaceId|createdBy|clientId|status|issueDate|dueDate|from|to|groupBy|currency|createdAt|updatedAt|locale|entryIds\[\d+\]|lineItems\[\d+\]\.(key|projectId|taskId|currency|taxCategory)|taxBreakdown\[\d+\]\.(category|exemptionReasonCode)|(issuer|recipient)\.electronicAddressScheme|einvoiceFills.*)$/;

/** Every text leaf of a flat party marked (null leaves become the mark, an empty address gets one line); the scheme code is left alone. */
function markParty<P extends object>(party: P): P {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(party)) {
    if (key === "electronicAddressScheme") out[key] = value;
    else if (typeof value === "string") out[key] = `${value}${MARK}`;
    else if (value === null) out[key] = MARK;
    else if (Array.isArray(value)) {
      out[key] = value.length === 0 ? [MARK] : value.map((item: unknown) => `${String(item)}${MARK}`);
    } else out[key] = value;
  }
  return out as P;
}

function markedInvoice(): Invoice {
  const base = einvoiceCase("reverse-charge-ae").invoice();
  const mark = (value: string | null): string | null => (value === null ? `${MARK}` : `${value}${MARK}`);
  return {
    ...base,
    number: `${base.number}${MARK}`,
    clientName: `${base.clientName}${MARK}`,
    notes: mark(base.notes),
    paymentTerms: mark(base.paymentTerms ?? null),
    lineItems: base.lineItems.map((line) => ({ ...line, label: `${line.label}${MARK}` })),
    issuer: markParty(issuerFixture({ addressLines: ["Musterstraße 1", "Hinterhaus"] })),
    recipient: markParty(recipientFixture()),
    taxBreakdown: (base.taxBreakdown ?? []).map((row) => ({
      ...row,
      exemptionReason: mark(row.exemptionReason),
    })),
  };
}

describe("coverText", () => {
  it("keeps characters the font has", () => {
    assert.equal(coverText("Invoice 2026-0042", asciiOnly), "Invoice 2026-0042");
  });

  it("replaces a missing character with one ?", () => {
    assert.equal(coverText("Müller", asciiOnly), "M?ller");
  });

  it("replaces an astral character (a surrogate pair) with ONE ?", () => {
    assert.equal(coverText("a😀b", asciiOnly), "a?b");
  });

  it("keeps newlines and tabs, which the renderer lays out rather than draws", () => {
    assert.equal(coverText("a\nb\tc\r\n", asciiOnly), "a\nb\tc\r\n");
  });
});

describe("coverInvoiceText", () => {
  it("does not mutate its input", () => {
    const invoice = markedInvoice();
    const before = structuredClone(invoice);
    coverInvoiceText(invoice, asciiOnly);
    assert.deepEqual(invoice, before);
  });

  it("covers every string the renderer draws, and nothing else", () => {
    const invoice = markedInvoice();
    const covered = coverInvoiceText(invoice, asciiOnly);
    const original = new Map(stringLeaves(invoice));
    for (const [path, value] of stringLeaves(covered)) {
      if (UNDRAWN.test(path)) {
        assert.equal(value, original.get(path), `${path} must be untouched`);
      } else {
        assert.ok(!value.includes(MARK), `${path} was not covered: ${value}`);
      }
    }
    // Every drawn field carried the mark, so each one must now carry the replacement.
    const drawn = stringLeaves(covered).filter(([path]) => !UNDRAWN.test(path));
    assert.ok(drawn.length > 20, "the table must actually walk the snapshot leaves");
    for (const [path, value] of drawn) assert.ok(value.includes("?"), path);
  });

  it("leaves numbers and a legacy invoice's missing snapshots alone", () => {
    const legacy = einvoiceCase("standard-19").invoice();
    const { issuer: _issuer, recipient: _recipient, taxBreakdown: _rows, paymentTerms: _terms, ...rest } =
      legacy;
    const covered = coverInvoiceText(rest, asciiOnly);
    assert.equal("issuer" in covered, false);
    assert.equal("recipient" in covered, false);
    assert.equal("taxBreakdown" in covered, false);
    assert.equal("paymentTerms" in covered, false);
    assert.equal(covered.total, legacy.total);
    // An invoice from before snapshots stores null parties; those stay null.
    const nullParties = coverInvoiceText({ ...rest, issuer: null, recipient: null }, asciiOnly);
    assert.equal(nullParties.issuer, null);
    assert.equal(nullParties.recipient, null);
    assert.deepEqual(
      covered.lineItems.map((line) => line.amount),
      legacy.lineItems.map((line) => line.amount),
    );
  });
});
