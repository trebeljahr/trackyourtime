import { dayKeyInZone, entryDurationSec, formatDuration, type DetailedReportResult, type SummaryReportResult, type WeeklyReportResult } from "@starter/shared";
import type { CsvColumn, CsvRow } from "./report-csv.js";
// ── CSV serialization ────────────────────────────────────────────────

/** Hours as a decimal, 2dp — what people paste into an invoice. */
const decimalHours = (seconds: number): number =>
  Math.round((seconds / 3600) * 100) / 100;

/**
 * The money columns of the report CSVs. A file is not a page: once it has
 * left the machine there is no dash to explain a blank, and a blank Amount
 * column sums to zero in every spreadsheet. So when a report's money is
 * withheld the COLUMNS go, not merely the values — the header set itself says
 * "this export carries no money".
 */
const MONEY_CSV_KEYS: ReadonlySet<string> = new Set([
  "rate",
  "amount",
  "currency",
]);

const withoutMoneyColumns = (
  columns: readonly CsvColumn[],
  moneyVisible: boolean,
): CsvColumn[] =>
  moneyVisible
    ? [...columns]
    : columns.filter((column) => !MONEY_CSV_KEYS.has(column.key));

const ALL_SUMMARY_COLUMNS: readonly CsvColumn[] = [
  { key: "label", header: "Group" },
  { key: "duration", header: "Duration" },
  { key: "hours", header: "Hours" },
  { key: "seconds", header: "Seconds" },
  { key: "billableHours", header: "Billable hours" },
  { key: "billableSeconds", header: "Billable seconds" },
  { key: "amount", header: "Amount" },
  { key: "currency", header: "Currency" },
];

/** The summary CSV header set for a report whose money is or is not visible. */
export const summaryCsvColumns = (moneyVisible: boolean): CsvColumn[] =>
  withoutMoneyColumns(ALL_SUMMARY_COLUMNS, moneyVisible);

/** Exported for the unit tests. */
export const summaryCsvRows = (result: SummaryReportResult): CsvRow[] =>
  result.groups.flatMap((group): CsvRow[] => {
    const time = {
      label: group.label,
      duration: formatDuration(group.seconds, "hms"),
      hours: decimalHours(group.seconds),
      seconds: group.seconds,
      billableHours: decimalHours(group.billableSec),
      billableSeconds: group.billableSec,
    };
    if (!result.moneyVisible) return [time];
    const amounts = group.amounts ?? [{ amount: group.amount ?? 0, currency: group.currency || result.currency }];
    if (amounts.length === 0) return [{ ...time, amount: 0, currency: group.currency || result.currency }];
    // Additional currency rows carry no time: summing the CSV preserves both
    // duration totals and independent monetary totals without conversion.
    return amounts.map((bucket, index) => ({
      ...(index === 0 ? time : { label: group.label }),
      amount: bucket.amount,
      currency: bucket.currency,
    }));
  });

const ALL_DETAILED_COLUMNS: readonly CsvColumn[] = [
  { key: "date", header: "Date" },
  { key: "start", header: "Start" },
  { key: "end", header: "End" },
  { key: "duration", header: "Duration" },
  { key: "hours", header: "Hours" },
  { key: "seconds", header: "Seconds" },
  { key: "description", header: "Description" },
  { key: "project", header: "Project" },
  { key: "client", header: "Client" },
  { key: "task", header: "Task" },
  { key: "billable", header: "Billable" },
  { key: "rate", header: "Rate" },
  { key: "amount", header: "Amount" },
  { key: "currency", header: "Currency" },
  { key: "source", header: "Source" },
  { key: "id", header: "Id" },
];

/** The detailed CSV header set for a report whose money is or is not visible. */
export const detailedCsvColumns = (moneyVisible: boolean): CsvColumn[] =>
  withoutMoneyColumns(ALL_DETAILED_COLUMNS, moneyVisible);

/** Exported for the unit tests. */
export const detailedCsvRows = (
  result: DetailedReportResult,
  timeZone: string,
  /** The instant a running entry is measured to; one per export. */
  nowMs: number = Date.now(),
): CsvRow[] => {
  return result.entries.map((entry) => {
    const seconds = entryDurationSec(entry, nowMs);
    const money: CsvRow = result.moneyVisible
      ? {
          rate: entry.hourlyRate,
          amount: entry.amount,
          currency: entry.currency,
        }
      : {};
    return {
      ...money,
      date: dayKeyInZone(Date.parse(entry.start), timeZone),
      start: entry.start,
      end: entry.end,
      duration: formatDuration(seconds, "hms"),
      hours: decimalHours(seconds),
      seconds,
      description: entry.description,
      project: entry.projectName,
      client: entry.clientName,
      task: entry.taskName,
      billable: entry.billable ? "yes" : "no",
      source: entry.source,
      id: entry.id,
    };
  });
};

export const weeklyCsvColumns = (result: WeeklyReportResult): CsvColumn[] => [
  { key: "label", header: "Project / Task" },
  ...result.days.map((day) => ({ key: `day:${day}`, header: day })),
  { key: "total", header: "Total" },
];

export const weeklyCsvRows = (result: WeeklyReportResult): CsvRow[] =>
  result.rows.map((row) => {
    const csvRow: CsvRow = {
      label: row.label,
      total: decimalHours(row.totalSec),
    };
    result.days.forEach((day, index) => {
      csvRow[`day:${day}`] = decimalHours(row.daySeconds[index] ?? 0);
    });
    return csvRow;
  });

