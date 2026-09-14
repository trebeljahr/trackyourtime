// Getting a whole history in, and getting a whole workspace out.
//
// Import is an onboarding feature first: somebody arriving with years of
// tracked time elsewhere keeps their reports instead of starting from zero.
// Export is its mirror, and the reason the import is worth trusting — data
// that can leave is data nobody is locked into.
//
// Three rules shape everything here:
//
//  - `analyze` and `commit` take the SAME input and run the SAME parser. The
//    preview is a description, never a token: nothing a client sends back is
//    authority to write, so a tampered preview cannot make the commit write
//    something the user never saw.
//  - Duplicates are detected, not assumed. Re-importing an overlapping range
//    is the normal way a backfill is finished, so the second pass has to
//    recognise what the first one already wrote.
//  - Every import is one batch, and a batch can be undone. A wrong column
//    mapping is discovered after the import, not before it.
import { TRPCError } from "@trpc/server";
import {
  IMPORT_PREVIEW_ISSUES,
  IMPORT_PREVIEW_ROWS,
  MAX_IMPORT_ROWS,
  WORKSPACE_EXPORT_VERSION,
  canUseInvoices,
  importInputSchema,
  importUndoSchema,
  issuerSnapshot,
  normalizeBusinessProfile,
  normalizeClientBilling,
  normalizeRecipient,
  resolveHourlyRate,
  resolveTimeZone,
  workspaceExportSchema,
  type ClientBilling,
  type ImportBatchSummary,
  type ImportColumnRole,
  type ImportInput,
  type ImportPreview,
  type ImportResult,
  type ImportRow,
  type ImportSections,
  type ImportUndoResult,
  type IdleBehavior,
  type QuickStart,
  type Visibility,
  type WorkspaceExport,
  type WorkspaceExportEntry,
  type WorkspaceExportFavorite,
  type WorkspaceExportInfo,
  type WorkspaceExportInvoice,
  type WorkspaceRole,
} from "@starter/shared";
import {
  BusinessProfileModel,
  saveBusinessProfile,
} from "../../models/BusinessProfile.js";
import { Client, DEFAULT_CLIENT_COLOR } from "../../models/Client.js";
import { Favorite } from "../../models/Favorite.js";
import { ImportBatch, toClientImportBatch } from "../../models/ImportBatch.js";
import { Invoice } from "../../models/Invoice.js";
import { Project, DEFAULT_PROJECT_COLOR } from "../../models/Project.js";
import { Tag, DEFAULT_TAG_COLOR } from "../../models/Tag.js";
import { Task } from "../../models/Task.js";
import { TimeEntry } from "../../models/TimeEntry.js";
import {
  WorkspaceSettingsModel,
  getOrCreateWorkspaceSettings,
} from "../../models/Settings.js";
import { authorScopeFilter } from "../../models/WorkspaceMember.js";
import {
  importFingerprint,
  parseImportFile,
  workspaceJsonCatalog,
  type ParsedFile,
} from "../../services/import/parse.js";
import {
  planFavoriteRestore,
  settingsRestoreFields,
} from "../../services/import/restore.js";
import { csvFilename } from "../../services/csv.js";
import { workspaceEntriesCsv } from "../../services/workspace-csv.js";
import {
  exportKeepsMoney,
  redactExportMoney,
} from "../../services/export-redaction.js";
import { publishSync, publishToUser } from "../../ws/sync.js";
import {
  assertObjectId,
  pickCatalogColor,
  PROJECT_COLOR_OFFSET,
} from "./clients.js";
import { router, workspaceProcedure } from "../trpc.js";

/** Entries are written in batches this size — one round trip per chunk. */
const INSERT_CHUNK = 500;

/**
 * Hard bound on how much one export may sweep up. Well past a decade of
 * full-time tracking, and low enough that one request cannot pull a whole
 * database into memory. Exceeding it is a refusal, never a truncation: an
 * export that quietly stopped at the first 200,000 entries would be a backup
 * missing years, and nothing in the file or on screen would say which ones.
 *
 * Exported so the client can count against the same number it will be
 * refused by, and warn before the click rather than after it.
 */
export const MAX_EXPORT_ENTRIES = 200_000;

/**
 * Ceiling on the invoices one export carries. Far past what any workspace
 * issues in a decade, and a bound rather than an unbounded read.
 *
 * Exported for the same reason {@link MAX_EXPORT_ENTRIES} is: the boundary is
 * pinned by a test rather than by the shape of a query.
 */
export const MAX_EXPORT_INVOICES = 10_000;

const badRequest = (message: string): TRPCError =>
  new TRPCError({ code: "BAD_REQUEST", message });

/**
 * Refuse an export that would not be whole.
 *
 * Fed the length of a read taken one PAST the cap, so "we hit the ceiling"
 * and "the range happens to end exactly there" are distinguishable — a plain
 * `.limit(MAX)` returns the same count either way and there is nothing left
 * to detect. Pure and exported so the boundary itself is unit-testable: this
 * is the one place that decides whether a download is a backup or a subset,
 * and it must not need a database to be pinned down.
 */
export function assertExportWithinCap(fetched: number): void {
  if (fetched <= MAX_EXPORT_ENTRIES) return;
  throw badRequest(
    `This export would hold more than ${MAX_EXPORT_ENTRIES.toLocaleString("en-US")} entries. Set a narrower date range and export it in parts.`,
  );
}

/**
 * The same refusal for invoices, fed a read taken one past their own cap.
 *
 * A separate function because the two caps are separate numbers, but the RULE
 * is the one stated above and must not be weaker here: a plain
 * `.limit(MAX_EXPORT_INVOICES)` hands back the oldest N by issue date and
 * drops the rest with nothing in the file, and nothing on screen, to say a
 * year of billing is missing from what reads as a complete backup.
 */
export function assertExportInvoicesWithinCap(fetched: number): void {
  if (fetched <= MAX_EXPORT_INVOICES) return;
  throw badRequest(
    `This export would hold more than ${MAX_EXPORT_INVOICES.toLocaleString("en-US")} invoices. Set a narrower date range and export it in parts.`,
  );
}

const lower = (value: string): string => value.trim().toLowerCase();

/** The catalog, indexed the way the importer looks things up: by name. */
type CatalogIndex = {
  clients: Map<string, string>;
  projects: Map<string, ProjectRef>;
  /** Keyed by lowercased task name — tasks are workspace-wide, not per project. */
  tasks: Map<string, string>;
  tags: Map<string, string>;
  /** Names by id, for turning existing entries back into fingerprints. */
  projectNameById: Map<string, string>;
};

type ProjectRef = {
  id: string;
  clientId: string | null;
  hourlyRate: number | null;
  billableDefault: boolean;
};

async function loadCatalog(workspaceId: string): Promise<CatalogIndex> {
  const [clients, projects, tasks, tags] = await Promise.all([
    Client.find({ workspaceId }, { name: 1 }).lean(),
    Project.find(
      { workspaceId },
      { name: 1, clientId: 1, hourlyRate: 1, billableDefault: 1 },
    ).lean(),
    Task.find({ workspaceId }, { name: 1 }).lean(),
    Tag.find({ workspaceId }, { name: 1 }).lean(),
  ]);

  const index: CatalogIndex = {
    clients: new Map(),
    projects: new Map(),
    tasks: new Map(),
    tags: new Map(),
    projectNameById: new Map(),
  };

  for (const client of clients) index.clients.set(lower(client.name), String(client._id));
  for (const project of projects) {
    const id = String(project._id);
    index.projects.set(lower(project.name), {
      id,
      clientId: project.clientId ?? null,
      hourlyRate: project.hourlyRate ?? null,
      billableDefault: project.billableDefault ?? true,
    });
    index.projectNameById.set(id, project.name);
  }
  for (const task of tasks) {
    index.tasks.set(lower(task.name), String(task._id));
  }
  for (const tag of tags) index.tags.set(lower(tag.name), String(tag._id));

  return index;
}

/**
 * Mark the rows this workspace already has.
 *
 * Only the file's own date range is read back, and only the four fields the
 * fingerprint uses — a backfill covering one month must not read a decade of
 * entries to find out it is new.
 *
 * Author-scoped exactly like the export path, and for a sharper reason than
 * tidiness: the answer is handed back to the uploader as `duplicateRows`, so
 * an unscoped scan turns `analyze` into an existence oracle over colleagues'
 * work. A one-row file is a question — "did anyone log 09:00–12:00 on Acme
 * that day?" — and iterating the times reconstructs somebody's week without
 * a single entry ever being read out. The cost of the scope is stated and
 * accepted: two members CAN each import the same row, because to a member
 * restricted to their own rows the other copy does not exist.
 */
async function markWorkspaceDuplicates(
  workspaceId: string,
  rows: ImportRow[],
  catalog: CatalogIndex,
  authorScope: { authorId: string } | null,
): Promise<number> {
  const candidates = rows.filter((row) => row.duplicateOf === null);
  if (candidates.length === 0) return 0;

  let minStart = Number.POSITIVE_INFINITY;
  let maxStart = Number.NEGATIVE_INFINITY;
  for (const row of candidates) {
    const ms = Date.parse(row.start);
    if (ms < minStart) minStart = ms;
    if (ms > maxStart) maxStart = ms;
  }

  const existing = await TimeEntry.find(
    {
      workspaceId,
      ...(authorScope ?? {}),
      start: { $gte: new Date(minStart), $lte: new Date(maxStart) },
    },
    { start: 1, durationSec: 1, description: 1, projectId: 1 },
  ).lean();

  const seen = new Set<string>();
  for (const entry of existing) {
    seen.add(
      importFingerprint({
        start: entry.start.toISOString(),
        durationSec: entry.durationSec,
        description: entry.description ?? "",
        projectName: entry.projectId
          ? (catalog.projectNameById.get(entry.projectId) ?? null)
          : null,
      }),
    );
  }

  let duplicates = 0;
  for (const row of candidates) {
    if (seen.has(importFingerprint(row))) {
      row.duplicateOf = "workspace";
      duplicates += 1;
    }
  }
  return duplicates;
}

/** Parse the file exactly as both procedures must, or refuse it. */
function readFile(input: ImportInput): {
  parsed: ParsedFile;
  timeZone: string;
} {
  const timeZone = resolveTimeZone(input.timeZone);
  const overrides = new Map<number, ImportColumnRole>(
    (input.columns ?? []).map((column) => [column.index, column.role]),
  );
  const parsed = parseImportFile(input.text, {
    timeZone,
    dateOrder: input.dateOrder,
    overrides,
  });

  if (parsed.totalRows > MAX_IMPORT_ROWS) {
    throw badRequest(
      `That file has ${parsed.totalRows} rows; the limit is ${MAX_IMPORT_ROWS} per import. Split it by date range and import the parts.`,
    );
  }
  if (parsed.shape === "unusable") {
    throw badRequest(
      "No start time could be found in that file. Point a column at Start (or at Date and Duration) and try again.",
    );
  }

  return { parsed, timeZone };
}

/** Names in the file that the workspace does not have yet. */
function missingNames(
  rows: readonly ImportRow[],
  catalog: CatalogIndex,
): {
  clients: string[];
  projects: string[];
  tasks: string[];
  tags: string[];
} {
  const clients = new Map<string, string>();
  const projects = new Map<string, string>();
  const tasks = new Map<string, string>();
  const tags = new Map<string, string>();

  for (const row of rows) {
    if (row.clientName && !catalog.clients.has(lower(row.clientName))) {
      clients.set(lower(row.clientName), row.clientName);
    }
    if (row.projectName && !catalog.projects.has(lower(row.projectName))) {
      projects.set(lower(row.projectName), row.projectName);
    }
    if (row.taskName && !catalog.tasks.has(lower(row.taskName))) {
      tasks.set(lower(row.taskName), row.taskName);
    }
    for (const tag of row.tagNames) {
      if (!catalog.tags.has(lower(tag))) tags.set(lower(tag), tag);
    }
  }

  return {
    clients: [...clients.values()],
    projects: [...projects.values()],
    tasks: [...tasks.values()],
    tags: [...tags.values()],
  };
}

/** Catalog settings a JSON export carries that a delimited file cannot. */
type CatalogHints = {
  clientColor: Map<string, string>;
  /** Billing details for a client the import creates; never onto an existing one. */
  clientBilling: Map<string, ClientBilling>;
  projectColor: Map<string, string>;
  projectRate: Map<string, number | null>;
  projectBillable: Map<string, boolean>;
  tagColor: Map<string, string>;
  /**
   * The rest of what a project states about itself. Restored with it, because
   * a project recreated without its budget or its estimate is not the project
   * the file described — and nothing would ever report the difference.
   */
  projectExtras: Map<string, ProjectExtras>;
};

type ProjectExtras = {
  estimatedHours: number | null;
  budgetAmount: number | null;
  budgetCurrency: string | null;
  idleBehavior: IdleBehavior | null;
};

const emptyHints = (): CatalogHints => ({
  clientColor: new Map(),
  clientBilling: new Map(),
  projectColor: new Map(),
  projectRate: new Map(),
  projectBillable: new Map(),
  tagColor: new Map(),
  projectExtras: new Map(),
});

function hintsFromDoc(doc: WorkspaceExport | null): CatalogHints {
  const hints = emptyHints();
  if (!doc) return hints;

  // An empty color is not set at all, so the palette picker assigns one. The
  // parser blanks a color it could not read (`workspaceJsonCatalog`), and
  // writing "" through would fail the model's `required` on the way in.
  for (const client of doc.clients) {
    if (client?.name && client.color) {
      hints.clientColor.set(lower(client.name), client.color);
    }
    const billing = client?.name ? normalizeClientBilling(client.billing) : null;
    if (client?.name && billing) {
      hints.clientBilling.set(lower(client.name), billing);
    }
  }
  for (const project of doc.projects) {
    if (!project?.name) continue;
    const key = lower(project.name);
    if (project.color) hints.projectColor.set(key, project.color);
    hints.projectRate.set(key, project.hourlyRate ?? null);
    hints.projectBillable.set(key, project.billableDefault ?? true);
    hints.projectExtras.set(key, {
      estimatedHours: project.estimatedHours ?? null,
      budgetAmount: project.budgetAmount ?? null,
      budgetCurrency: project.budgetCurrency ?? null,
      idleBehavior: project.idleBehavior ?? null,
    });
  }
  for (const tag of doc.tags) {
    if (tag?.name && tag.color) hints.tagColor.set(lower(tag.name), tag.color);
  }
  return hints;
}

/**
 * The JSON document behind a file, or null for anything else.
 *
 * Both procedures read it through here so there is ONE parse of the non-entry
 * half per call: a second independent parse is a second thing that can
 * disagree with the preview the user approved.
 */
const workspaceDoc = (parsed: ParsedFile, text: string): WorkspaceExport | null =>
  parsed.format === "workspace-json" ? workspaceJsonCatalog(text) : null;

/**
 * What the file carries beyond entries.
 *
 * A delimited file carries none of it and says so with zeroes — which is not
 * the same claim as a v1 export's, where the sections did not exist yet; the
 * version is what tells those two apart.
 */
/**
 * Write the workspace's money and calendar policy back, if the file states it
 * and the caller asked for it.
 *
 * The role check is the load-bearing part, and it is the SAME one
 * `settings.update` applies: currency and the default rate reprice everybody's
 * future entries, so they are not an ordinary member's to change. Without this
 * an upload would be a way around a check every other path enforces — a
 * privilege escalation through a file picker.
 */
async function restoreWorkspaceSettings(args: {
  workspaceId: string;
  role: WorkspaceRole;
  doc: WorkspaceExport | null;
  requested: boolean;
  originId?: string;
}): Promise<boolean> {
  const { workspaceId, role, doc, requested, originId } = args;
  if (!requested || !doc) return false;

  if (role === "member") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "Only an owner or admin can restore workspace settings from a file. Import the entries without them, or ask an admin.",
    });
  }

  const fields = settingsRestoreFields(doc);
  const profile = doc.businessProfile;
  if (Object.keys(fields).length === 0 && !profile) return false;

  if (Object.keys(fields).length > 0) {
    await WorkspaceSettingsModel.updateOne(
      { workspaceId },
      { $set: fields },
      { upsert: true },
    );
  }
  // Replaced whole, like `settings.updateBusinessProfile` does. A file that
  // states no profile leaves the destination's alone — absence is "not said".
  if (profile) await saveBusinessProfile(workspaceId, profile);
  void publishSync(workspaceId, { kind: "settings.changed" }, originId);
  return true;
}

/**
 * Write the caller's pins back, resolved by name against the catalog as it
 * stands AFTER this import created whatever it was going to create.
 *
 * `userId` is always the caller's and never anything read out of the file: a
 * file must not be able to write pins onto somebody else's account. The
 * planning — dedupe, ordering, the 50-pin ceiling — is pure and lives in
 * `services/import/restore.ts`.
 */
async function restoreFavorites(args: {
  workspaceId: string;
  userId: string;
  catalog: CatalogIndex;
  doc: WorkspaceExport | null;
  requested: boolean;
  originId?: string;
}): Promise<string[]> {
  const { workspaceId, userId, catalog, doc, requested, originId } = args;
  const favorites = doc?.favorites ?? [];
  if (!requested || favorites.length === 0) return [];

  const existing = await Favorite.find(
    { workspaceId, userId },
    { description: 1, projectId: 1, taskId: 1, billable: 1 },
  ).lean();

  const plan = planFavoriteRestore({
    favorites,
    existing: existing.map(
      (favorite): QuickStart => ({
        description: favorite.description,
        projectId: favorite.projectId ?? null,
        taskId: favorite.taskId ?? null,
        billable: favorite.billable,
      }),
    ),
    resolve: (favorite) => {
      const project = favorite.projectName
        ? (catalog.projects.get(lower(favorite.projectName)) ?? null)
        : null;
      return {
        projectId: project?.id ?? null,
        taskId:
          project && favorite.taskName
            ? (catalog.tasks.get(
                `${project.id}::${lower(favorite.taskName)}`,
              ) ?? null)
            : null,
      };
    },
  });

  if (plan.create.length === 0) return [];

  const written = await Favorite.insertMany(
    plan.create.map((favorite) => ({ ...favorite, workspaceId, userId })),
    { ordered: false },
  );

  // Pins are personal, so the change is announced to this person's own
  // devices and nobody else's — the same fan-out every mutation in
  // favorites.ts uses. Skipping it leaves their other clients on a stale row.
  publishToUser(userId, { kind: "favorites.changed" }, originId);

  return written.map((favorite) => String(favorite._id));
}

const sectionsOf = (doc: WorkspaceExport | null): ImportSections => ({
  version: doc?.version ?? 1,
  // Read back off the file rather than inferred from null rates: "every rate
  // in here is blank" and "this workspace never billed anything" are the same
  // document otherwise, and only the first one is a partial restore the user
  // has to be told about BEFORE it is written.
  moneyRedacted: doc?.moneyRedacted === true,
  // Asked of the same function the commit writes from, not of the presence of
  // a `settings` key: a v1 file has no such section and still names a
  // currency, which is restorable. A preview must promise what would actually
  // be written, or approving it means nothing.
  settings: doc
    ? Object.keys(settingsRestoreFields(doc)).length > 0 ||
      doc.businessProfile !== undefined
    : false,
  favorites: doc?.favorites?.length ?? 0,
  invoices: doc?.invoices?.length ?? 0,
});

type CreatedCatalog = {
  clientIds: string[];
  projectIds: string[];
  taskIds: string[];
  tagIds: string[];
};

/**
 * Create everything the rows name that does not exist yet, updating the index
 * in place so the entry loop can look every reference up by name.
 *
 * Order matters: a project needs its client's id, and a task needs its
 * project's, so the three passes cannot be collapsed into one.
 */
async function createMissingCatalog(args: {
  workspaceId: string;
  createdBy: string;
  rows: readonly ImportRow[];
  catalog: CatalogIndex;
  hints: CatalogHints;
}): Promise<CreatedCatalog> {
  const { workspaceId, createdBy, rows, catalog, hints } = args;
  const created: CreatedCatalog = {
    clientIds: [],
    projectIds: [],
    taskIds: [],
    tagIds: [],
  };

  const clientNames = new Map<string, string>();
  const projectNames = new Map<string, string>();
  const tagNames = new Map<string, string>();
  /** Which client each new project belongs to, from the first row naming it. */
  const projectClient = new Map<string, string | null>();

  for (const row of rows) {
    if (row.clientName) clientNames.set(lower(row.clientName), row.clientName);
    if (row.projectName) {
      const key = lower(row.projectName);
      projectNames.set(key, row.projectName);
      if (!projectClient.has(key)) {
        projectClient.set(key, row.clientName ? lower(row.clientName) : null);
      }
    }
    for (const tag of row.tagNames) tagNames.set(lower(tag), tag);
  }

  let colorSeed = catalog.clients.size;
  for (const [key, name] of clientNames) {
    if (catalog.clients.has(key)) continue;
    const billing = hints.clientBilling.get(key);
    const doc = await Client.create({
      workspaceId,
      createdBy,
      name,
      ...(billing ? { billing } : {}),
      color:
        hints.clientColor.get(key) ??
        pickCatalogColor(colorSeed) ??
        DEFAULT_CLIENT_COLOR,
    });
    colorSeed += 1;
    const id = String(doc._id);
    catalog.clients.set(key, id);
    created.clientIds.push(id);
  }

  let projectSeed = catalog.projects.size;
  for (const [key, name] of projectNames) {
    if (catalog.projects.has(key)) continue;
    const clientKey = projectClient.get(key) ?? null;
    const clientId = clientKey ? (catalog.clients.get(clientKey) ?? null) : null;
    const hourlyRate = hints.projectRate.get(key) ?? null;
    const billableDefault = hints.projectBillable.get(key) ?? true;
    const extras = hints.projectExtras.get(key);
    const doc = await Project.create({
      workspaceId,
      createdBy,
      name,
      color:
        hints.projectColor.get(key) ??
        pickCatalogColor(projectSeed, PROJECT_COLOR_OFFSET) ??
        DEFAULT_PROJECT_COLOR,
      clientId,
      hourlyRate,
      billableDefault,
      estimatedHours: extras?.estimatedHours ?? null,
      budgetAmount: extras?.budgetAmount ?? null,
      budgetCurrency: extras?.budgetCurrency ?? null,
      idleBehavior: extras?.idleBehavior ?? null,
    });
    projectSeed += 1;
    const id = String(doc._id);
    catalog.projects.set(key, { id, clientId, hourlyRate, billableDefault });
    catalog.projectNameById.set(id, name);
    created.projectIds.push(id);
  }

  for (const [key, name] of tagNames) {
    if (catalog.tags.has(key)) continue;
    const doc = await Tag.create({
      workspaceId,
      createdBy,
      name,
      color: hints.tagColor.get(key) ?? DEFAULT_TAG_COLOR,
    });
    const id = String(doc._id);
    catalog.tags.set(key, id);
    created.tagIds.push(id);
  }

  // Tasks are workspace-wide, so a row naming a task but no project still
  // gets one: the entry keeps the task and is simply project-less.
  for (const row of rows) {
    if (!row.taskName) continue;
    const key = lower(row.taskName);
    if (catalog.tasks.has(key)) continue;
    const doc = await Task.create({
      workspaceId,
      createdBy,
      name: row.taskName,
    });
    const id = String(doc._id);
    catalog.tasks.set(key, id);
    created.taskIds.push(id);
  }

  return created;
}

const summarize = (
  rows: readonly ImportRow[],
): { totalSec: number; firstStart: string | null; lastStart: string | null } => {
  let totalSec = 0;
  let first: string | null = null;
  let last: string | null = null;
  for (const row of rows) {
    totalSec += row.durationSec;
    if (first === null || row.start < first) first = row.start;
    if (last === null || row.start > last) last = row.start;
  }
  return { totalSec, firstStart: first, lastStart: last };
};

/** `from`/`to` as one Mongo range, or `null` for an unbounded export. */
function exportDateRange(
  from: string | undefined,
  to: string | undefined,
): Record<string, Date> | null {
  if (!from && !to) return null;
  const range: Record<string, Date> = {};
  if (from) range.$gte = new Date(`${from}T00:00:00.000Z`);
  if (to) range.$lte = new Date(`${to}T23:59:59.999Z`);
  return range;
}

/**
 * The entries one export carries, as a filter.
 *
 * Written once because two callers ask the same question: the builder, which
 * reads the rows, and `info`, which only counts them so the panel can warn
 * before the click. A count taken with a different filter than the read would
 * promise a download the export then refuses — or, worse, stay quiet about
 * one it is about to refuse.
 */
function exportEntryFilter(args: {
  workspaceId: string;
  authorScope: { authorId: string } | null;
  dateRange: Record<string, Date> | null;
}): Record<string, unknown> {
  const { workspaceId, authorScope, dateRange } = args;
  return {
    workspaceId,
    ...(authorScope ?? {}),
    ...(dateRange ? { start: dateRange } : {}),
    // A running timer has no end and no duration yet; exporting it would
    // write a zero-length entry that the importer then refuses.
    end: { $ne: null },
  };
}

/**
 * Read the whole workspace into the portable shape.
 *
 * Catalog references travel BY NAME (see `WorkspaceExportEntry`), which is
 * what makes an export importable into a different workspace — or back into
 * an empty one after the database it came from is gone.
 *
 * Takes the caller's `visibility` rather than a pre-computed author scope, so
 * both halves of the question are answered in one place: WHICH entries leave
 * (`authorScopeFilter`, as in reports.ts) and WHETHER the rates on them do
 * (`redactExportMoney`). Handing this function only the author scope is what
 * left the money half unanswerable, and unanswered.
 *
 * `role` answers the third question — whether invoices leave at all — with
 * the same `canUseInvoices` rule the invoices router gates on. An export is a
 * bulk door onto what `invoices.list` serves a page at a time, and a member
 * that list answers with nothing must not find the documents in a download.
 */
async function buildWorkspaceExport(args: {
  workspaceId: string;
  from?: string;
  to?: string;
  visibility: Visibility;
  role: WorkspaceRole;
}): Promise<WorkspaceExport> {
  const { workspaceId, from, to, visibility, role } = args;
  const authorScope = authorScopeFilter(visibility);
  const includeInvoices = canUseInvoices(role, visibility);

  // One range, applied to an entry's `start` and to an invoice's `issueDate`:
  // a ranged export is "what happened in these months", and an invoice issued
  // outside them belongs to a different slice of the history.
  const dateRange = exportDateRange(from, to);

  const [
    catalogClients,
    catalogProjects,
    catalogTasks,
    catalogTags,
    settings,
    catalogFavorites,
    catalogInvoices,
    businessProfile,
  ] = await Promise.all([
    Client.find({ workspaceId }).lean(),
    Project.find({ workspaceId }).lean(),
    Task.find({ workspaceId }).lean(),
    Tag.find({ workspaceId }).lean(),
    getOrCreateWorkspaceSettings(workspaceId),
    // Pins are scoped by BOTH axes, exactly as `listFavorites` reads them: a
    // favorite is one person's shortcut into one workspace. Exporting every
    // member's would put a colleague's shortcuts in this person's backup and
    // give the restore nothing to write them onto.
    Favorite.find({ workspaceId, userId: visibility.userId })
      .sort({ order: 1, createdAt: 1 })
      .lean(),
    // Invoices carry an author (`createdBy`) but no per-entry authorship, so
    // the same scope the entries use is applied to that field: a member
    // restricted to their own rows does not pull every colleague's invoice
    // out in bulk. Derived from `authorScopeFilter` so the two cannot drift.
    //
    // The residual gap is stated rather than hidden: INSIDE one invoice there
    // is no author scope at all — a line merges whoever's hours were billed
    // into one figure. That is exactly why every amount on an invoice follows
    // the workspace-money rule and not the per-entry "own money" one.
    includeInvoices
      ? Invoice.find({
          workspaceId,
          ...(authorScope ? { createdBy: authorScope.authorId } : {}),
          ...(dateRange ? { issueDate: dateRange } : {}),
        })
          .sort({ issueDate: 1 })
          // One past the cap, like the entries below: a plain limit would drop
          // the newest invoices out of a file that still reads as a full backup.
          .limit(MAX_EXPORT_INVOICES + 1)
          .lean()
      : Promise.resolve([]),
    // Omitted from the file while empty, so "never filled in" and "not
    // stated" read the same on the way back in: neither overwrites anything.
    // The issuer profile is the invoice header, payment details included, so
    // it leaves under the same `canUseInvoices` rule as the invoices do.
    includeInvoices
      ? BusinessProfileModel.findOne({ workspaceId })
          .lean()
          .then((doc) => issuerSnapshot(doc) ?? undefined)
      : Promise.resolve(undefined),
  ]);

  const clientNameById = new Map(
    catalogClients.map((client) => [String(client._id), client.name]),
  );
  const projectById = new Map(
    catalogProjects.map((project) => [String(project._id), project]),
  );
  const taskNameById = new Map(
    catalogTasks.map((task) => [String(task._id), task.name]),
  );
  const tagNameById = new Map(
    catalogTags.map((tag) => [String(tag._id), tag.name]),
  );

  const entries = await TimeEntry.find(
    exportEntryFilter({ workspaceId, authorScope, dateRange }),
  )
    .sort({ start: 1 })
    // One past the cap, so hitting it is detectable rather than a silent
    // truncation — see the refusal below.
    .limit(MAX_EXPORT_ENTRIES + 1)
    .lean();

  // Truncating here would hand back a file that reads as a complete backup
  // and is not, with nothing on screen to say which entries are missing.
  assertExportWithinCap(entries.length);
  assertExportInvoicesWithinCap(catalogInvoices.length);

  const exportEntries: WorkspaceExportEntry[] = entries.map((entry) => {
    const project = entry.projectId ? projectById.get(entry.projectId) : null;
    return {
      description: entry.description ?? "",
      clientName: project?.clientId
        ? (clientNameById.get(project.clientId) ?? null)
        : null,
      projectName: project?.name ?? null,
      taskName: entry.taskId ? (taskNameById.get(entry.taskId) ?? null) : null,
      tagNames: (entry.tagIds ?? [])
        .map((id) => tagNameById.get(id))
        .filter((name): name is string => Boolean(name)),
      billable: entry.billable,
      start: entry.start.toISOString(),
      end: entry.end ? entry.end.toISOString() : null,
      durationSec: entry.durationSec,
      hourlyRate: entry.hourlyRate ?? null,
      currency: entry.currency,
      timeZone: entry.timeZone ?? null,
    };
  });

  const exportFavorites: WorkspaceExportFavorite[] = catalogFavorites.map(
    (favorite) => {
      const project = favorite.projectId
        ? projectById.get(favorite.projectId)
        : null;
      return {
        description: favorite.description,
        clientName: project?.clientId
          ? (clientNameById.get(project.clientId) ?? null)
          : null,
        projectName: project?.name ?? null,
        taskName: favorite.taskId
          ? (taskNameById.get(favorite.taskId) ?? null)
          : null,
        billable: favorite.billable,
        order: favorite.order,
      };
    },
  );

  const exportInvoices: WorkspaceExportInvoice[] = catalogInvoices.map(
    (invoice) => ({
      number: invoice.number,
      // The name as it was at issue time, not as the client is called today —
      // the document was sent with this on it.
      clientName: invoice.clientName,
      status: invoice.status,
      issueDate: invoice.issueDate.toISOString(),
      dueDate: invoice.dueDate.toISOString(),
      from: invoice.from.toISOString(),
      to: invoice.to.toISOString(),
      groupBy: invoice.groupBy,
      lineItems: (invoice.lineItems ?? []).map((line) => ({
        label: line.label,
        projectName: line.projectId
          ? (projectById.get(line.projectId)?.name ?? null)
          : null,
        taskName: line.taskId ? (taskNameById.get(line.taskId) ?? null) : null,
        seconds: line.seconds,
        hours: line.hours,
        hourlyRate: line.hourlyRate,
        currency: line.currency,
        amount: line.amount,
      })),
      subtotal: invoice.subtotal,
      taxRate: invoice.taxRate ?? null,
      taxAmount: invoice.taxAmount,
      total: invoice.total,
      currency: invoice.currency,
      notes: invoice.notes ?? null,
      ...(invoice.issuer ? { issuer: normalizeBusinessProfile(invoice.issuer) } : {}),
      ...(invoice.recipient
        ? { recipient: normalizeRecipient(invoice.recipient) }
        : {}),
      createdAt: invoice.createdAt.toISOString(),
      // `entryIds` is deliberately absent: an entry has no identity in this
      // format, so exporting them would write ids that address nothing —
      // and inviting a re-link would double-bill. See WorkspaceExportInvoice.
    }),
  );

  const document: WorkspaceExport = {
    version: WORKSPACE_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    workspaceId,
    currency: settings.currency,
    // The workspace half only. `currency` stays top-level and is not repeated
    // here, and the per-user half is keyed by userId — see
    // WorkspaceExportSettings for why a workspace file must not carry it.
    settings: {
      defaultHourlyRate: settings.defaultHourlyRate,
      weekStartsOn: settings.weekStartsOn,
    },
    ...(businessProfile ? { businessProfile } : {}),
    clients: catalogClients.map((client) => {
      const billing = normalizeClientBilling(client.billing);
      return {
        name: client.name,
        color: client.color,
        archived: client.archived,
        ...(billing ? { billing } : {}),
      };
    }),
    projects: catalogProjects.map((project) => ({
      name: project.name,
      color: project.color,
      clientName: project.clientId
        ? (clientNameById.get(project.clientId) ?? null)
        : null,
      billableDefault: project.billableDefault,
      hourlyRate: project.hourlyRate ?? null,
      estimatedHours: project.estimatedHours ?? null,
      budgetAmount: project.budgetAmount ?? null,
      budgetCurrency: project.budgetCurrency ?? null,
      idleBehavior: project.idleBehavior ?? null,
      archived: project.archived,
    })),
    tasks: catalogTasks.map((task) => ({
      name: task.name,
      done: task.done,
      archived: task.archived,
    })),
    tags: catalogTags.map((tag) => ({
      name: tag.name,
      color: tag.color,
      archived: tag.archived,
    })),
    entries: exportEntries,
    favorites: exportFavorites,
    invoices: exportInvoices,
  };

  // Last thing before the document leaves: an export is a bulk door onto the
  // rows reports guard one page at a time, and a member who cannot see other
  // members' money must not receive their rates through a download either.
  // Redacting HERE rather than in each procedure is what keeps the JSON and
  // CSV doors from disagreeing — the CSV is built from what this returns.
  return redactExportMoney(document, visibility);
}

export const dataRouter = router({
  /**
   * What this file would do, computed without writing anything.
   *
   * A mutation rather than a query despite changing nothing: the payload is a
   * whole file, and a query would put it in a URL and in every cache between
   * here and the browser.
   */
  analyze: workspaceProcedure
    .input(importInputSchema)
    .mutation(async ({ ctx, input }): Promise<ImportPreview> => {
      const { parsed, timeZone } = readFile(input);
      const catalog = await loadCatalog(ctx.workspaceId);
      const duplicates = await markWorkspaceDuplicates(
        ctx.workspaceId,
        parsed.rows,
        catalog,
        authorScopeFilter(ctx.visibility),
      );

      const fileDuplicates = parsed.rows.filter(
        (row) => row.duplicateOf === "file",
      ).length;
      const ready = parsed.rows.filter((row) => row.duplicateOf === null);
      const missing = missingNames(ready, catalog);
      const totals = summarize(ready);

      return {
        format: parsed.format,
        delimiter: parsed.delimiter,
        shape: parsed.shape,
        dateOrder: parsed.dateOrder,
        dateOrderAmbiguous: parsed.dateOrderAmbiguous,
        columns: parsed.columns,
        timeZone,
        totalRows: parsed.totalRows,
        readyRows: ready.length,
        skippedRows: parsed.totalRows - parsed.rows.length,
        duplicateRows: duplicates + fileDuplicates,
        totalSec: totals.totalSec,
        firstStart: totals.firstStart,
        lastStart: totals.lastStart,
        newClients: missing.clients,
        newProjects: missing.projects,
        newTasks: missing.tasks,
        newTags: missing.tags,
        issues: parsed.issues.slice(0, IMPORT_PREVIEW_ISSUES),
        sample: ready.slice(0, IMPORT_PREVIEW_ROWS),
        // Stated BEFORE the write, which is the whole point of analyze and
        // commit taking the same input: invoices in the file are not coming
        // back, and an omission nobody was told about looks like data loss.
        sections: sectionsOf(workspaceDoc(parsed, input.text)),
      };
    }),

  /** Write the file. Same input, same parser, same rows as the preview. */
  commit: workspaceProcedure
    .input(importInputSchema)
    .mutation(async ({ ctx, input }): Promise<ImportResult> => {
      const { parsed, timeZone } = readFile(input);
      const workspaceId = ctx.workspaceId;
      const catalog = await loadCatalog(workspaceId);
      await markWorkspaceDuplicates(
        workspaceId,
        parsed.rows,
        catalog,
        authorScopeFilter(ctx.visibility),
      );

      const skipDuplicates = input.skipDuplicates ?? true;
      const rows = skipDuplicates
        ? parsed.rows.filter((row) => row.duplicateOf === null)
        : parsed.rows;

      if (rows.length === 0) {
        throw badRequest(
          "Nothing to import — every row in that file is already here.",
        );
      }

      const doc = workspaceDoc(parsed, input.text);
      const hints = hintsFromDoc(doc);

      // Settings go FIRST, before a single entry is written. Every entry
      // stopped here snapshots the workspace currency and falls back to its
      // default rate, so restoring a backup and then flipping the currency
      // would label the restored history in the money it was never tracked
      // in — with nothing to detect it afterwards.
      const settingsRestored = await restoreWorkspaceSettings({
        workspaceId,
        role: ctx.membership.role,
        doc,
        requested: input.restoreSettings ?? false,
        originId: input.originId,
      });
      const settings = await getOrCreateWorkspaceSettings(workspaceId);

      const created =
        (input.createMissing ?? true)
          ? await createMissingCatalog({
              workspaceId,
              createdBy: ctx.user.id,
              rows,
              catalog,
              hints,
            })
          : { clientIds: [], projectIds: [], taskIds: [], tagIds: [] };

      const totals = summarize(rows);

      // The batch is written FIRST so every entry can carry its id. A crash
      // halfway through then leaves a batch that undo can still clean up,
      // rather than orphan entries nothing points at.
      const batch = await ImportBatch.create({
        workspaceId,
        createdBy: ctx.user.id,
        filename: input.filename ?? null,
        format: parsed.format,
        shape: parsed.shape,
        dateOrder: parsed.dateOrder,
        timeZone,
        clientIds: created.clientIds,
        projectIds: created.projectIds,
        taskIds: created.taskIds,
        tagIds: created.tagIds,
        // Recorded, not reversible: undo puts the entries and the catalog
        // back the way they were, but not the workspace's policy — a currency
        // everything written since has been snapshotted in cannot be quietly
        // rolled back. The history table says the import touched it.
        settingsRestored,
        entriesSkipped: parsed.rows.length - rows.length,
        totalSec: totals.totalSec,
        firstStart: totals.firstStart ? new Date(totals.firstStart) : null,
        lastStart: totals.lastStart ? new Date(totals.lastStart) : null,
      });
      const batchId = String(batch._id);

      const defaultBillable = input.defaultBillable ?? false;
      const docs = rows.map((row) => {
        const project = row.projectName
          ? (catalog.projects.get(lower(row.projectName)) ?? null)
          : null;
        const taskId = row.taskName
          ? (catalog.tasks.get(lower(row.taskName)) ?? null)
          : null;
        const billable =
          row.billable ?? project?.billableDefault ?? defaultBillable;
        return {
          workspaceId,
          authorId: ctx.user.id,
          description: row.description,
          projectId: project?.id ?? null,
          taskId,
          billable,
          start: new Date(row.start),
          end: new Date(row.end),
          durationSec: row.durationSec,
          // The file's own rate wins over the project's: it is what the work
          // was actually billed at, and re-deriving it here would silently
          // reprice imported history against today's rate card.
          hourlyRate: billable
            ? (row.hourlyRate ??
              resolveHourlyRate({
                billable,
                projectRate: project?.hourlyRate ?? null,
                defaultRate: settings.defaultHourlyRate,
              }))
            : null,
          currency: settings.currency,
          source: "import" as const,
          timeZone,
          tagIds: row.tagNames
            .map((name) => catalog.tags.get(lower(name)))
            .filter((id): id is string => Boolean(id)),
          importId: batchId,
        };
      });

      let entriesCreated = 0;
      for (let index = 0; index < docs.length; index += INSERT_CHUNK) {
        const chunk = docs.slice(index, index + INSERT_CHUNK);
        // `ordered: false` so one rejected document does not abandon the rest
        // of the chunk — a single unparseable row must not cost the import.
        const written = await TimeEntry.insertMany(chunk, { ordered: false });
        entriesCreated += written.length;
      }

      // Pins last: they reference the catalog by name, so they can only be
      // resolved once this import has created whatever it was going to create.
      const favoriteIds = await restoreFavorites({
        workspaceId,
        userId: ctx.user.id,
        catalog,
        doc,
        requested: input.restoreFavorites ?? false,
        originId: input.originId,
      });

      await ImportBatch.updateOne(
        { _id: batch._id },
        { $set: { entriesCreated, favoriteIds } },
      );

      // Author-audienced: the event means "this person's history just grew",
      // which a colleague restricted to their own time must not be told.
      void publishSync(
        workspaceId,
        { kind: "data.imported", batchId, undone: false },
        input.originId,
        { authorId: ctx.user.id },
      );
      // The catalog an import created is shared configuration every member
      // lists, and a member who does not receive `data.imported` would
      // otherwise keep a project list without it until the next reload.
      if (
        created.clientIds.length +
          created.projectIds.length +
          created.taskIds.length +
          created.tagIds.length >
        0
      ) {
        void publishSync(
          workspaceId,
          { kind: "catalog.changed", scope: "project" },
          input.originId,
        );
      }

      return {
        batchId,
        entriesCreated,
        entriesSkipped: parsed.rows.length - rows.length,
        clientsCreated: created.clientIds.length,
        projectsCreated: created.projectIds.length,
        tasksCreated: created.taskIds.length,
        tagsCreated: created.tagIds.length,
        favoritesCreated: favoriteIds.length,
        settingsRestored,
        totalSec: totals.totalSec,
        firstStart: totals.firstStart,
        lastStart: totals.lastStart,
      };
    }),

  /**
   * Past imports, newest first.
   *
   * Author-scoped on `createdBy`, from the same `authorScopeFilter` the
   * entries use. A batch is a summary of the entries it wrote — filename,
   * count, total hours, and whether it rewrote workspace settings — so
   * listing every member's would hand a member restricted to their own rows
   * the aggregate of somebody else's history, and an hour count becomes an
   * amount the moment any rate is known.
   */
  history: workspaceProcedure
    .input(workspaceExportSchema.pick({ workspaceId: true }))
    .query(async ({ ctx }): Promise<ImportBatchSummary[]> => {
      const authorScope = authorScopeFilter(ctx.visibility);
      const docs = await ImportBatch.find({
        workspaceId: ctx.workspaceId,
        ...(authorScope ? { createdBy: authorScope.authorId } : {}),
      })
        .sort({ createdAt: -1 })
        .limit(50)
        .lean();
      return docs.map(toClientImportBatch);
    }),

  /**
   * Roll one import back.
   *
   * Entries go unconditionally — they came from the file and nothing else
   * created them. Catalog documents only go if nothing else has come to use
   * them since, because a project invented by an import is an ordinary project
   * the moment somebody tracks against it by hand.
   *
   * Workspace settings a restore rewrote are NOT put back: everything written
   * since has snapshotted that currency, so reverting it would relabel money
   * that was really tracked in it. The batch records that it happened, and
   * changing it back is an ordinary settings edit.
   */
  undo: workspaceProcedure
    .input(importUndoSchema)
    .mutation(async ({ ctx, input }): Promise<ImportUndoResult> => {
      const workspaceId = ctx.workspaceId;
      // Scoped exactly as `history` lists them, and NOT_FOUND rather than
      // FORBIDDEN for a batch outside that scope: a distinguishable refusal
      // would answer "does this import id exist" for somebody who may not
      // see the import, and undo is a delete — a batch a member cannot list
      // is not one they may roll back by guessing its id.
      const authorScope = authorScopeFilter(ctx.visibility);
      const batch = await ImportBatch.findOne({
        _id: assertObjectId(input.batchId),
        workspaceId,
        ...(authorScope ? { createdBy: authorScope.authorId } : {}),
      });
      if (!batch) throw new TRPCError({ code: "NOT_FOUND" });

      const invoiced = await TimeEntry.exists({
        workspaceId,
        importId: input.batchId,
        invoiceId: { $ne: null },
      });
      if (invoiced) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "Some of these entries are on an invoice. Delete the invoice first, then undo the import.",
        });
      }

      const removed = await TimeEntry.deleteMany({
        workspaceId,
        importId: input.batchId,
      });

      // Pins go unconditionally, like the entries and unlike the catalog:
      // nothing else can have come to depend on one person's shortcut, and a
      // restore that left fifty of them behind after an undo would be litter
      // this batch can see and nobody else can explain.
      const unpinned = await Favorite.deleteMany({
        workspaceId,
        _id: { $in: batch.favoriteIds ?? [] },
      });
      if ((unpinned.deletedCount ?? 0) > 0 && batch.createdBy !== "") {
        publishToUser(
          batch.createdBy,
          { kind: "favorites.changed" },
          input.originId,
        );
      }

      const result: ImportUndoResult = {
        batchId: input.batchId,
        entriesDeleted: removed.deletedCount ?? 0,
        clientsDeleted: 0,
        projectsDeleted: 0,
        tasksDeleted: 0,
        tagsDeleted: 0,
        favoritesDeleted: unpinned.deletedCount ?? 0,
      };

      if (input.includeCatalog) {
        for (const id of batch.tagIds) {
          const used = await TimeEntry.exists({ workspaceId, tagIds: id });
          if (used) continue;
          await Tag.deleteOne({ _id: id, workspaceId });
          result.tagsDeleted += 1;
        }
        for (const id of batch.taskIds) {
          const used = await TimeEntry.exists({ workspaceId, taskId: id });
          if (used) continue;
          await Task.deleteOne({ _id: id, workspaceId });
          result.tasksDeleted += 1;
        }
        for (const id of batch.projectIds) {
          const used = await TimeEntry.exists({ workspaceId, projectId: id });
          if (used) continue;
          await Project.deleteOne({ _id: id, workspaceId });
          result.projectsDeleted += 1;
        }
        for (const id of batch.clientIds) {
          const used = await Project.exists({ workspaceId, clientId: id });
          if (used) continue;
          await Client.deleteOne({ _id: id, workspaceId });
          result.clientsDeleted += 1;
        }
      }

      await ImportBatch.updateOne(
        { _id: batch._id },
        { $set: { undoneAt: new Date() } },
      );

      // A batch written before `createdBy` existed has no author to name, and
      // the fan-out then fails closed: members who may see everybody's time.
      void publishSync(
        workspaceId,
        { kind: "data.imported", batchId: input.batchId, undone: true },
        input.originId,
        batch.createdBy ? { authorId: batch.createdBy } : undefined,
      );
      if (
        result.clientsDeleted +
          result.projectsDeleted +
          result.tasksDeleted +
          result.tagsDeleted >
        0
      ) {
        void publishSync(
          workspaceId,
          { kind: "catalog.changed", scope: "project" },
          input.originId,
        );
      }

      return result;
    }),

  /**
   * What the download would be, without building it.
   *
   * Counted with `exportEntryFilter`, the same filter the builder reads with,
   * so the panel warns about exactly the export that would be refused. The
   * money answer comes from the same two predicates `redactExportMoney`
   * applies, rather than from a second reading of the flags — a UI that
   * decided for itself who sees rates would eventually disagree with the file
   * it is describing.
   */
  exportInfo: workspaceProcedure
    .input(workspaceExportSchema)
    .query(async ({ ctx, input }): Promise<WorkspaceExportInfo> => {
      const entries = await TimeEntry.countDocuments(
        exportEntryFilter({
          workspaceId: ctx.workspaceId,
          authorScope: authorScopeFilter(ctx.visibility),
          dateRange: exportDateRange(input.from, input.to),
        }),
      );
      return {
        entries,
        maxEntries: MAX_EXPORT_ENTRIES,
        moneyRedacted: !exportKeepsMoney(ctx.visibility),
      };
    }),

  /**
   * The whole workspace as one JSON document — backup, and portability.
   *
   * A mutation despite writing nothing, for the reason `analyze` is one: a
   * query is a GET, which puts the request in a URL and the RESPONSE in every
   * cache between here and the browser. This response is the most sensitive
   * one this server produces — every entry, every rate, every invoice — and a
   * shared machine or a caching proxy would hand it to the next person with
   * no session at all. The panel calls it once per click; there is nothing
   * here a cache was ever going to help with.
   */
  exportJson: workspaceProcedure
    .input(workspaceExportSchema)
    .mutation(async ({ ctx, input }): Promise<WorkspaceExport> =>
      buildWorkspaceExport({
        workspaceId: ctx.workspaceId,
        from: input.from,
        to: input.to,
        visibility: ctx.visibility,
        role: ctx.membership.role,
      }),
    ),

  /**
   * Every entry as one CSV, in the column shape this app's own importer reads
   * back — so a spreadsheet round-trip is a supported way to bulk-edit
   * history, not an accident that happens to work.
   *
   * A mutation for the same cacheing reason as `exportJson` above — the two
   * doors carry the same rows and must not disagree about where they land.
   */
  exportCsv: workspaceProcedure
    .input(workspaceExportSchema)
    .mutation(
      async ({
        ctx,
        input,
      }): Promise<{ filename: string; csv: string; mimeType: string }> => {
        const data = await buildWorkspaceExport({
          workspaceId: ctx.workspaceId,
          from: input.from,
          to: input.to,
          visibility: ctx.visibility,
          role: ctx.membership.role,
        });

        return {
          filename: csvFilename(
            "entries",
            input.from ?? "all",
            input.to ?? "all",
          ),
          // English headers and values whatever the exporter's language: the
          // file is the importer's contract (services/workspace-csv.ts).
          csv: workspaceEntriesCsv(data.entries),
          mimeType: "text/csv",
        };
      },
    ),
});
