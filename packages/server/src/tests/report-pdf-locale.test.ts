// Report PDF exports in the exporter's language. English — no `locale` on the
// meta — is covered word for word by pdf.test.ts, which predates localisation
// and still passes unchanged; this file covers German, and the label choices
// that only exist because a language other than English does.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  DetailedEntry,
  SummaryReportResult,
  WeeklyReportResult,
} from "@starter/shared";
import {
  renderDetailedPdf,
  renderSummaryPdf,
  renderWeeklyPdf,
  reportPdfTitle,
  type PdfReportMeta,
} from "../services/pdf.js";
import { pageTexts } from "./support/pdf-text.js";

const meta = (overrides: Partial<PdfReportMeta> = {}): PdfReportMeta => ({
  title: reportPdfTitle("de", { kind: "summary", groupBy: "project" }),
  locale: "de",
  from: "2026-08-01",
  to: "2026-08-31",
  timeZone: "Europe/Berlin",
  currency: "EUR",
  generatedAt: "2026-09-01T08:00:00.000Z",
  ...overrides,
});

const summary = (groups: SummaryReportResult["groups"]): SummaryReportResult => ({
  totalSec: 12_600,
  billableSec: 9000,
  totalAmount: 1225.5,
  currency: "EUR",
  groups,
  timeline: [],
  moneyVisible: true,
});

const firstPage = (bytes: Buffer): string => {
  const [page] = pageTexts(bytes);
  assert.ok(page !== undefined);
  return page;
};

describe("reportPdfTitle", () => {
  it("is the pre-localisation English title without a locale", () => {
    assert.equal(
      reportPdfTitle(undefined, { kind: "summary", groupBy: "tag" }),
      "Summary report by tag",
    );
    assert.equal(reportPdfTitle("en", { kind: "detailed" }), "Detailed report");
    assert.equal(reportPdfTitle(undefined, { kind: "weekly" }), "Weekly timesheet");
  });

  it("names the grouping in German, with the glossary's words", () => {
    assert.equal(
      reportPdfTitle("de", { kind: "summary", groupBy: "client" }),
      "Übersicht nach Kunden",
    );
    assert.equal(
      reportPdfTitle("de", { kind: "summary", groupBy: "tag" }),
      "Übersicht nach Schlagwort",
    );
    assert.equal(reportPdfTitle("de", { kind: "weekly" }), "Wöchentlicher Stundenzettel");
  });
});

describe("German report PDFs", () => {
  it("a summary is German, and only invented group labels are relabelled", async () => {
    const page = firstPage(
      await renderSummaryPdf(
        summary([
          {
            key: "project-1",
            // A project's name is the user's text, whatever it says.
            label: "No project work",
            color: "#8b5cf6",
            seconds: 9000,
            billableSec: 9000,
            amount: 1225.5,
          },
          { key: "none", label: "No project", color: null, seconds: 3600, billableSec: 0, amount: 0 },
        ]),
        meta(),
        "project",
      ),
    );
    for (const expected of [
      "Übersicht nach Projekt",
      "01.08.2026 bis 31.08.2026 · Zeitzone Europe/Berlin",
      "Beträge in EUR · erstellt am 01.09.2026, 08:00 UTC",
      "GESAMT ERFASST",
      "GruppeDauerAbrechenbarBetrag (EUR)",
      "No project work",
      "Kein Projekt",
      "1.225,50",
      "Seite 1",
    ]) {
      assert.ok(page.includes(expected), `missing ${JSON.stringify(expected)} in ${page}`);
    }
    // Durations stay numeric in both languages.
    assert.ok(page.includes("2:30:00"));
  });

  it("calendar groupings are written as German dates", async () => {
    const page = firstPage(
      await renderSummaryPdf(
        summary([
          { key: "2026-08", label: "August 2026", color: null, seconds: 3600, billableSec: 0, amount: 0 },
          { key: "2026-03", label: "March 2026", color: null, seconds: 3600, billableSec: 0, amount: 0 },
        ]),
        meta({ title: reportPdfTitle("de", { kind: "summary", groupBy: "month" }) }),
        "month",
      ),
    );
    assert.ok(page.includes("August 2026"));
    assert.ok(page.includes("März 2026"));
    assert.ok(!page.includes("March 2026"));
  });

  it("an English export keeps the query's labels verbatim", async () => {
    const page = firstPage(
      await renderSummaryPdf(
        summary([
          { key: "none", label: "No project", color: null, seconds: 3600, billableSec: 0, amount: 0 },
        ]),
        meta({ locale: undefined, title: "Summary report by project" }),
        "project",
      ),
    );
    assert.ok(page.includes("No project"));
    assert.ok(page.includes("2026-08-01 to 2026-08-31 · time zone Europe/Berlin"));
  });

  it("a detailed report is German, down to a running entry", async () => {
    const entry: DetailedEntry = {
      id: "entry-1",
      workspaceId: "workspace-1",
      authorId: "user-1",
      description: "",
      projectId: null,
      taskId: null,
      billable: true,
      start: "2026-08-03T07:00:00.000Z",
      end: null,
      durationSec: 0,
      hourlyRate: 90,
      currency: "EUR",
      source: "web",
      timeZone: "Europe/Berlin",
      tagIds: [],
      invoiceId: null,
      importId: null,
      runaway: null,
      createdAt: "2026-08-03T07:00:00.000Z",
      updatedAt: "2026-08-03T07:00:00.000Z",
      projectName: null,
      projectColor: null,
      clientName: null,
      taskName: null,
      amount: 0,
    };
    const page = firstPage(
      await renderDetailedPdf(
        { entries: [entry], totalSec: 0, totalAmount: 0, currency: "EUR", moneyVisible: true },
        meta({ title: reportPdfTitle("de", { kind: "detailed" }) }),
      ),
    );
    for (const expected of [
      "Detaillierter Bericht",
      "DatumUhrzeitDauer",
      "03.08.2026",
      "09:00 – läuft",
      "(keine Beschreibung)",
      "Kein Projekt",
      "Gesamt",
    ]) {
      assert.ok(page.includes(expected), `missing ${JSON.stringify(expected)} in ${page}`);
    }
  });

  it("a weekly timesheet heads its days in German", async () => {
    const result: WeeklyReportResult = {
      days: [
        "2026-08-03",
        "2026-08-04",
        "2026-08-05",
        "2026-08-06",
        "2026-08-07",
        "2026-08-08",
        "2026-08-09",
      ],
      rows: [],
      dayTotals: [0, 0, 0, 0, 0, 0, 0],
      totalSec: 0,
      moneyVisible: true,
    };
    const page = firstPage(
      await renderWeeklyPdf(result, meta({ title: reportPdfTitle("de", { kind: "weekly" }) })),
    );
    assert.ok(page.includes("Mo., 03.08."));
    assert.ok(page.includes("So., 09.08."));
    assert.ok(page.includes("03.08.2026 bis 09.08.2026"));
    assert.ok(page.includes("In dieser Woche wurde keine Zeit erfasst."));
  });
});
