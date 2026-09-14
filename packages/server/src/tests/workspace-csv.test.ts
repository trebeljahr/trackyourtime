// The CSV export is the importer's contract, so it is never localised.
//
// A German user exports, edits a rate in a spreadsheet and imports the file
// back — and the importer matches columns by their English header names and
// parses "Yes"/"No" and "hh:mm:ss". `workspaceEntriesCsv` is therefore given
// nothing to localise WITH: it takes the entries and no locale, and every
// other export surface's German text (the report PDF's column labels) must not
// reach it.
import assert from "node:assert/strict";
import test from "node:test";
import type { WorkspaceExportEntry } from "@starter/shared";
import { serverMessages } from "../i18n/index.js";
import { parseImportFile } from "../services/import/parse.js";
import { WORKSPACE_CSV_COLUMNS, workspaceEntriesCsv } from "../services/workspace-csv.js";

const BOM = "﻿";

const ENGLISH_HEADER =
  "Start,End,Duration,Description,Project,Client,Task,Tags,Billable,Rate,Currency";

const entry: WorkspaceExportEntry = {
  description: "Wrote the importer",
  clientName: "Internal",
  projectName: "trackyourtime",
  taskName: "Imports",
  tagNames: ["deep work", "tooling"],
  billable: true,
  start: "2026-08-21T09:00:00.000Z",
  end: "2026-08-21T10:30:00.000Z",
  durationSec: 5400,
  hourlyRate: 90.5,
  currency: "EUR",
  timeZone: "Europe/Berlin",
};

const headerOf = (csv: string): string => {
  assert.ok(csv.startsWith(BOM));
  return csv.slice(BOM.length).split("\r\n")[0] ?? "";
};

test("the export takes no locale — there is nothing to localise it with", () => {
  assert.equal(workspaceEntriesCsv.length, 1);
});

test("CSV export headers stay the importer's English shape whatever the user's locale", () => {
  const csv = workspaceEntriesCsv([entry]);
  assert.equal(headerOf(csv), ENGLISH_HEADER);
  assert.deepEqual(
    WORKSPACE_CSV_COLUMNS.map((column) => column.header).join(","),
    ENGLISH_HEADER,
  );

  // The German words a localised export would have used appear nowhere.
  const german = serverMessages.de.report.columns;
  for (const word of [german.date, german.duration, german.description, german.billable]) {
    assert.ok(!csv.includes(word), `German "${word}" leaked into the CSV`);
  }

  // Values are the machine shapes: Yes/No, hh:mm:ss, a dot decimal.
  const row = csv.slice(BOM.length).split("\r\n")[1] ?? "";
  assert.ok(row.includes(",01:30:00,"));
  assert.ok(row.includes(",Yes,90.5,EUR"));
});

test("the importer reads the export back, column for column", () => {
  const result = parseImportFile(workspaceEntriesCsv([entry, { ...entry, billable: false }]), {
    timeZone: "Europe/Berlin",
  });
  assert.equal(result.shape, "start-end");
  assert.equal(result.rows.length, 2);
  const [first, second] = result.rows;
  assert.ok(first && second);
  assert.equal(first.durationSec, 5400);
  assert.equal(first.hourlyRate, 90.5);
  assert.equal(first.billable, true);
  assert.equal(second.billable, false);
  assert.deepEqual(first.tagNames, ["deep work", "tooling"]);
  // Every column but Currency is claimed. The CSV importer does not read a
  // currency column today; the header stays so the file shape never changes.
  for (const column of result.columns) {
    if (column.header === "Currency") continue;
    assert.notEqual(column.role, "ignored", `the importer ignored "${column.header}"`);
  }
});
