import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { changesInvoicedCoverage } from "../services/entries/parallel-guard.js";
import { detailedEntrySchema } from "../api/v1/routes-table.js";

const H = 3_600_000;
const T0 = Date.UTC(2026, 10, 2, 9);
const span = (from: number, to: number | null) => ({ start: new Date(T0 + from), end: to === null ? null : new Date(T0 + to) });
// The invoiced entry: 09:00–10:00.
const invoiced = [{ startMs: T0, endMs: T0 + H }];

describe("parallel entries: the invoice overlap lock", () => {
  it("refuses creating an entry over invoiced time", () => {
    assert.equal(changesInvoicedCoverage(null, span(H / 2, 2 * H), invoiced), true);
  });

  it("allows creating an entry that touches invoiced time without overlapping it", () => {
    assert.equal(changesInvoicedCoverage(null, span(H, 2 * H), invoiced), false);
  });

  it("refuses deleting an entry that overlapped invoiced time", () => {
    assert.equal(changesInvoicedCoverage(span(0, H), null, invoiced), true);
  });

  it("refuses moving an overlap inside invoiced time, even at the same length", () => {
    assert.equal(changesInvoicedCoverage(span(0, H / 2), span(H / 2, H), invoiced), true);
  });

  it("allows changes outside invoiced time", () => {
    assert.equal(changesInvoicedCoverage(span(H / 2, 2 * H), span(H / 2, 3 * H), invoiced), false);
  });

  it("allows stopping a running timer after the invoiced entry ended", () => {
    assert.equal(changesInvoicedCoverage(span(H / 2, null), span(H / 2, 5 * H), invoiced), false);
  });

  it("refuses stopping a running timer inside invoiced time", () => {
    assert.equal(changesInvoicedCoverage(span(0, null), span(0, H / 2), invoiced), true);
  });

  it("refuses starting a backdated timer over invoiced time", () => {
    assert.equal(changesInvoicedCoverage(null, span(H / 2, null), invoiced), true);
  });

  it("allows anything when nothing is invoiced", () => {
    assert.equal(changesInvoicedCoverage(null, span(0, H), []), false);
  });
});

describe("REST: detailed report rows", () => {
  it("documents reportedSec as an optional number", () => {
    const row = detailedEntrySchema.safeParse({});
    assert.equal(row.success, false);
    const shape = (detailedEntrySchema as unknown as { shape: Record<string, { safeParse(v: unknown): { success: boolean } }> }).shape;
    assert.equal(shape.reportedSec!.safeParse(undefined).success, true);
    assert.equal(shape.reportedSec!.safeParse(1800).success, true);
    assert.equal(shape.reportedSec!.safeParse("1800").success, false);
  });
});
