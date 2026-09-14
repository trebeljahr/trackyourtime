/**
 * The workspace's entries as CSV — the file `data.exportCsv` hands out and
 * this app's own importer reads back.
 *
 * Never localised, and deliberately given no locale to be localised WITH: the
 * header row is the contract `services/import/columns.ts` matches against, and
 * the values (`Yes`/`No`, `hh:mm:ss`, a dot-decimal rate) are what spreadsheets
 * and the importer parse. A German header row would be a file the round trip
 * no longer recognises, and a German user is exactly as likely to re-import
 * it. `workspace-csv.test.ts` pins the shape.
 */
import type { WorkspaceExportEntry } from "@starter/shared";
import { toCsv, type CsvColumn, type CsvRow } from "./csv.js";

/** The CSV this app writes — and the one its own importer reads back. */
export const WORKSPACE_CSV_COLUMNS: readonly CsvColumn[] = [
  { key: "start", header: "Start" },
  { key: "end", header: "End" },
  { key: "duration", header: "Duration" },
  { key: "description", header: "Description" },
  { key: "project", header: "Project" },
  { key: "client", header: "Client" },
  { key: "task", header: "Task" },
  { key: "tags", header: "Tags" },
  { key: "billable", header: "Billable" },
  { key: "rate", header: "Rate" },
  { key: "currency", header: "Currency" },
];

const hms = (seconds: number): string => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(rest)}`;
};

/** One export row per entry, in the importer's value shapes. */
export function workspaceCsvRow(entry: WorkspaceExportEntry): CsvRow {
  return {
    start: entry.start,
    end: entry.end ?? "",
    duration: hms(entry.durationSec),
    description: entry.description,
    project: entry.projectName ?? "",
    client: entry.clientName ?? "",
    task: entry.taskName ?? "",
    tags: entry.tagNames.join(", "),
    billable: entry.billable ? "Yes" : "No",
    // Blank for a rate-less entry and for a redacted one alike — the
    // Rate COLUMN stays either way, because the header set is the shape
    // this app's own importer reads back, and dropping a column would
    // change the file's shape depending on who exported it.
    rate: entry.hourlyRate ?? "",
    currency: entry.currency,
  };
}

/** The whole file. */
export function workspaceEntriesCsv(entries: readonly WorkspaceExportEntry[]): string {
  return toCsv(entries.map(workspaceCsvRow), [...WORKSPACE_CSV_COLUMNS]);
}
