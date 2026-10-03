import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { sumCurrencyAmounts, rollUpEntries, budgetProgress } from "@starter/shared";
import { reportsRouter, summaryCsvRows, summaryCsvColumns } from "../trpc/routers/reports.js";
import { renderSummaryPdf, renderDetailedPdf } from "../services/pdf.js";
import { pageTexts } from "./support/pdf-text.js";
import { OWNER, ADMIN, contextFor, freshStore, installStore, resetStore } from "./support/shared-workspace.js";

const store = freshStore();
const restore = installStore(store);
after(restore);
beforeEach(() => resetStore(store));
const range = { from: "2026-09-01", to: "2026-09-30" };
const caller = () => reportsRouter.createCaller(contextFor(OWNER));
const meta = { title: "Currency report", timeZone: "UTC", from: range.from, to: range.to, currency: "GBP", generatedAt: "2026-10-01T00:00:00Z" };

function currencies(): void {
  // Workspace currency changes between bookings. The saved snapshots stay put.
  store.settings.rows[0]!.currency = "USD";
  store.entries.rows[0]!.currency = "EUR";
  store.entries.rows[0]!.hourlyRate = 10;
  store.entries.rows[1]!.currency = "USD";
  store.entries.rows[1]!.hourlyRate = 20;
  store.entries.rows[2]!.billable = false;
}

 describe("report currency snapshots", () => {
  it("summary groups and range totals retain separate currency buckets", async () => {
    currencies();
    const result = await caller().summary({ ...range, groupBy: "project" });
    assert.equal(result.totalSec, 10800);
    assert.equal(result.totalAmount, null);
    assert.equal(result.moneyVisible, true);
    assert.deepEqual(result.totalAmounts, [{ currency: "EUR", amount: 10 }, { currency: "USD", amount: 20 }]);
    assert.equal(result.groups[0]!.amount, null);
    assert.deepEqual(result.groups[0]!.amounts, result.totalAmounts);
    const rows = summaryCsvRows(result);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => [row.amount, row.currency]), [[10, "EUR"], [20, "USD"]]);
    assert.equal(rows.reduce((sum, row) => sum + Number(row.seconds ?? 0), 0), result.totalSec);
    const pdf = pageTexts(await renderSummaryPdf(result, meta)).join(" ");
    assert.match(pdf, /10\.00 EUR/);
    assert.match(pdf, /20\.00 USD/);
    assert.doesNotMatch(pdf, /30\.00/);
  });

  it("detailed totals cover the entire range even on a one-entry page", async () => {
    currencies();
    const result = await caller().detailed({ ...range, limit: 1 });
    assert.equal(result.entries.length, 1);
    assert.equal(result.totalAmount, null);
    assert.deepEqual(result.totalAmounts, [{ currency: "EUR", amount: 10 }, { currency: "USD", amount: 20 }]);
    const full = await caller().detailed(range);
    const pdf = pageTexts(await renderDetailedPdf(full, meta)).join(" ");
    assert.match(pdf, /10\.00 EUR/);
    assert.match(pdf, /20\.00 USD/);
    assert.doesNotMatch(pdf, /30\.00/);
  });

  it("single historical currency differs from the current workspace currency", async () => {
    store.settings.rows[0]!.currency = "GBP";
    const summary = await caller().summary({ ...range, groupBy: "project" });
    const detail = await caller().detailed(range);
    assert.equal(summary.currency, "EUR");
    assert.equal(detail.currency, "EUR");
    assert.equal(summary.groups[0]!.currency, "EUR");
    assert.equal(summary.totalAmount, summary.totalAmounts![0]!.amount);
    assert.equal(summaryCsvRows(summary)[0]!.currency, "EUR");
    assert.match(pageTexts(await renderDetailedPdf(detail, meta)).join(" "), /Amounts in EUR/);
  });

  it("withheld report currency buckets cannot leak own or colleague money", async () => {
    currencies();
    const restricted = reportsRouter.createCaller(contextFor(ADMIN));
    // The member's default fixture visibility withholds colleagues' money.
    const result = await restricted.summary({ ...range, groupBy: "project" });
    assert.equal(result.moneyVisible, false);
    assert.equal(result.totalAmounts, null);
    assert.ok(result.groups.every((group) => group.amounts === null));
    assert.ok(summaryCsvRows(result).every((row) => row.amount === undefined));
    assert.ok(summaryCsvColumns(false).every((column) => column.key !== "currency" && column.key !== "amount"));
  });
 });

it("cent rounding and withholding are independent of currency conversion", () => {
  assert.deepEqual(sumCurrencyAmounts([{ currency: " eur ", amount: 0.1 }, { currency: "EUR", amount: 0.2 }, { currency: "USD", amount: 0 }]), [{ currency: "EUR", amount: 0.3 }]);
  assert.equal(sumCurrencyAmounts([{ currency: "EUR", amount: null }]), null);
});

it("budgets count only earnings in the budget currency", () => {
  const progress = budgetProgress({ estimatedHours: null, budgetAmount: 100, budgetCurrency: "EUR" }, rollUpEntries([
    { seconds: 3600, billable: true, hourlyRate: 10, currency: "EUR" },
    { seconds: 3600, billable: true, hourlyRate: 20, currency: "USD" },
  ]));
  assert.equal(progress.spentAmount, 10);
  assert.equal(progress.mixedCurrency, true);
});

it("old report payloads keep scalar null money withheld", async () => {
  const result = await caller().summary({ ...range, groupBy: "project" });
  delete result.totalAmounts;
  result.totalAmount = null;
  const pdf = pageTexts(await renderSummaryPdf(result, meta)).join(" ");
  assert.doesNotMatch(pdf, /AMOUNT \(|Amount \(/);
});
