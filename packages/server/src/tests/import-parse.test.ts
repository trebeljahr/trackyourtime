// The importer is written against column SHAPES rather than against the
// exporters that produce them, so these fixtures are shapes: split date and
// time columns, one-cell instants, a day and a number of hours, and this app's
// own export read back. Anything an unanticipated file does is a variation on
// one of them.
import assert from "node:assert/strict";
import test from "node:test";
import {
  parseImportFile,
  workspaceJsonCatalog,
} from "../services/import/parse.js";
import { readDelimitedFile, sniffDelimiter } from "../services/import/delimited.js";

const parse = (text: string, timeZone = "UTC") =>
  parseImportFile(text, { timeZone });

const roleOf = (
  columns: readonly { header: string; role: string }[],
  header: string,
): string | undefined => columns.find((c) => c.header === header)?.role;

test("split date and time columns place an entry, tags and all", () => {
  const file = [
    "Project,Client,Description,Task,Tags,Billable,Start Date,Start Time,End Date,End Time,Duration (h)",
    'trackyourtime,Internal,"Wrote the importer",Imports,"deep work, tooling",Yes,2026-08-21,09:00:00,2026-08-21,10:30:00,01:30:00',
  ].join("\n");

  const result = parse(file);
  assert.equal(result.shape, "start-end");
  assert.equal(result.rows.length, 1);
  const row = result.rows[0];
  assert.ok(row);
  assert.equal(row.start, "2026-08-21T09:00:00.000Z");
  assert.equal(row.end, "2026-08-21T10:30:00.000Z");
  assert.equal(row.durationSec, 5400);
  assert.equal(row.description, "Wrote the importer");
  assert.equal(row.projectName, "trackyourtime");
  assert.equal(row.clientName, "Internal");
  assert.equal(row.taskName, "Imports");
  assert.deepEqual(row.tagNames, ["deep work", "tooling"]);
  assert.equal(row.billable, true);
});

test("wall-clock cells are read in the zone the import was given", () => {
  const file = [
    "Description,Project,Start Date,Start Time,End Time",
    "Standup,trackyourtime,2026-08-21,09:00,09:15",
  ].join("\n");

  const result = parse(file, "Europe/Berlin");
  assert.equal(result.rows[0]?.start, "2026-08-21T07:00:00.000Z");
  assert.equal(result.rows[0]?.durationSec, 900);
});

test("one-cell instants need no date column at all", () => {
  const file = [
    "Description,Project,Start,End",
    "Refactor,trackyourtime,2026-08-21T09:00:00Z,2026-08-21T11:00:00Z",
  ].join("\n");

  const result = parse(file);
  assert.equal(result.shape, "start-end");
  assert.equal(roleOf(result.columns, "Start"), "start");
  assert.equal(roleOf(result.columns, "End"), "end");
  assert.equal(result.rows[0]?.durationSec, 7200);
});

test("a start and a duration is enough; the end is derived", () => {
  const file = [
    "Description,Project,Start,Duration",
    "Review,trackyourtime,2026-08-21T09:00:00Z,0:45",
  ].join("\n");

  const result = parse(file);
  assert.equal(result.shape, "start-duration");
  assert.equal(result.rows[0]?.end, "2026-08-21T09:45:00.000Z");
});

test("a day and a number of hours stacks entries from the working-day start", () => {
  const file = [
    "Date,Client,Project,Task,Notes,Hours,Billable",
    "2026-08-21,Internal,trackyourtime,Imports,Mapping columns,3.5,Yes",
    "2026-08-21,Internal,trackyourtime,Imports,Duplicate check,1.5,Yes",
    "2026-08-22,Internal,trackyourtime,Imports,Undo,2,No",
  ].join("\n");

  const result = parse(file);
  assert.equal(result.shape, "date-duration");
  assert.equal(result.rows.length, 3);
  // Back-to-back from 09:00, so the day reads plausibly instead of piling
  // every entry onto midnight.
  assert.equal(result.rows[0]?.start, "2026-08-21T09:00:00.000Z");
  assert.equal(result.rows[0]?.end, "2026-08-21T12:30:00.000Z");
  assert.equal(result.rows[1]?.start, "2026-08-21T12:30:00.000Z");
  assert.equal(result.rows[1]?.end, "2026-08-21T14:00:00.000Z");
  // A new day restarts the cursor.
  assert.equal(result.rows[2]?.start, "2026-08-22T09:00:00.000Z");
  assert.equal(result.rows[2]?.billable, false);
});

test("an end time before the start time is read as an overnight entry", () => {
  const file = [
    "Description,Start Date,Start Time,End Time",
    "Deploy window,2026-08-21,23:00,01:00",
  ].join("\n");

  const result = parse(file);
  assert.equal(result.rows[0]?.end, "2026-08-22T01:00:00.000Z");
  assert.equal(result.rows[0]?.durationSec, 7200);
});

test("an end DATE column is believed instead of the overnight guess", () => {
  const file = [
    "Description,Start Date,Start Time,End Date,End Time",
    "Deploy window,2026-08-21,23:00,2026-08-21,23:30",
  ].join("\n");

  assert.equal(parse(file).rows[0]?.durationSec, 1800);
});

test("semicolon files with comma decimals are read as one field per column", () => {
  const file = [
    "Beschreibung;Projekt;Start;Dauer",
    "Doku;trackyourtime;21.08.2026 09:00;1,5",
  ].join("\n");

  const result = parse(file);
  assert.equal(result.delimiter, ";");
  assert.equal(result.rows[0]?.durationSec, 5400);
});

test("quoted fields keep their commas and newlines", () => {
  const file = [
    "Description,Project,Start,End",
    '"Rewrote the parser, twice",trackyourtime,2026-08-21T09:00:00Z,2026-08-21T10:00:00Z',
    '"Wrote it\nagain",trackyourtime,2026-08-21T11:00:00Z,2026-08-21T12:00:00Z',
  ].join("\n");

  const result = parse(file);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0]?.description, "Rewrote the parser, twice");
  assert.equal(result.rows[1]?.description, "Wrote it\nagain");
});

test("a doubled quote inside a quoted field is one quote", () => {
  const rows = readDelimitedFile('a,b\n"say ""hi""",2').rows;
  assert.deepEqual(rows[0], ['say "hi"', "2"]);
});

test("the delimiter is sniffed from structure, not from the first comma", () => {
  // A description full of commas must not outvote the real separator.
  const tabbed = "Description\tProject\tStart\nx, y, z\tp\t2026-08-21T09:00:00Z";
  assert.equal(sniffDelimiter(tabbed), "\t");
});

test("identical rows are kept but marked, so nothing is silently dropped", () => {
  const line = "Standup,trackyourtime,2026-08-21T09:00:00Z,2026-08-21T09:15:00Z";
  const file = ["Description,Project,Start,End", line, line].join("\n");

  const result = parse(file);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0]?.duplicateOf, null);
  assert.equal(result.rows[1]?.duplicateOf, "file");
  assert.equal(result.issues[0]?.code, "duplicate-in-file");
});

test("a row that cannot be placed becomes one issue, not a failed import", () => {
  const file = [
    "Description,Project,Start,End",
    "Good,trackyourtime,2026-08-21T09:00:00Z,2026-08-21T10:00:00Z",
    "Bad,trackyourtime,whenever,2026-08-21T10:00:00Z",
    "Backwards,trackyourtime,2026-08-21T12:00:00Z,2026-08-21T11:00:00Z",
  ].join("\n");

  const result = parse(file);
  assert.equal(result.rows.length, 1);
  assert.equal(result.totalRows, 3);
  assert.deepEqual(
    result.issues.map((issue) => issue.code),
    ["unparsable-start", "nonpositive-duration"],
  );
  // Row numbers are the file's own, so an issue can be found in a spreadsheet.
  assert.deepEqual(
    result.issues.map((issue) => issue.row),
    [2, 3],
  );
});

test("a file with no time information at all is refused as unusable", () => {
  const file = ["Description,Project", "Something,trackyourtime"].join("\n");
  const result = parse(file);
  assert.equal(result.shape, "unusable");
  assert.equal(result.rows.length, 0);
});

test("a column pointed somewhere by hand wins over detection", () => {
  const file = [
    "Notes,Thing,Start,End",
    "Standup,trackyourtime,2026-08-21T09:00:00Z,2026-08-21T09:15:00Z",
  ].join("\n");

  const detected = parse(file);
  assert.equal(roleOf(detected.columns, "Thing"), "ignored");

  const overridden = parseImportFile(file, {
    timeZone: "UTC",
    overrides: new Map([[1, "project"]]),
  });
  assert.equal(overridden.rows[0]?.projectName, "trackyourtime");
  assert.equal(
    overridden.columns.find((column) => column.header === "Thing")?.overridden,
    true,
  );
});

test("this app's own CSV export is read back by the same detection", () => {
  const file = [
    "Start,End,Duration,Description,Project,Client,Task,Tags,Billable,Rate,Currency",
    '2026-08-21T09:00:00.000Z,2026-08-21T10:30:00.000Z,01:30:00,Wrote the importer,trackyourtime,Internal,Imports,"deep work, tooling",Yes,90,EUR',
  ].join("\n");

  const result = parse(file);
  assert.equal(result.shape, "start-end");
  const row = result.rows[0];
  assert.ok(row);
  assert.equal(row.durationSec, 5400);
  assert.equal(row.hourlyRate, 90);
  assert.deepEqual(row.tagNames, ["deep work", "tooling"]);
});

test("this app's own JSON export is read back losslessly", () => {
  const file = JSON.stringify({
    version: 1,
    exportedAt: "2026-08-22T00:00:00.000Z",
    workspaceId: "workspace-1",
    currency: "EUR",
    clients: [{ name: "Internal", color: "#64748b", archived: false }],
    projects: [],
    tasks: [],
    tags: [],
    entries: [
      {
        description: "Wrote the importer",
        clientName: "Internal",
        projectName: "trackyourtime",
        taskName: "Imports",
        tagNames: ["deep work"],
        billable: true,
        start: "2026-08-21T09:00:00.000Z",
        end: "2026-08-21T10:30:00.000Z",
        durationSec: 5400,
        hourlyRate: 90,
        currency: "EUR",
        timeZone: "Europe/Berlin",
      },
    ],
  });

  const result = parse(file);
  assert.equal(result.format, "workspace-json");
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]?.projectName, "trackyourtime");
  assert.equal(result.rows[0]?.hourlyRate, 90);
});

test("a running timer in a JSON export is reported, not imported as zero-length", () => {
  const file = JSON.stringify({
    version: 1,
    entries: [
      {
        description: "Still going",
        start: "2026-08-21T09:00:00.000Z",
        end: null,
        durationSec: 0,
        tagNames: [],
      },
    ],
  });

  const result = parse(file);
  assert.equal(result.rows.length, 0);
  assert.equal(result.issues[0]?.code, "nonpositive-duration");
});

test("a JSON catalog is read as values, not trusted as types", () => {
  // These rows are written straight into mongoose. A string where a Number
  // path is expected does not fail the parse, it fails the WRITE — halfway
  // through, after the batch and part of the catalog already exist.
  const doc = workspaceJsonCatalog(
    JSON.stringify({
      version: 2,
      entries: [],
      clients: [{ name: "Internal", color: "#111111" }],
      projects: [
        {
          name: "X",
          budgetAmount: "lots",
          budgetCurrency: "USD",
          hourlyRate: "ninety",
          estimatedHours: -4,
          idleBehavior: "explode",
        },
        // Nameless: everything in this format is addressed by name, so there
        // is nothing this row could ever be matched to.
        { name: "   ", hourlyRate: 10 },
      ],
      tasks: [
        // From a file older than task colors, and — as every exporter has
        // written it — with no project beside it. Both are kept.
        { name: "Imports", done: false },
        { name: "   " },
        { name: "Review", color: 7 },
      ],
      tags: [{ name: "deep work", color: 42 }],
    }),
  );

  assert.ok(doc);
  const project = doc.projects[0];
  assert.equal(doc.projects.length, 1);
  assert.ok(project);
  assert.strictEqual(project.budgetAmount, null);
  // The invariant `budgetWrite` exists to hold: a currency with no amount
  // renders a budget for a target that does not exist.
  assert.strictEqual(project.budgetCurrency, null);
  assert.strictEqual(project.hourlyRate, null);
  assert.strictEqual(project.estimatedHours, null);
  assert.strictEqual(project.idleBehavior, null);
  // Tasks are workspace-wide: a name is the whole address. The reader used to
  // demand a `projectName` the exporter never wrote, dropping every task.
  assert.deepEqual(
    doc.tasks.map((task) => task.name),
    ["Imports", "Review"],
  );
  assert.strictEqual(doc.tasks[0]?.color, "");
  assert.strictEqual(doc.tasks[1]?.color, "");
  // An unreadable color is blank rather than the number 42, which the model's
  // required String would take and render as a swatch nobody chose.
  assert.strictEqual(doc.tags[0]?.color, "");
});

test("a valid catalog survives the read unchanged", () => {
  // The guard above must not be a quiet coercion of good files.
  const doc = workspaceJsonCatalog(
    JSON.stringify({
      version: 2,
      entries: [],
      projects: [
        {
          name: "trackyourtime",
          color: "#222222",
          clientName: "Internal",
          billableDefault: false,
          hourlyRate: 120,
          estimatedHours: 40,
          budgetAmount: 5000,
          budgetCurrency: "EUR",
          idleBehavior: "stop",
          archived: true,
        },
      ],
    }),
  );

  assert.deepEqual(doc?.projects[0], {
    name: "trackyourtime",
    color: "#222222",
    clientName: "Internal",
    billableDefault: false,
    hourlyRate: 120,
    estimatedHours: 40,
    budgetAmount: 5000,
    budgetCurrency: "EUR",
    idleBehavior: "stop",
    archived: true,
  });
});

test("a redacted export says so on the way back in", () => {
  // The stamp only means something if the importer reads it: a file whose
  // rates are all null is otherwise indistinguishable from a workspace that
  // never billed anything, and the preview cannot warn about either.
  const redacted = workspaceJsonCatalog(
    JSON.stringify({ version: 2, moneyRedacted: true, entries: [] }),
  );
  assert.equal(redacted?.moneyRedacted, true);

  // Absent, and anything that is not literally `true`, is "this file makes no
  // such claim" — which is what an ordinary export looks like.
  const plain = workspaceJsonCatalog(
    JSON.stringify({ version: 2, entries: [] }),
  );
  assert.equal(plain?.moneyRedacted, undefined);
  const bogus = workspaceJsonCatalog(
    JSON.stringify({ version: 2, moneyRedacted: "yes", entries: [] }),
  );
  assert.equal(bogus?.moneyRedacted, undefined);
});
