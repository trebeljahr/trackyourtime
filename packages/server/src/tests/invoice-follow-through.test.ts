import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { invoiceBalance, moneyMinor, nextReminderDay } from "@starter/shared";
import {
  appendInvoicePayment,
  creditInvoice,
} from "../services/invoice-follow-through.js";
import { previewInvoiceReminder } from "../services/scheduler/invoice-reminders.js";
import { readyInvoice } from "./support/einvoice-invoice.js";
import { renderInvoicePdf } from "../services/invoice-pdf.js";
import { pageTexts } from "./support/pdf-text.js";
import { buildCiiXml } from "../services/einvoice/cii.js";
import { assertEinvoiceReady } from "../services/einvoice/validate.js";

const now = new Date("2026-10-03T10:00:00.000Z");
const command = (amount: string) => ({
  requestId: randomUUID(),
  amount,
  kind: "payment" as const,
  at: "2026-10-01T00:00:00.000Z",
  note: "Bank reference",
});

describe("invoice follow-through arithmetic", () => {
  it("parses decimal money exactly, including zero and three decimal currencies", () => {
    assert.equal(moneyMinor("0.29", "EUR"), 29);
    assert.equal(moneyMinor("12,34", "EUR"), 1234);
    assert.equal(moneyMinor("12", "JPY"), 1200);
    assert.equal(moneyMinor("1.234", "KWD"), 1234);
    for (const amount of ["1.001", "-1", "NaN", "1e5", "9007199254740992"])
      assert.throws(() => moneyMinor(amount, "EUR"));
  });
  it("reads historical zero/three-decimal currency totals and float tails without changing their figures", () => {
    for (const [currency, total, minor] of [
      ["JPY", 12.34, 1234],
      ["KWD", 12.345, 12345],
      ["EUR", 0.1 + 0.2, 30],
    ] as const) {
      const invoice = { ...readyInvoice(), currency, total };
      assert.equal(invoiceBalance(invoice, now).totalMinor, minor);
      assert.equal(invoice.total, total);
    }
  });
  it("represents invalid debt as unavailable and refuses accounting changes", () => {
    for (const total of [NaN, Infinity, -1, 1e20]) {
      const invoice = { ...readyInvoice(), total };
      const balance = invoiceBalance(invoice, now);
      assert.equal(balance.available, false);
      assert.equal(balance.totalMinor, null);
      assert.equal(balance.outstandingMinor, null);
      assert.throws(
        () => appendInvoicePayment(invoice, command("1"), "owner", now),
        /invoice-balance-unavailable/,
      );
      assert.throws(
        () =>
          creditInvoice(
            invoice,
            { requestId: randomUUID(), reason: "Invalid", replacement: false },
            "owner",
            now,
          ),
        /invoice-balance-unavailable/,
      );
    }
  });
  it("reminder preview retains the fractional outstanding balance on historical JPY invoices", () => {
    const invoice = { ...readyInvoice(), total: 0.5, currency: "JPY" };
    const preview = previewInvoiceReminder(
      invoice,
      "synthetic@example.test",
      "UTC",
      now,
    );
    assert.match(preview.text, /(?:¥|JPY)\s*0\.50/);
    assert.equal(preview.outstandingMinor, 50);
  });
  it("uses the invoice timezone for calendar overdue days, including DST boundaries", () => {
    const invoice = {
      ...readyInvoice(),
      dueDate: "2026-10-03T00:00:00.000Z",
      timezone: "Australia/Sydney",
    };
    assert.equal(
      invoiceBalance(invoice, new Date("2026-10-03T13:59:59Z")).overdueDays,
      0,
    );
    assert.equal(
      invoiceBalance(invoice, new Date("2026-10-03T14:00:00Z")).overdueDays,
      1,
    );
    assert.equal(
      invoiceBalance({ ...invoice, status: "draft" }, now).overdueDays,
      0,
    );
  });
  it("accepts today's payment date in the invoice timezone before UTC midnight", () => {
    const invoice = { ...readyInvoice(), timezone: "Australia/Sydney" };
    const localToday = "2026-10-04T00:00:00.000Z";
    const instant = new Date("2026-10-03T14:30:00.000Z");
    const result = appendInvoicePayment(
      invoice,
      { ...command("1"), at: localToday },
      "owner",
      instant,
    );
    assert.equal(result.payments?.[0]?.at, localToday);
    assert.throws(() =>
      appendInvoicePayment(
        invoice,
        { ...command("1"), at: "2026-10-05T00:00:00.000Z" },
        "owner",
        instant,
      ),
    );
  });
  it("payment dates stay calendar dates across Los Angeles midnight and both DST changes", () => {
    const invoice = { ...readyInvoice(), timezone: "America/Los_Angeles" };
    for (const instant of [
      "2026-03-08T09:30:00Z",
      "2026-03-08T10:30:00Z",
      "2026-03-09T06:30:00Z",
    ]) {
      const result = appendInvoicePayment(
        invoice,
        { ...command("1"), at: "2026-03-08T00:00:00.000Z" },
        "owner",
        new Date(instant),
      );
      assert.equal(result.payments?.[0]?.at.slice(0, 10), "2026-03-08");
      assert.throws(() =>
        appendInvoicePayment(
          invoice,
          { ...command("1"), at: "2026-03-09T00:00:00.000Z" },
          "owner",
          new Date(instant),
        ),
      );
    }
    for (const instant of ["2026-11-01T08:30:00Z", "2026-11-01T09:30:00Z"]) {
      const result = appendInvoicePayment(
        invoice,
        { ...command("1"), at: "2026-11-01T00:00:00.000Z" },
        "owner",
        new Date(instant),
      );
      assert.equal(result.payments?.[0]?.at.slice(0, 10), "2026-11-01");
    }
  });
  it("keeps partial payments exact and refuses changed request ids, overpayment and repeated reversals", () => {
    const invoice = { ...readyInvoice(), total: 1.0 };
    const first = command("0.29");
    const paid = {
      ...invoice,
      followThrough: appendInvoicePayment(invoice, first, "owner", now),
    };
    assert.equal(invoiceBalance(paid, now).outstandingMinor, 71);
    assert.deepEqual(
      appendInvoicePayment(paid, first, "owner", now),
      paid.followThrough,
    );
    assert.throws(
      () =>
        appendInvoicePayment(paid, { ...first, amount: "0.30" }, "owner", now),
      /invoice-request-reused/,
    );
    assert.throws(
      () => appendInvoicePayment(paid, command("0.72"), "owner", now),
      /overpayment/,
    );
    const reverse = {
      ...command("0.29"),
      kind: "reversal" as const,
      reverses: first.requestId,
    };
    const reversed = {
      ...paid,
      followThrough: appendInvoicePayment(paid, reverse, "owner", now),
    };
    assert.equal(invoiceBalance(reversed).outstandingMinor, 100);
    assert.equal(reversed.followThrough.payments?.length, 2);
    assert.throws(
      () =>
        appendInvoicePayment(
          reversed,
          { ...reverse, requestId: randomUUID() },
          "owner",
          now,
        ),
      /reversal-invalid/,
    );
  });
  it("legacy paid has no invented date; credit establishes the refund balance", () => {
    const invoice = { ...readyInvoice(), status: "paid" as const };
    assert.equal(invoiceBalance(invoice).outstandingMinor, 0);
    assert.equal(invoiceBalance(invoice).legacySettled, true);
    const credited = {
      ...invoice,
      followThrough: creditInvoice(
        invoice,
        {
          requestId: randomUUID(),
          reason: "Incorrect scope",
          replacement: false,
        },
        "owner",
        now,
      ),
    };
    assert.equal(credited.followThrough.payments, undefined);
    assert.equal(
      invoiceBalance(credited).refundDueMinor,
      moneyMinor(String(invoice.total), "EUR"),
    );
    const refunded = {
      ...credited,
      followThrough: appendInvoicePayment(
        credited,
        { ...command(String(invoice.total)), kind: "refund" },
        "owner",
        now,
      ),
    };
    assert.equal(invoiceBalance(refunded).refundDueMinor, 0);
    assert.equal(refunded.followThrough.payments?.[0]?.kind, "refund");
  });
  it("reverses a mistaken refund by appending a linked correction", () => {
    const invoice = { ...readyInvoice(), status: "paid" as const };
    const credited = {
      ...invoice,
      followThrough: creditInvoice(
        invoice,
        { requestId: randomUUID(), reason: "Cancelled", replacement: false },
        "owner",
        now,
      ),
    };
    const refund = { ...command("1.00"), kind: "refund" as const };
    const refunded = {
      ...credited,
      followThrough: appendInvoicePayment(credited, refund, "owner", now),
    };
    const reversed = {
      ...refunded,
      followThrough: appendInvoicePayment(
        refunded,
        { ...command("1.00"), kind: "reversal", reverses: refund.requestId },
        "owner",
        now,
      ),
    };
    assert.equal(
      invoiceBalance(reversed).refundDueMinor,
      invoiceBalance(credited).refundDueMinor,
    );
    assert.equal(reversed.followThrough.payments?.length, 2);
  });
  it("freezes complete credit snapshots and accepts only the identical retry", () => {
    const invoice = readyInvoice();
    const input = {
      requestId: randomUUID(),
      reason: "Correct recipient",
      replacement: true,
    };
    const followThrough = creditInvoice(invoice, input, "owner", now);
    assert.deepEqual(
      followThrough.credit?.snapshot.lineItems,
      invoice.lineItems,
    );
    assert.deepEqual(
      followThrough.credit?.snapshot.taxBreakdown,
      invoice.taxBreakdown,
    );
    assert.deepEqual(followThrough.credit?.snapshot.issuer, invoice.issuer);
    assert.equal(followThrough.credit?.number, `CN-${invoice.number}`);
    assert.deepEqual(
      creditInvoice({ ...invoice, followThrough }, input, "owner", now),
      followThrough,
    );
    assert.throws(() =>
      creditInvoice(
        { ...invoice, followThrough },
        { ...input, reason: "Different" },
        "owner",
        now,
      ),
    );
    invoice.lineItems[0]!.label = "Later change";
    assert.notEqual(
      followThrough.credit?.snapshot.lineItems[0]?.label,
      "Later change",
    );
  });
  it("reminders need consent, stop on settlement/credit and have only three steps", () => {
    const invoice = readyInvoice();
    assert.equal(nextReminderDay(invoice, now), null);
    const opted = {
      ...invoice,
      followThrough: {
        reminders: {
          enabled: true,
          recipient: "fake@example.test",
          timezone: "UTC",
          consentAt: now.toISOString(),
          consentBy: "owner",
          sentDays: [] as number[],
        },
      },
    };
    assert.equal(nextReminderDay(opted, now), 1);
    opted.followThrough.reminders.sentDays = [1, 7, 14];
    assert.equal(nextReminderDay(opted, new Date("2026-12-01")), null);
    opted.followThrough.reminders.sentDays = [];
    assert.equal(nextReminderDay({ ...opted, status: "paid" }, now), null);
    assert.match(
      previewInvoiceReminder(opted, "fake@example.test", "UTC", now).text,
      /Example/,
    );
  });
  it("late opt-in selects day 14 once instead of catching up three emails", () => {
    const invoice = {
      ...readyInvoice(),
      followThrough: {
        reminders: {
          enabled: true,
          recipient: "fake@example.test",
          timezone: "UTC",
          consentAt: now.toISOString(),
          consentBy: "owner",
          sentDays: [] as number[],
        },
      },
    };
    const late = new Date("2026-10-30");
    assert.equal(nextReminderDay(invoice, late), 14);
    invoice.followThrough.reminders.sentDays = [14];
    assert.equal(nextReminderDay(invoice, new Date("2026-10-31")), null);
  });
  it("credit PDFs name the original and reason in both languages; CII refuses credits", async () => {
    for (const locale of ["en", "de"] as const) {
      const credit = {
        ...readyInvoice(),
        locale,
        documentKind: "credit" as const,
        status: "paid" as const,
        number: "CN-2026-0042",
        creditReference: { number: "2026-0042", reason: "Correction" },
        notes: "Correction",
      };
      const text = pageTexts(
        await renderInvoicePdf(credit, { generatedAt: now.toISOString() }),
      ).join(" ");
      assert.match(
        text,
        locale === "de"
          ? /Stornorechnung CN-2026-0042/
          : /Credit note CN-2026-0042/,
      );
      assert.match(text, /2026-0042/);
      assert.match(text, /Correction/);
      assert.doesNotMatch(text, /StatusPaid|StatusBezahlt/);
      assert.throws(
        () => buildCiiXml(assertEinvoiceReady(credit, "en16931"), "en16931"),
        /credit-xml-unsupported/,
      );
    }
  });
});
