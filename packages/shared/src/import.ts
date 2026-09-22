/**
 * Bulk import of time-tracking history, and the full-workspace export that is
 * its counterpart.
 *
 * The point is onboarding: somebody arriving with years of tracked time
 * elsewhere should be able to drop that history in and keep their reports,
 * rather than starting from an empty database and losing every past total.
 *
 * ── Why no per-vendor importers ──────────────────────────────────────
 *
 * Every tracker exports the same handful of facts under slightly different
 * headers: what was worked on, for which project, when it started, and how
 * long it took. So the importer is written against COLUMN SHAPES, not against
 * products: the header row is matched to {@link ImportColumnRole}s by an alias
 * table, and the resulting {@link ImportShape} says which of the three
 * layouts the file uses. A file nobody anticipated still lands, and the user
 * can re-point any column by hand ({@link ImportColumnOverride}) when the
 * guess is wrong.
 *
 * Everything here is transport-level description of a file the user picked;
 * the parsing itself lives on the server so there is exactly one
 * implementation of it (`services/import/`).
 */
import { z } from "zod";
import type { TaxBreakdownRow, TaxCategory } from "./einvoice.js";
import type { InvoiceLineKind, InvoiceLineUnit } from "./invoice-lines.js";
import type {
  BusinessProfileValues,
  ClientBilling,
  IdleBehavior,
  InvoiceIssuer,
  InvoiceRecipient,
  InvoiceStatus,
  WeekStart,
} from "./types.js";

/** Hard ceilings, enforced server-side. A file past either is refused whole. */
export const MAX_IMPORT_BYTES = 8_000_000;
export const MAX_IMPORT_ROWS = 25_000;

/** How many issues and sample rows a preview carries back. */
export const IMPORT_PREVIEW_ISSUES = 50;
export const IMPORT_PREVIEW_ROWS = 20;

/** An entry longer than this is almost certainly a parsing mistake. */
export const MAX_IMPORT_ENTRY_SEC = 24 * 60 * 60;

/**
 * What one column of the file means.
 *
 * `ignored` is a real choice, not an absence: a column the user has explicitly
 * turned off must stay off when the file is re-analyzed on commit.
 */
export const IMPORT_COLUMN_ROLES = [
  "ignored",
  "description",
  "client",
  "project",
  "task",
  "tags",
  "billable",
  /** A full date+time in one cell. */
  "start",
  "end",
  /** A date whose time of day lives in its own column — or nowhere. */
  "date",
  "startTime",
  /**
   * The day the entry ENDED, when the file keeps it apart from the day it
   * started. Without it an overnight entry that ends at 01:00 would be filed
   * as a 22-hour entry ending the same morning it began.
   */
  "endDate",
  "endTime",
  /** "01:30:00", "1.5" or "90m" — normalized to seconds. */
  "duration",
  "rate",
] as const;

export type ImportColumnRole = (typeof IMPORT_COLUMN_ROLES)[number];

export const importColumnRoleSchema = z.enum(IMPORT_COLUMN_ROLES);

/** One column of the file, with the role detection gave it. */
export type ImportColumn = {
  /** Position in the file, 0-based. Stable across re-analysis. */
  index: number;
  header: string;
  role: ImportColumnRole;
  /** True when the role came from the caller rather than from detection. */
  overridden: boolean;
  /** First non-empty value seen, so the UI can show what it is talking about. */
  sample: string | null;
};

/**
 * Which of the three layouts the file uses, decided from the roles present:
 *
 *  - `start-end`      both ends are given; duration is derived and any
 *                     duration column is only a cross-check.
 *  - `start-duration` a start plus how long it lasted.
 *  - `date-duration`  a day and a number of hours, with no clock time at all.
 *                     These get laid out back-to-back from
 *                     {@link IMPORT_DAY_START_HOUR} — see the note there.
 *  - `unusable`       not enough columns to place an entry in time.
 */
export type ImportShape =
  | "start-end"
  | "start-duration"
  | "date-duration"
  | "unusable";

/**
 * Where a date-only row's clock time comes from.
 *
 * A file that records "3.5 hours on the 4th" does not say WHEN, and an
 * importer that spread those rows from midnight would fill everybody's
 * calendar with entries at 2am. Rows are instead stacked back-to-back from
 * 09:00 local, in file order, per day — invented, but invented plausibly, and
 * stated on screen so nobody mistakes it for recorded fact.
 */
export const IMPORT_DAY_START_HOUR = 9;

/**
 * How to read `03/04/2026` — the single most damaging ambiguity in this whole
 * feature, because both readings are valid dates and a wrong guess moves an
 * entry by months without ever failing.
 *
 * It is decided per FILE, not per row: every slashed date in the file is
 * scanned, and one component exceeding 12 anywhere settles it for all of them.
 * `ymd` covers `2026/03/04`. When nothing settles it the preview says so and
 * the user can override — a guess is never made silently.
 */
export type ImportDateOrder = "dmy" | "mdy" | "ymd";

export type ImportIssueCode =
  | "unparsable-start"
  | "unparsable-end"
  | "missing-duration"
  | "nonpositive-duration"
  | "end-before-start"
  | "implausible-duration"
  | "duplicate-in-file"
  | "duplicate-existing"
  | "empty-row";

export type ImportIssue = {
  /** 1-based row number in the file, header excluded. */
  row: number;
  code: ImportIssueCode;
  message: string;
};

/** One row after normalization — the exact entry that would be written. */
export type ImportRow = {
  row: number;
  description: string;
  clientName: string | null;
  projectName: string | null;
  taskName: string | null;
  tagNames: string[];
  /** `null` means the file did not say; the workspace default decides. */
  billable: boolean | null;
  start: string;
  end: string;
  durationSec: number;
  hourlyRate: number | null;
  /**
   * Set when an identical entry already exists — earlier in the same file, or
   * already in the workspace from a previous import.
   */
  duplicateOf: "file" | "workspace" | null;
};

export type ImportFormat = "delimited" | "workspace-json";

/**
 * What a file would do to the workspace, computed without writing anything.
 *
 * The commit re-parses the same text rather than trusting a preview handed
 * back to it, so this is a description, never a token: nothing here is
 * authority to write.
 */
export type ImportPreview = {
  format: ImportFormat;
  /** The character the parser settled on — "," ";" or a tab. */
  delimiter: string;
  shape: ImportShape;
  /** Which way round the file writes slashed dates. See {@link ImportDateOrder}. */
  dateOrder: ImportDateOrder;
  /** True when nothing in the file settled the day/month question either way. */
  dateOrderAmbiguous: boolean;
  columns: ImportColumn[];
  /** Zone the wall-clock readings in the file were interpreted in. */
  timeZone: string;
  totalRows: number;
  readyRows: number;
  skippedRows: number;
  duplicateRows: number;
  totalSec: number;
  firstStart: string | null;
  lastStart: string | null;
  newClients: string[];
  newProjects: string[];
  newTasks: string[];
  newTags: string[];
  /** Capped at {@link IMPORT_PREVIEW_ISSUES}. */
  issues: ImportIssue[];
  /** Capped at {@link IMPORT_PREVIEW_ROWS}. */
  sample: ImportRow[];
  /** What the file carries besides entries, and what a commit would do with it. */
  sections: ImportSections;
};

/**
 * The non-entry half of a workspace export, described before anything is
 * written.
 *
 * It exists so the preview can say what will NOT come back — invoices above
 * all. An omission the user was never told about is indistinguishable from
 * data loss, and this is the screen where telling them still costs nothing.
 * A delimited file carries none of it and reports zeroes.
 */
export type ImportSections = {
  /** The document's own version. 1 for anything written before these sections. */
  version: 1 | 2;
  /**
   * The version the file declared when it is newer than this server
   * understands, else null. Stated on the preview: whatever the newer format
   * added is skipped, and a skip nobody mentioned reads as data loss later.
   */
  newerVersion: number | null;
  /**
   * True when the file states workspace policy a commit could restore. A v1
   * file has no settings section and still says this much: its currency.
   * The business profile counts as policy here: it is restored with the
   * settings, under the same owner/admin check, or not at all.
   */
  settings: boolean;
  /** Pins in the file. Restored onto the CALLING user, and only on request. */
  favorites: number;
  /** Invoices in the file. EXPORT-ONLY — counted so the UI can say they stay out. */
  invoices: number;
  /**
   * True when the file itself says its money was blanked on the way out (see
   * {@link WorkspaceExport.moneyRedacted}).
   *
   * Read back from the file rather than guessed at from null rates, because
   * the two are otherwise the same document: a workspace that never billed
   * anything also exports nothing but nulls. Stated on the preview because
   * this is the screen where an omission still costs nothing to mention — a
   * restore approved as complete, from a file that is not, is discovered when
   * the invoices are next needed.
   */
  moneyRedacted: boolean;
};

/** Counts written by one commit — the receipt, and what undo reverses. */
export type ImportResult = {
  batchId: string;
  entriesCreated: number;
  entriesSkipped: number;
  clientsCreated: number;
  projectsCreated: number;
  tasksCreated: number;
  tagsCreated: number;
  favoritesCreated: number;
  /**
   * True when this import also rewrote the workspace's money/calendar policy
   * or its business profile.
   */
  settingsRestored: boolean;
  totalSec: number;
  firstStart: string | null;
  lastStart: string | null;
};

/** A past import, as listed in the history table. */
export type ImportBatchSummary = ImportResult & {
  filename: string | null;
  createdAt: string;
  undoneAt: string | null;
};

/**
 * The version a fresh export is written with.
 *
 * v2 added {@link WorkspaceExportSettings}, {@link WorkspaceExportFavorite}
 * and {@link WorkspaceExportInvoice}. The bump is ADDITIVE: a v1 file still
 * imports exactly as it always did, and a v2 file read by anything older
 * drops the new sections silently, because the parser rebuilds the document
 * from the keys it knows rather than validating the whole of it.
 *
 * What the number buys is the one thing absence cannot say on its own. In a
 * v2 file a missing `favorites` means "this workspace had no pins"; in a v1
 * file it means "this file predates pins". Without the version those two are
 * the same file and a restore has to guess — reporting "0 pins restored" as
 * if it were a fact, or inventing pins that were never there.
 *
 * A version HIGHER than this is never rejected. The format exists to outlive
 * the database it was taken from, so a newer file must still yield its
 * entries: read what is understood, say which sections were not.
 */
export const WORKSPACE_EXPORT_VERSION = 2;

/** Full-workspace export — the format this importer reads back losslessly. */
export type WorkspaceExport = {
  /** See {@link WORKSPACE_EXPORT_VERSION}: additive, and v1 still reads. */
  version: 1 | 2;
  /**
   * Set by the READER only, never written by an export: the version a file
   * declared when it is higher than {@link WORKSPACE_EXPORT_VERSION}. Such a
   * file reads as the newest known version, and this is what lets the preview
   * say that sections this build does not know are skipped.
   */
  newerVersion?: number;
  exportedAt: string;
  workspaceId: string;
  currency: string;
  /**
   * Set only when the exporting member could not see other members' money, so
   * every rate in the file was blanked — entry rates included, because an
   * entry's rate is the rate card copied onto the row. Absent means the rates
   * are real — without it a restore cannot tell a redacted backup apart from
   * a workspace that genuinely never billed anything.
   *
   * Read back on import and surfaced as {@link ImportSections.moneyRedacted}.
   * A stamp nothing reads is a comment, not a guarantee.
   */
  moneyRedacted?: boolean;
  /** Workspace money and calendar policy. Absent in v1 files. */
  settings?: WorkspaceExportSettings;
  /**
   * The issuer identity printed on the workspace's invoices. Absent when the
   * profile was never filled in, in files older than profiles, and in a
   * redacted export — it carries payment details, which follow the money rule.
   */
  businessProfile?: BusinessProfileValues;
  clients: WorkspaceExportClient[];
  projects: WorkspaceExportProject[];
  tasks: WorkspaceExportTask[];
  tags: WorkspaceExportTag[];
  entries: WorkspaceExportEntry[];
  /**
   * The EXPORTING member's own pinned quick starts, never the workspace's.
   * Absent in v1 files. See {@link WorkspaceExportFavorite}.
   */
  favorites?: WorkspaceExportFavorite[];
  /**
   * Issued invoices — EXPORT-ONLY, see {@link WorkspaceExportInvoice}. Absent
   * in v1 files.
   */
  invoices?: WorkspaceExportInvoice[];
};

/**
 * The workspace half of settings — the only half a workspace file is entitled
 * to describe.
 *
 * `currency` is deliberately NOT repeated here: it is already the document's
 * top-level `currency`, and two copies of one fact can disagree with nothing
 * anywhere to detect it.
 *
 * The per-user half (time and duration format, idle detection, the runaway
 * guard) is deliberately absent, and must stay absent. `UserPreferences` is
 * keyed by userId and not by workspaceId, so writing it back from a workspace
 * file would reconfigure the importing person in EVERY workspace they belong
 * to — including ones this file never described.
 */
export type WorkspaceExportSettings = {
  /**
   * The fallback rate entries carrying none of their own are priced at.
   *
   * MONEY: `null` when the exporting member could not see other members' money
   * (the document then says so with `moneyRedacted`), and read on import as
   * "this file does not say", which leaves the destination's own rate alone.
   * Never `0` — a zero here is a real rate that prices everything at nothing.
   */
  defaultHourlyRate: number | null;
  weekStartsOn: WeekStart;
};

/**
 * One pinned quick start, referencing the catalog BY NAME like everything else
 * in this format.
 *
 * `taskName` is only meaningful beside its `projectName`: task names are
 * unique within a project, not within a workspace, so a task name alone
 * addresses nothing.
 */
export type WorkspaceExportFavorite = {
  description: string;
  clientName: string | null;
  projectName: string | null;
  taskName: string | null;
  billable: boolean;
  /**
   * Relative ordering only. `order` is dense per (workspace, user) and the
   * file knows nothing about the pins already in the destination, so an import
   * appends after them rather than writing this number through.
   */
  order: number;
};

/**
 * An issued invoice, carried so the export is a complete record — and NOT
 * restored by the importer. Four reasons, worst first:
 *
 *  1. The double-billing guard cannot survive the trip. `Invoice.entryIds` is
 *     the source of truth for "these hours are already billed", and no entry
 *     in this format has an identity to point back at (the only candidate key
 *     is the DUPLICATE fingerprint, which two distinct entries may share). A
 *     restored invoice would either bill nothing — leaving hours it already
 *     charged for looking billable — or stamp the wrong entries.
 *  2. `number` is unique per workspace in the database. Importing into a
 *     workspace that already has invoices either collides or renumbers, and
 *     renumbering rewrites the reference an accountant matches payments to.
 *  3. `status` of "sent" or "paid" asserts something that happened in the real
 *     world. Restoring one manufactures that assertion.
 *  4. An import batch that created invoices could never be undone: undo
 *     already refuses a batch whose entries are on an invoice.
 *
 * `entryIds` is therefore omitted entirely rather than exported as ids that
 * address nothing. The document is still arithmetically complete, because an
 * invoice is a snapshot: every figure on it was copied at creation and none of
 * it is re-derived from the entries.
 */
export type WorkspaceExportInvoice = {
  number: string;
  /** Snapshot of the client's name at issue time, as stored. */
  clientName: string;
  status: InvoiceStatus;
  issueDate: string;
  dueDate: string;
  /** `null` on a blank invoice, which billed no tracked time and has no period. */
  from: string | null;
  to: string | null;
  groupBy: "project" | "task";
  lineItems: WorkspaceExportInvoiceLine[];
  /** MONEY — `null` only when the export was redacted. */
  subtotal: number | null;
  /**
   * Percent (19 for 19% VAT), never an amount. `null` means no tax line at
   * all, which is not the same as a tax of 0.
   */
  taxRate: number | null;
  taxAmount: number | null;
  total: number | null;
  currency: string;
  notes: string | null;
  /**
   * The two parties as frozen on the invoice. Absent on invoices created
   * before snapshots existed, and dropped from a redacted export along with
   * the amounts. Export-only, like the rest of the invoice.
   */
  issuer?: InvoiceIssuer | null;
  recipient?: InvoiceRecipient | null;
  /**
   * MONEY — the EN 16931 VAT breakdown as stored. Absent on invoices without
   * line categories, and dropped whole from a redacted export.
   */
  taxBreakdown?: TaxBreakdownRow[];
  /** BT-20: the due sentence as frozen on the invoice. */
  paymentTerms?: string | null;
  createdAt: string;
};

export type WorkspaceExportInvoiceLine = {
  label: string;
  projectName: string | null;
  taskName: string | null;
  /** Absent on lines from before manual lines existed, which are time lines. */
  kind?: InvoiceLineKind;
  /**
   * The billed quantity. Not money, but the amount below cannot be checked
   * without it, so the two always travel together. 0 on a manual line.
   */
  seconds: number;
  hours: number;
  /** MONEY — the rate the line was billed at, never a project's rate today. */
  hourlyRate: number | null;
  currency: string;
  /** MONEY — `quantity × unitPrice`, rounded once, at creation. */
  amount: number | null;
  /** A manual line's quantity and unit. Absent on a time line (`hours` of `hour`). */
  quantity?: number;
  unit?: InvoiceLineUnit;
  /** MONEY — a manual line's price per unit; `null` only when the export was redacted. */
  unitPrice?: number | null;
  /** The line's VAT category. Absent on invoices without categories. */
  taxCategory?: TaxCategory;
  /** Percent; `null` only when the export was redacted. Present iff taxCategory is. */
  taxRate?: number | null;
};

export type WorkspaceExportClient = {
  name: string;
  color: string;
  archived: boolean;
  /**
   * Who invoices are addressed to. Absent or null for a client with none —
   * including every client in a file older than billing details. Restored
   * onto a client the import creates; an existing client keeps its own.
   */
  billing?: ClientBilling | null;
};

export type WorkspaceExportProject = {
  name: string;
  color: string;
  clientName: string | null;
  billableDefault: boolean;
  hourlyRate: number | null;
  estimatedHours: number | null;
  /**
   * MONEY — the project's budget, and the currency that budget is in. Both
   * `null` when the export was redacted: a budget currency without its amount
   * describes nothing, so the pair is blanked together rather than leaving a
   * half-fact behind. (Unlike an entry's `currency`, which is the workspace's
   * unit and stays.)
   */
  budgetAmount: number | null;
  budgetCurrency: string | null;
  /** Per-project override of what happens to idle time. Null follows the workspace. */
  idleBehavior: IdleBehavior | null;
  archived: boolean;
};

export type WorkspaceExportTask = {
  name: string;
  /** Empty in a file written before tasks had colors; the import picks one. */
  color: string;
  archived: boolean;
};

export type WorkspaceExportTag = {
  name: string;
  color: string;
  archived: boolean;
};

/**
 * Entries reference the catalog BY NAME, not by id.
 *
 * An export that carried ids would only be importable back into the workspace
 * it came from — useless for the two things this format is actually for,
 * moving to a second workspace and keeping an off-site backup that outlives
 * the database it was taken from.
 */
export type WorkspaceExportEntry = {
  description: string;
  clientName: string | null;
  projectName: string | null;
  taskName: string | null;
  tagNames: string[];
  billable: boolean;
  start: string;
  end: string | null;
  durationSec: number;
  /**
   * MONEY — and NOT the author's own, whatever the row's authorship says. It
   * is `resolveHourlyRate`'s snapshot of the project's rate (or the
   * workspace default) taken when the entry was stopped, so handing it to a
   * member who may not see the rate card republishes the card one row at a
   * time. `null` when the export was redacted.
   */
  hourlyRate: number | null;
  currency: string;
  timeZone: string | null;
};

export const importColumnOverrideSchema = z.object({
  index: z.number().int().min(0).max(512),
  role: importColumnRoleSchema,
});

export type ImportColumnOverride = z.infer<typeof importColumnOverrideSchema>;

/**
 * Everything both `analyze` and `commit` need. The two take the SAME input on
 * purpose: the preview a user approved is only meaningful if the commit reads
 * the file exactly the way the preview did, and the cheapest way to guarantee
 * that is one schema and one parser, run twice.
 */
export const importInputSchema = z.object({
  workspaceId: z.string().optional(),
  originId: z.string().max(64).optional(),
  /** Shown in the history table; never used to decide how to parse. */
  filename: z.string().max(255).optional(),
  text: z.string().min(1).max(MAX_IMPORT_BYTES),
  /** IANA zone the file's wall-clock readings are in. */
  timeZone: z.string().max(64).optional(),
  columns: z.array(importColumnOverrideSchema).max(512).optional(),
  /** Overrides the detected day/month order for slashed dates. */
  dateOrder: z.enum(["dmy", "mdy", "ymd"]).optional(),
  /** Rows matching an existing entry are skipped rather than duplicated. */
  skipDuplicates: z.boolean().optional(),
  /** Create the clients / projects / tasks / tags the file names. */
  createMissing: z.boolean().optional(),
  /** Used when the file has no billable column. */
  defaultBillable: z.boolean().optional(),
  /**
   * Also write the workspace settings a v2 export carries.
   *
   * Opt-in and off by default, in both directions. Restoring a backup into an
   * empty workspace wants it — without it the restored history is priced and
   * dated by whatever defaults the new workspace happened to have. A backfill
   * into a live workspace does not: it would change everybody's currency
   * because somebody dropped a file in. The server additionally refuses this
   * for a plain member, who is not allowed to change those fields by hand
   * either — a file upload must not be a way around a role check.
   */
  restoreSettings: z.boolean().optional(),
  /**
   * Also restore the pins a v2 export carries, onto the CALLING user. Opt-in:
   * pins are personal, and an import that silently adds fifty of them to
   * somebody's tracker is a surprise, not a restore.
   */
  restoreFavorites: z.boolean().optional(),
});

export type ImportInput = z.infer<typeof importInputSchema>;

export const importUndoSchema = z.object({
  workspaceId: z.string().optional(),
  originId: z.string().max(64).optional(),
  batchId: z.string().min(1),
  /**
   * Also delete the clients / projects / tasks / tags the import created.
   * Off by default: they may have been used by hand since.
   */
  includeCatalog: z.boolean().optional(),
});

export const workspaceExportSchema = z.object({
  workspaceId: z.string().optional(),
  /** Leave both unset to export everything ever tracked. */
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});

/**
 * What one caller's export would be, answered before the file is built.
 *
 * Both facts here are things a download cannot say in time. The count is
 * measured against the same bound the export refuses at, so "too much for one
 * file" is a warning beside a date range the user can narrow rather than an
 * error after the wait. And `moneyRedacted` is the export's own stamp
 * predicted ahead of it: a member who may not see other members' money gets a
 * file with every rate blanked, and being told that afterwards — or not at
 * all — is how an incomplete backup passes for a complete one.
 */
export type WorkspaceExportInfo = {
  /** Entries the caller would get, in the range asked about. */
  entries: number;
  /** Above this, the export refuses rather than truncating. */
  maxEntries: number;
  /**
   * True when every rate in the download would be blanked — the project rate
   * card, the workspace default, the invoice figures AND the per-entry rate
   * snapshots, which are the same card written one row at a time.
   */
  moneyRedacted: boolean;
};

export type ImportUndoResult = {
  batchId: string;
  entriesDeleted: number;
  clientsDeleted: number;
  projectsDeleted: number;
  tasksDeleted: number;
  tagsDeleted: number;
  /**
   * Pins the import created, unpinned again. Unconditional, unlike the
   * catalog: a pin is one person's shortcut and nothing else can have come to
   * depend on it, so leaving it behind would just be litter undo could see.
   */
  favoritesDeleted: number;
};
