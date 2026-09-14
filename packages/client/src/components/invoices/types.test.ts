import { describe, expect, it } from "vitest";
import type { InvoiceLineItem } from "@starter/shared";

import {
  canDeleteInvoice,
  defaultInvoiceDates,
  emptyPreviewReason,
  exclusionNotices,
  formatHours,
  linesHaveMixedTax,
  previewIsBillable,
  reconcileDueDate,
  shiftDateKey,
  statusActionLabel,
  statusTransitions,
  taxCategoryLabel,
  taxLabel,
  totalHours,
} from "./types";

const line = (overrides: Partial<InvoiceLineItem> = {}): InvoiceLineItem => ({
  key: "p1",
  label: "Project",
  projectId: "p1",
  taskId: null,
  seconds: 3600,
  hours: 1,
  hourlyRate: 100,
  currency: "EUR",
  amount: 100,
  ...overrides,
});

describe("statusTransitions", () => {
  // Mirrors the server's table in routers/invoices.ts. If these two ever
  // disagree the UI is offering a button the server will refuse, or hiding a
  // move it would have accepted.
  it("walks a draft forward only", () => {
    expect(statusTransitions("draft")).toEqual(["sent"]);
  });

  it("lets a sent invoice go either way", () => {
    expect(statusTransitions("sent")).toEqual(["draft", "paid"]);
  });

  it("walks a paid invoice back one step at a time", () => {
    expect(statusTransitions("paid")).toEqual(["sent"]);
  });

  it("never offers draft → paid, which the server refuses", () => {
    expect(statusTransitions("draft")).not.toContain("paid");
  });

  it("never offers paid → draft, which the server refuses", () => {
    expect(statusTransitions("paid")).not.toContain("draft");
  });

  it("never offers the status the invoice already has", () => {
    for (const status of ["draft", "sent", "paid"] as const) {
      expect(statusTransitions(status)).not.toContain(status);
    }
  });
});

describe("statusActionLabel", () => {
  it("reads as progress going forward", () => {
    expect(statusActionLabel("draft", "sent")).toBe("Mark as sent");
    expect(statusActionLabel("sent", "paid")).toBe("Mark as paid");
  });

  it("reads as a correction going back", () => {
    expect(statusActionLabel("sent", "draft")).toBe("Back to draft");
    expect(statusActionLabel("paid", "sent")).toBe("Back to sent");
  });
});

describe("canDeleteInvoice", () => {
  it("allows only drafts", () => {
    expect(canDeleteInvoice("draft")).toBe(true);
    expect(canDeleteInvoice("sent")).toBe(false);
    expect(canDeleteInvoice("paid")).toBe(false);
  });
});

describe("exclusionNotices", () => {
  it("says nothing when nothing was excluded", () => {
    expect(
      exclusionNotices({ skippedMissingRate: 0, skippedInvoiced: 0 }),
    ).toEqual([]);
  });

  it("warns about un-rated time rather than billing less silently", () => {
    const [notice] = exclusionNotices({
      skippedMissingRate: 6,
      skippedInvoiced: 0,
    });
    expect(notice?.id).toBe("missing-rate");
    expect(notice?.tone).toBe("warning");
    expect(notice?.message).toContain("6 entries have");
  });

  it("reports already-invoiced time as reassurance, not a problem", () => {
    const [notice] = exclusionNotices({
      skippedMissingRate: 0,
      skippedInvoiced: 1,
    });
    expect(notice?.id).toBe("already-invoiced");
    expect(notice?.tone).toBe("info");
    expect(notice?.message).toContain("1 entry is");
    expect(notice?.message).toContain("not be billed again");
  });

  it("surfaces both reasons at once", () => {
    expect(
      exclusionNotices({ skippedMissingRate: 2, skippedInvoiced: 3 }).map(
        (notice) => notice.id,
      ),
    ).toEqual(["missing-rate", "already-invoiced"]);
  });
});

describe("previewIsBillable", () => {
  it("is false while the preview is still loading", () => {
    expect(previewIsBillable(undefined)).toBe(false);
  });

  it("is false when every candidate entry dropped out", () => {
    expect(previewIsBillable({ entryIds: [] })).toBe(false);
  });

  it("is true as soon as one entry would be billed", () => {
    expect(previewIsBillable({ entryIds: ["e1"] })).toBe(true);
  });
});

describe("emptyPreviewReason", () => {
  it("names double-billing protection as the reason when it is", () => {
    expect(
      emptyPreviewReason({ skippedMissingRate: 0, skippedInvoiced: 4 }),
    ).toContain("already been invoiced");
  });

  it("names the missing rate when that is the reason", () => {
    expect(
      emptyPreviewReason({ skippedMissingRate: 4, skippedInvoiced: 0 }),
    ).toContain("no hourly rate");
  });

  it("covers both at once", () => {
    expect(
      emptyPreviewReason({ skippedMissingRate: 1, skippedInvoiced: 1 }),
    ).toContain("either already invoiced or missing a rate");
  });

  it("falls back to plain nothing-tracked", () => {
    expect(
      emptyPreviewReason({ skippedMissingRate: 0, skippedInvoiced: 0 }),
    ).toContain("No billable, un-invoiced time");
  });
});

describe("hours display", () => {
  it("always prints two decimals, the way the amount was derived", () => {
    expect(formatHours(3)).toBe("3.00 h");
    expect(formatHours(1.5)).toBe("1.50 h");
    expect(formatHours(0)).toBe("0.00 h");
  });

  it("survives a non-finite value rather than printing NaN", () => {
    expect(formatHours(Number.NaN)).toBe("0.00 h");
  });

  it("totals from seconds, not from the rounded per-line hours", () => {
    // Three lines of 10 seconds are 0.01 h in total; summing three
    // individually-rounded 0.00 h values would say zero.
    const lines = [
      line({ key: "a", seconds: 10, hours: 0 }),
      line({ key: "b", seconds: 10, hours: 0 }),
      line({ key: "c", seconds: 10, hours: 0 }),
    ];
    expect(totalHours(lines)).toBe(0.01);
  });

  it("adds up the ordinary case", () => {
    expect(
      totalHours([
        line({ key: "a", seconds: 3600 }),
        line({ key: "b", seconds: 5400 }),
      ]),
    ).toBe(2.5);
  });
});

describe("taxLabel", () => {
  it("distinguishes no tax line from a real zero", () => {
    expect(taxLabel(null)).toBe("No tax");
    expect(taxLabel(0)).toBe("Tax (0%)");
  });

  it("keeps whole percentages whole", () => {
    expect(taxLabel(19)).toBe("Tax (19%)");
    expect(taxLabel(8.25)).toBe("Tax (8.25%)");
  });
});

describe("dates", () => {
  it("shifts a local date key without drifting across a month end", () => {
    expect(shiftDateKey("2026-01-31", 1)).toBe("2026-02-01");
    expect(shiftDateKey("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("leaves an unparseable key alone", () => {
    expect(shiftDateKey("not-a-date", 3)).toBe("not-a-date");
  });

  it("defaults to net-14", () => {
    const dates = defaultInvoiceDates(new Date(2026, 7, 21));
    expect(dates).toEqual({ issueDate: "2026-08-21", dueDate: "2026-09-04" });
  });

  it("drags the due date along when the issue date passes it", () => {
    // The server refuses dueDate < issueDate, so the form must never build one.
    expect(reconcileDueDate("2026-09-10", "2026-09-01")).toBe("2026-09-24");
  });

  it("leaves a due date that is already valid untouched", () => {
    expect(reconcileDueDate("2026-09-01", "2026-09-30")).toBe("2026-09-30");
  });
});

describe("taxCategoryLabel", () => {
  it("names the standard rate with its percentage", () => {
    expect(taxCategoryLabel("S", 19)).toBe("VAT 19 %");
    expect(taxCategoryLabel("S", 7.5)).toBe("VAT 7.5 %");
  });

  it("names the zero-rate categories without a rate", () => {
    expect(taxCategoryLabel("AE", 0)).toBe("Reverse charge");
    expect(taxCategoryLabel("O", 0)).toBe("Not subject to VAT");
    expect(taxCategoryLabel("E", 0)).toBe("Exempt");
    expect(taxCategoryLabel("Z", 0)).toBe("0 % zero rated");
  });
});

describe("linesHaveMixedTax", () => {
  const taxed = (taxCategory?: "S" | "E", taxRate?: number): InvoiceLineItem =>
    line(taxCategory === undefined ? {} : { taxCategory, taxRate });

  it("is false for uniform or legacy lines and true for different categories", () => {
    expect(linesHaveMixedTax([taxed("S", 19), taxed("S", 19)])).toBe(false);
    expect(linesHaveMixedTax([taxed(), taxed()])).toBe(false);
    expect(linesHaveMixedTax([taxed("S", 19), taxed("E", 0)])).toBe(true);
    expect(linesHaveMixedTax([taxed("S", 19), taxed("S", 7)])).toBe(true);
  });
});
