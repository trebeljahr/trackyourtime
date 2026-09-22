// The round trip of a workspace export's NON-entry half: settings, pins, and
// the invoices that deliberately do not come back.
//
// All of it is pure — the reading (`workspaceJsonCatalog`) and the deciding
// (`settingsRestoreFields`, `planFavoriteRestore`) — so the rules that would
// otherwise only be observable as a wrong workspace after an import are
// checked here without a database.
import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_FAVORITES,
  type QuickStart,
  type WorkspaceExport,
  type WorkspaceExportFavorite,
} from "@starter/shared";
import { workspaceJsonCatalog } from "../services/import/parse.js";
import {
  planFavoriteRestore,
  settingsRestoreFields,
} from "../services/import/restore.js";

const v2 = (overrides: Partial<WorkspaceExport> = {}): WorkspaceExport => ({
  version: 2,
  exportedAt: "2026-09-07T10:00:00.000Z",
  workspaceId: "workspace-1",
  currency: "CHF",
  settings: { defaultHourlyRate: 95, weekStartsOn: 0 },
  clients: [{ name: "Internal", color: "#111111", archived: false }],
  projects: [
    {
      name: "trackyourtime",
      color: "#222222",
      clientName: "Internal",
      billableDefault: true,
      hourlyRate: 120,
      estimatedHours: 40,
      budgetAmount: 5_000,
      budgetCurrency: "CHF",
      idleBehavior: null,
      archived: false,
    },
  ],
  tasks: [
    { name: "Imports", color: "#333333", archived: false },
  ],
  tags: [{ name: "deep work", color: "#444444", archived: false }],
  entries: [
    {
      description: "Wrote the exporter",
      clientName: "Internal",
      projectName: "trackyourtime",
      taskName: "Imports",
      tagNames: ["deep work"],
      billable: true,
      start: "2026-08-21T09:00:00.000Z",
      end: "2026-08-21T10:30:00.000Z",
      durationSec: 5400,
      hourlyRate: 120,
      currency: "CHF",
      timeZone: "Europe/Zurich",
    },
  ],
  favorites: [
    {
      description: "Stand-up",
      clientName: "Internal",
      projectName: "trackyourtime",
      taskName: null,
      billable: false,
      order: 0,
    },
  ],
  invoices: [
    {
      number: "2026-014",
      clientName: "Internal",
      status: "sent",
      issueDate: "2026-09-01T00:00:00.000Z",
      dueDate: "2026-09-15T00:00:00.000Z",
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-31T23:59:59.999Z",
      groupBy: "project",
      lineItems: [
        {
          label: "trackyourtime",
          projectName: "trackyourtime",
          taskName: null,
          seconds: 5400,
          hours: 1.5,
          hourlyRate: 120,
          currency: "CHF",
          amount: 180,
        },
      ],
      subtotal: 180,
      taxRate: 19,
      taxAmount: 34.2,
      total: 214.2,
      currency: "CHF",
      notes: null,
      createdAt: "2026-09-01T09:00:00.000Z",
    },
  ],
  ...overrides,
});

const read = (document: unknown): WorkspaceExport => {
  const parsed = workspaceJsonCatalog(JSON.stringify(document));
  assert.ok(parsed, "the document should read as one of our exports");
  return parsed;
};

// ── the version envelope ─────────────────────────────────────────────

test("a v2 document reports version 2, not the literal a reader was born with", () => {
  // The trap this guards: a hardcoded `version: 1` in the reader makes every
  // v2 file claim to be v1, and anything branching on it branches wrong with
  // no error to notice.
  assert.equal(read(v2()).version, 2);
});

test("a v1 document still reads, and its missing sections stay missing", () => {
  const legacy = {
    version: 1,
    exportedAt: "2026-01-01T00:00:00.000Z",
    workspaceId: "workspace-0",
    currency: "EUR",
    clients: [],
    projects: [],
    tasks: [],
    tags: [],
    entries: v2().entries,
  };

  const parsed = read(legacy);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.entries.length, 1);
  // Absent, not empty. "This workspace had no pins" and "this file predates
  // pins" are different claims, and only the version tells them apart.
  assert.equal(parsed.settings, undefined);
  assert.equal(parsed.favorites, undefined);
  assert.equal(parsed.invoices, undefined);
});

test("an empty section stays empty rather than collapsing into absent", () => {
  const parsed = read(v2({ favorites: [], invoices: [] }));
  assert.deepEqual(parsed.favorites, []);
  assert.deepEqual(parsed.invoices, []);
});

test("a file written by a newer version still yields its entries", () => {
  // The format outlives the database it came from, so a future file is read
  // for what is understood rather than rejected for what is not.
  const parsed = read({ ...v2(), version: 9, somethingNew: { nope: true } });
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.favorites?.length, 1);
});

// ── settings ─────────────────────────────────────────────────────────

test("settings round-trip, with the currency read from where it lives", () => {
  const fields = settingsRestoreFields(read(v2()));
  assert.deepEqual(fields, {
    defaultHourlyRate: 95,
    weekStartsOn: 0,
    // Top-level, never duplicated inside `settings` — two copies of one fact
    // can disagree and nothing would detect it.
    currency: "CHF",
  });
});

test("a redacted default rate is left out, never written as 0", () => {
  const document = read(v2({ settings: { defaultHourlyRate: null, weekStartsOn: 1 } }));
  const fields = settingsRestoreFields(document);

  assert.equal("defaultHourlyRate" in fields, false);
  assert.notStrictEqual(fields.defaultHourlyRate, 0);
  // The rest of the section is still stated, so a redacted backup restores
  // everything about the workspace except the money it could not carry.
  assert.equal(fields.weekStartsOn, 1);
  assert.equal(fields.currency, "CHF");
});

test("a rate of 0 in the file is a real rate and is written through", () => {
  // The mirror of the test above: `null` is "not said", `0` is "free", and
  // conflating them silently reprices somebody's history.
  const fields = settingsRestoreFields(
    read(v2({ settings: { defaultHourlyRate: 0, weekStartsOn: 1 } })),
  );
  assert.strictEqual(fields.defaultHourlyRate, 0);
});

test("a v1 file has no settings section, but its currency is still restorable", () => {
  const parsed = read(v2());
  const legacy: WorkspaceExport = { ...parsed, version: 1 };
  delete legacy.settings;
  // Currency has been at the top level since v1, and it is what every entry
  // written after the restore is denominated in — dropping it would leave a
  // restored backup priced in whatever the destination happened to default to.
  assert.deepEqual(settingsRestoreFields(legacy), { currency: "CHF" });
});

// ── favorites ────────────────────────────────────────────────────────

const pin = (
  overrides: Partial<WorkspaceExportFavorite> = {},
): WorkspaceExportFavorite => ({
  description: "Stand-up",
  clientName: "Internal",
  projectName: "trackyourtime",
  taskName: null,
  billable: false,
  order: 0,
  ...overrides,
});

/** A destination workspace holding one project with one task. */
const resolveKnown = (favorite: WorkspaceExportFavorite) => ({
  projectId: favorite.projectName === "trackyourtime" ? "project-1" : null,
  taskId: favorite.taskName === "Imports" ? "task-1" : null,
});

test("pins resolve by name and land after the pins already there", () => {
  const existing: QuickStart[] = [
    { description: "Email", projectId: null, taskId: null, billable: false },
  ];

  const plan = planFavoriteRestore({
    favorites: [pin({ order: 5 }), pin({ description: "Review", order: 9 })],
    existing,
    resolve: resolveKnown,
  });

  assert.equal(plan.create.length, 2);
  assert.equal(plan.create[0]?.projectId, "project-1");
  // Appended and dense from the caller's next slot: the file's own numbers
  // describe a row this workspace knows nothing about.
  assert.deepEqual(
    plan.create.map((favorite) => favorite.order),
    [1, 2],
  );
});

test("the file's order decides the sequence even though its numbers are dropped", () => {
  const plan = planFavoriteRestore({
    favorites: [
      pin({ description: "Third", order: 30 }),
      pin({ description: "First", order: 10 }),
      pin({ description: "Second", order: 20 }),
    ],
    existing: [],
    resolve: resolveKnown,
  });

  assert.deepEqual(
    plan.create.map((favorite) => favorite.description),
    ["First", "Second", "Third"],
  );
});

test("a pin the caller already has is counted, not duplicated", () => {
  const existing: QuickStart[] = [
    {
      description: "Stand-up",
      projectId: "project-1",
      taskId: null,
      billable: false,
    },
  ];

  const plan = planFavoriteRestore({
    favorites: [pin(), pin()],
    existing,
    resolve: resolveKnown,
  });

  // One against the existing row, one against the other copy in the file —
  // re-importing the same backup must not double anybody's row.
  assert.equal(plan.create.length, 0);
  assert.equal(plan.duplicates, 2);
});

test("a pin whose project is missing is kept, not dropped", () => {
  const plan = planFavoriteRestore({
    favorites: [pin({ projectName: "Gone", taskName: "Imports" })],
    existing: [],
    resolve: resolveKnown,
  });

  assert.equal(plan.create.length, 1);
  assert.strictEqual(plan.create[0]?.projectId, null);
  // A task without its project addresses nothing: task names are unique
  // within a project, so the id would be a guess.
  assert.strictEqual(plan.create[0]?.taskId, null);
  assert.equal(plan.create[0]?.description, "Stand-up");
});

test("the row's ceiling is respected, and the overflow is reported", () => {
  const favorites = Array.from({ length: MAX_FAVORITES + 5 }, (_, index) =>
    pin({ description: `Pin ${index}`, order: index }),
  );

  const plan = planFavoriteRestore({
    favorites,
    existing: [
      { description: "Email", projectId: null, taskId: null, billable: false },
    ],
    resolve: resolveKnown,
  });

  assert.equal(plan.create.length, MAX_FAVORITES - 1);
  assert.equal(plan.overflow, 6);
  const last = plan.create.at(-1);
  assert.equal(last?.order, MAX_FAVORITES - 1);
});

// ── invoices ─────────────────────────────────────────────────────────

test("invoices survive the file but have no restore path at all", () => {
  const parsed = read(v2());

  // Exported faithfully — the record is the point.
  assert.equal(parsed.invoices?.length, 1);
  assert.equal(parsed.invoices?.[0]?.total, 214.2);

  // And export-only, for the reasons on `WorkspaceExportInvoice`: no entry in
  // this format has an identity, so a restored invoice could not carry the
  // double-billing guard, and `number` is unique per workspace in the
  // database. Nothing here maps an invoice onto a write, and the parsed
  // document is the only thing a commit reads.
  assert.equal("entryIds" in (parsed.invoices?.[0] ?? {}), false);
});
