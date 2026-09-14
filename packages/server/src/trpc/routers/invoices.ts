// IMPLEMENTED BY: invoicing agent
//
// An invoice turns billable time for ONE client over ONE date range into a
// document. Two rules make the rest of the design fall out:
//
//  - It is a SNAPSHOT. Rates, currency, the client's name and the billed
//    seconds are copied onto the document at creation, so nothing that
//    happens afterwards can rewrite a document already sent to a customer.
//  - Time is billed ONCE. `Invoice.entryIds` is the source of truth and
//    `TimeEntry.invoiceId` its denormalized index; `preview` and `create`
//    only ever consider entries with `invoiceId: null`, and `remove` must
//    clear the back-reference so the time becomes billable again.
//
// The arithmetic — which entries qualify, how they roll into lines, what the
// totals are, which status changes are legal — lives in exported pure
// functions at the top of this file. They have no database and no tRPC in
// them so `tests/invoices.test.ts` can pin the rules that matter without
// standing up Mongo.
import { TRPCError } from "@trpc/server";
import {
  canUseInvoices,
  createInvoiceSchema,
  entryAmount,
  idInputSchema,
  invoiceListSchema,
  invoicePdfSchema,
  invoicePreviewSchema,
  issuerSnapshot,
  recipientSnapshot,
  resolveInvoiceLocale,
  sumAmounts,
  updateInvoiceStatusSchema,
  type Invoice as InvoiceWire,
  type InvoiceLineItem,
  type InvoiceRecipient,
  type InvoiceStatus,
  type Locale,
  type PdfExportResult,
  type Visibility,
  type WorkspaceRole,
} from "@starter/shared";
import mongoose, { Types } from "mongoose";
import { BusinessProfileModel } from "../../models/BusinessProfile.js";
import { Client } from "../../models/Client.js";
import { Invoice, toClientInvoice, type IInvoice } from "../../models/Invoice.js";
import { Project } from "../../models/Project.js";
import {
  getOrCreateWorkspaceSettings,
  UserPreferencesModel,
} from "../../models/Settings.js";
import { Task } from "../../models/Task.js";
import { TimeEntry } from "../../models/TimeEntry.js";
import {
  invoiceNumberCandidates,
  nextInvoiceNumber,
  yearOfIsoDate,
} from "../../services/invoice-number.js";
import { invoicePdfFilename, renderInvoicePdf } from "../../services/invoice-pdf.js";
import { publishSync } from "../../ws/sync.js";
import { emitWebhookEvent } from "../../services/webhooks/emit.js";
import { workspaceProcedure, router } from "../trpc.js";

const DEFAULT_LIST_LIMIT = 50;

/**
 * Hard bound on how much time one invoice may sweep up. Exceeding it is a
 * refusal, never a truncation: an invoice that quietly billed the first
 * 20,000 entries of a range would be short by an amount nobody could see.
 */
const MAX_INVOICE_ENTRIES = 20_000;

const SECONDS_PER_HOUR = 3600;

const badRequest = (message: string): TRPCError =>
  new TRPCError({ code: "BAD_REQUEST", message });

const notFound = (message = "Invoice not found"): TRPCError =>
  new TRPCError({ code: "NOT_FOUND", message });

/**
 * Ids arrive as untrusted strings; one that could not possibly address a
 * document must read as "missing", never as a Mongoose CastError 500.
 */
const requireObjectId = (id: string, message: string): string => {
  if (!mongoose.isValidObjectId(id)) throw notFound(message);
  return id;
};

const isDuplicateKeyError = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  return (error as { code?: unknown }).code === 11000;
};

/** Round to whole cents. Money is only ever rounded at a line or a total. */
const roundCents = (value: number): number =>
  Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;

// ── the billable set (pure) ──────────────────────────────────────────

/**
 * One stopped, owner-scoped time entry as the invoicing code sees it. Built
 * from a `TimeEntry` document plus the project/task names needed for a label,
 * with no Mongoose types attached so the rules below stay testable.
 */
export type BillableCandidate = {
  id: string;
  projectId: string | null;
  projectName: string | null;
  taskId: string | null;
  taskName: string | null;
  /** Authoritative billed seconds — `durationSec`, written when it stopped. */
  seconds: number;
  /** SNAPSHOT taken when the entry stopped. Never a project's current rate. */
  hourlyRate: number | null;
  currency: string;
  /** Non-null once the entry has been billed on some invoice. */
  invoiceId: string | null;
};

/** A candidate that survived every check, with a rate proven to exist. */
export type BillableEntry = Omit<BillableCandidate, "hourlyRate"> & {
  hourlyRate: number;
};

export type BillableSelection = {
  billable: BillableEntry[];
  /**
   * Billable, un-invoiced time carrying NO rate. It cannot be billed — but
   * dropping it silently would invoice zero for work somebody did, so the
   * count travels to the UI as a warning.
   */
  skippedMissingRate: number;
  /** Entries excluded because they are already on another invoice. */
  skippedInvoiced: number;
  /** Every currency seen among the billable entries, in first-seen order. */
  currencies: string[];
};

/**
 * Split the candidates into what can be invoiced and what cannot.
 *
 * THE DOUBLE-BILLING GUARD STARTS HERE. An entry with a non-null `invoiceId`
 * has already been billed, and re-billing it is the worst bug this feature
 * can have — you have charged a customer twice for the same hour. The
 * database query already filters on it; this function checks again, because
 * defence in depth on the one rule that costs real money is cheap, and
 * because it makes the rule assertable in a unit test.
 *
 * Everything else that drops out:
 *  - a null (or non-finite) rate — see `skippedMissingRate`. A rate of `0` is
 *    a real, deliberate value ("this line is free") and IS billed;
 *  - a non-positive duration, which has nothing to bill and no warning worth
 *    raising.
 *
 * A RUNNING entry never reaches here at all: the query requires `end` to
 * exist, since you cannot bill an hour that is still being worked.
 */
export function selectBillableEntries(
  candidates: readonly BillableCandidate[],
): BillableSelection {
  const billable: BillableEntry[] = [];
  const currencies: string[] = [];
  let skippedMissingRate = 0;
  let skippedInvoiced = 0;

  for (const candidate of candidates) {
    if (candidate.invoiceId !== null && candidate.invoiceId !== undefined) {
      skippedInvoiced += 1;
      continue;
    }
    if (!Number.isFinite(candidate.seconds) || candidate.seconds <= 0) continue;
    if (
      candidate.hourlyRate === null ||
      candidate.hourlyRate === undefined ||
      !Number.isFinite(candidate.hourlyRate)
    ) {
      skippedMissingRate += 1;
      continue;
    }

    billable.push({ ...candidate, hourlyRate: candidate.hourlyRate });
    if (!currencies.includes(candidate.currency)) {
      currencies.push(candidate.currency);
    }
  }

  return { billable, skippedMissingRate, skippedInvoiced, currencies };
}

// ── grouping into lines (pure) ───────────────────────────────────────

export type InvoiceGroupBy = "project" | "task";

/** Untasked time inside a task-grouped invoice, kept per project. */
const NO_TASK_SUFFIX = ":none";

const groupBase = (
  entry: BillableEntry,
  groupBy: InvoiceGroupBy,
): { key: string; label: string; projectId: string | null; taskId: string | null } => {
  const projectLabel = entry.projectName ?? "No project";
  if (groupBy === "project") {
    return {
      key: entry.projectId ?? "none",
      label: projectLabel,
      projectId: entry.projectId,
      taskId: null,
    };
  }
  // Untasked entries from two different projects must not collapse into one
  // "No task" line, so the project id carries the key when the task id is
  // missing.
  return {
    key: entry.taskId ?? `${entry.projectId ?? "none"}${NO_TASK_SUFFIX}`,
    label: `${projectLabel} — ${entry.taskName ?? "No task"}`,
    projectId: entry.projectId,
    taskId: entry.taskId,
  };
};

/**
 * Roll the billable entries into invoice lines.
 *
 * ONE LINE PER (GROUP, RATE) — NOT ONE LINE PER GROUP. Rates are snapshotted
 * per entry, so a project whose rate went from 80 to 95 mid-range holds
 * entries at both. Averaging them into a single "87.50/h" line would print a
 * rate that was never agreed for any of that work, and the customer cannot
 * reconcile it against anything. Splitting the group means every line states
 * a rate that really applied to the hours on it, and the lines still sum to
 * the same money.
 *
 * Money is rounded ONCE PER LINE, from the line's total seconds, using the
 * shared `entryAmount` helper the reports use — so an invoice and a report
 * over the same entries agree to the cent. `hours` is the human-facing
 * quantity rounded to two decimals; `seconds` is the authority and is what
 * `amount` is derived from, so a long line is never off by the accumulated
 * rounding of its parts.
 *
 * Lines come out sorted by label, then by rate ascending, so an invoice
 * regenerated from the same entries is byte-for-byte the same document.
 */
export function invoiceLineItems(
  entries: readonly BillableEntry[],
  groupBy: InvoiceGroupBy,
): InvoiceLineItem[] {
  type Bucket = {
    key: string;
    label: string;
    projectId: string | null;
    taskId: string | null;
    hourlyRate: number;
    currency: string;
    seconds: number;
  };

  const buckets = new Map<string, Bucket>();
  /** How many distinct rates each base group carries — decides the suffix. */
  const ratesPerGroup = new Map<string, Set<number>>();

  for (const entry of entries) {
    const base = groupBase(entry, groupBy);
    const bucketKey = `${base.key}@${entry.hourlyRate}`;
    const existing = buckets.get(bucketKey);
    if (existing) {
      existing.seconds += entry.seconds;
    } else {
      buckets.set(bucketKey, {
        ...base,
        hourlyRate: entry.hourlyRate,
        currency: entry.currency,
        seconds: entry.seconds,
      });
    }

    const rates = ratesPerGroup.get(base.key) ?? new Set<number>();
    rates.add(entry.hourlyRate);
    ratesPerGroup.set(base.key, rates);
  }

  const lines = [...buckets.values()].map((bucket) => {
    // Only a split group needs the rate in its key and label; a group billed
    // at one rate keeps the plain project/task id the wire type documents.
    const split = (ratesPerGroup.get(bucket.key)?.size ?? 1) > 1;
    const line: InvoiceLineItem = {
      key: split ? `${bucket.key}@${bucket.hourlyRate}` : bucket.key,
      label: split
        ? `${bucket.label} (at ${bucket.hourlyRate.toFixed(2)}/h)`
        : bucket.label,
      projectId: bucket.projectId,
      taskId: bucket.taskId,
      seconds: bucket.seconds,
      hours: roundCents(bucket.seconds / SECONDS_PER_HOUR),
      hourlyRate: bucket.hourlyRate,
      currency: bucket.currency,
      amount: entryAmount(bucket.seconds, bucket.hourlyRate),
    };
    // Sorted on the BASE label, never the rendered one: the rate suffix is
    // text, and comparing it as text files "(at 100.00/h)" before
    // "(at 80.00/h)". The split lines of one project belong together, in
    // rate order.
    return { line, sortLabel: bucket.label, rate: bucket.hourlyRate };
  });

  lines.sort((left, right) => {
    const byLabel = left.sortLabel.localeCompare(right.sortLabel);
    if (byLabel !== 0) return byLabel;
    return left.rate - right.rate;
  });

  return lines.map((entry) => entry.line);
}

// ── totals (pure) ────────────────────────────────────────────────────

export type InvoiceTotals = {
  subtotal: number;
  taxAmount: number;
  total: number;
};

/**
 * Subtotal, tax and total.
 *
 * The subtotal sums already-rounded line amounts through `sumAmounts`, which
 * adds in integer cents — summing floats directly is how a twelve-line
 * invoice ends up a cent off its own lines. Tax is a percentage OF THE
 * SUBTOTAL, rounded once; `null` means no tax line at all (0 is a real 0%,
 * which still prints).
 */
export function invoiceTotals(
  lineItems: readonly InvoiceLineItem[],
  taxRate: number | null,
): InvoiceTotals {
  const subtotal = sumAmounts(lineItems.map((line) => line.amount));
  const taxAmount =
    taxRate === null || !Number.isFinite(taxRate)
      ? 0
      : roundCents((subtotal * taxRate) / 100);
  return { subtotal, taxAmount, total: sumAmounts([subtotal, taxAmount]) };
}

// ── status transitions (pure) ────────────────────────────────────────

/**
 * The legal moves, and only those.
 *
 * draft → sent → paid, and the same path backwards for the mistakes people
 * actually make (marked paid too early, sent by accident). Two things are
 * deliberately absent:
 *
 *  - draft → paid. Money arriving for a document nobody sent means the
 *    records disagree with reality; the fix is to send it, then mark it paid.
 *  - paid → draft. A paid invoice is a settled record. Walk it back one step
 *    at a time so the intermediate state is visible in the UI.
 *
 * Re-setting the status it already has is allowed: a retried mutation must
 * not fail just because it succeeded the first time.
 */
const ALLOWED_TRANSITIONS: Record<InvoiceStatus, readonly InvoiceStatus[]> = {
  draft: ["draft", "sent"],
  sent: ["draft", "sent", "paid"],
  paid: ["sent", "paid"],
};

export function isValidStatusTransition(
  from: InvoiceStatus,
  to: InvoiceStatus,
): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

// ── range parsing ────────────────────────────────────────────────────

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Read a range bound exactly the way `reports.ts` does: a bare "YYYY-MM-DD"
 * is the LOCAL calendar day the user picked in the date picker, and
 * `endOfDay` turns it into the EXCLUSIVE upper bound (midnight of the day
 * after). A full ISO datetime is taken as-is.
 *
 * Copied rather than imported because `reports.ts` keeps it private, and this
 * file may not edit it. The two must stay in step: an invoice that read its
 * range differently from the report the user checked it against would look
 * like a money bug.
 */
const parseRangeBound = (value: string, endOfDay: boolean): Date => {
  const dateOnly = DATE_ONLY.exec(value);
  if (dateOnly) {
    return new Date(
      Number(dateOnly[1]),
      Number(dateOnly[2]) - 1,
      Number(dateOnly[3]) + (endOfDay ? 1 : 0),
      0,
      0,
      0,
      0,
    );
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw badRequest(`Invalid date: ${value}`);
  return parsed;
};

type Range = { from: Date; to: Date };

const parseRange = (input: { from: string; to: string }): Range => {
  const from = parseRangeBound(input.from, false);
  const to = parseRangeBound(input.to, true);
  if (to.getTime() <= from.getTime()) {
    throw badRequest("`to` must be after `from`");
  }
  return { from, to };
};

// ── gathering (database) ─────────────────────────────────────────────

/**
 * A dry run of `create`: exactly the numbers that would be written, with
 * nothing persisted. Built only from shared types, so the client can restate
 * this shape without importing from the server.
 */
export type InvoicePreview = {
  clientId: string;
  clientName: string;
  groupBy: "project" | "task";
  lineItems: InvoiceLineItem[];
  subtotal: number;
  taxRate: number | null;
  taxAmount: number;
  total: number;
  currency: string;
  /** Entries that would be billed — all currently un-invoiced. */
  entryIds: string[];
  /** The number `create` would assign when the caller supplies none. */
  suggestedNumber: string;
  /**
   * Billable time in this range that carries no rate, so it CANNOT be
   * invoiced. Surfaced as a count rather than dropped, so the UI can say
   * "6 entries have no rate" instead of quietly billing less than the user
   * tracked.
   */
  skippedMissingRate: number;
  /** Entries in this range already billed on an earlier invoice. */
  skippedInvoiced: number;
  /**
   * The language `create` would snapshot when given no override: the
   * client's, else the issuer's explicit preference, else English.
   */
  locale: Locale;
};

/** Everything a preview or a create needs, gathered in one place. */
type Gathered = {
  clientName: string;
  /** The client's billing details as they stand now, for `create` to freeze. */
  recipient: InvoiceRecipient | null;
  /** The client's own invoice language, when it has one. */
  clientLocale: Locale | null;
  selection: BillableSelection;
  lineItems: InvoiceLineItem[];
  totals: InvoiceTotals;
  currency: string;
};

const assertSingleCurrency = (currencies: readonly string[]): void => {
  if (currencies.length > 1) {
    // Summing 400 EUR and 300 USD into "700" is not a rounding problem, it is
    // a fabricated number. Refuse rather than invent an exchange rate.
    throw badRequest(
      `This range mixes currencies (${currencies.join(", ")}). Invoice each currency separately.`,
    );
  }
};

/**
 * Load the client's billable time for the range and roll it into lines.
 *
 * Entry selection is by START INSTANT inside the range, not by the
 * overlap-and-clip the reports use. A report may show half of a
 * midnight-crossing entry because the other half belongs to the next report;
 * an invoice may not, because billing half an entry and then stamping the
 * whole entry `invoiceId` would strand the other half — billable nowhere,
 * visible nowhere. An entry is billed once, whole, on the invoice covering
 * the day it started.
 */
const gather = async (
  workspaceId: string,
  input: {
    clientId: string;
    from: string;
    to: string;
    groupBy: InvoiceGroupBy;
    taxRate?: number | null;
  },
): Promise<Gathered> => {
  const client = await Client.findOne({
    _id: requireObjectId(input.clientId, "Client not found"),
    workspaceId,
  })
    .select("name billing invoiceLocale")
    .lean();
  if (!client) throw notFound("Client not found");

  const range = parseRange(input);
  const settings = await getOrCreateWorkspaceSettings(workspaceId);

  const projects = await Project.find({ workspaceId, clientId: input.clientId })
    .select("_id name")
    .lean();
  const projectNames = new Map(
    projects.map((project) => [String(project._id), project.name]),
  );

  // No projects means no billable time — and an empty `$in` would match
  // everything the moment somebody edits this into a different shape, so
  // short-circuit explicitly.
  const rows =
    projects.length === 0
      ? []
      : await TimeEntry.find({
          workspaceId,
          billable: true,
          // A running entry is never invoiced: you cannot bill an hour that
          // is still being worked.
          end: { $ne: null },
          projectId: { $in: [...projectNames.keys()] },
          start: { $gte: range.from, $lt: range.to },
        })
          .select("_id projectId taskId durationSec hourlyRate currency invoiceId")
          .sort({ start: 1, _id: 1 })
          // One past the cap, so hitting it is detectable rather than a
          // silent truncation — see the refusal below.
          .limit(MAX_INVOICE_ENTRIES + 1)
          .lean();

  // Truncating here would quietly bill less time than the range contains,
  // and the user would have no way to see it. Refuse and let them narrow the
  // range instead.
  if (rows.length > MAX_INVOICE_ENTRIES) {
    throw badRequest(
      `That range holds more than ${MAX_INVOICE_ENTRIES.toLocaleString("en-US")} billable entries. Invoice a shorter period.`,
    );
  }

  const taskIds = [
    ...new Set(
      rows
        .map((row) => row.taskId)
        .filter((id): id is string => typeof id === "string" && id !== ""),
    ),
  ].filter((id) => mongoose.isValidObjectId(id));

  // Task names are only needed for a task-grouped invoice; skip the round
  // trip entirely otherwise.
  const taskNames =
    input.groupBy === "task" && taskIds.length > 0
      ? new Map(
          (await Task.find({ workspaceId, _id: { $in: taskIds } })
            .select("_id name")
            .lean()).map((task) => [String(task._id), task.name]),
        )
      : new Map<string, string>();

  const candidates: BillableCandidate[] = rows.map((row) => ({
    id: String(row._id),
    projectId: row.projectId ?? null,
    projectName: row.projectId ? projectNames.get(row.projectId) ?? null : null,
    taskId: row.taskId ?? null,
    taskName: row.taskId ? taskNames.get(row.taskId) ?? null : null,
    seconds: row.durationSec,
    hourlyRate: row.hourlyRate ?? null,
    currency: row.currency,
    invoiceId: row.invoiceId ?? null,
  }));

  const selection = selectBillableEntries(candidates);
  assertSingleCurrency(selection.currencies);

  const lineItems = invoiceLineItems(selection.billable, input.groupBy);
  const totals = invoiceTotals(lineItems, input.taxRate ?? null);

  return {
    clientName: client.name,
    recipient: recipientSnapshot(client.name, client.billing),
    clientLocale: client.invoiceLocale ?? null,
    selection,
    lineItems,
    totals,
    currency: selection.currencies[0] ?? settings.currency,
  };
};

/**
 * The language a new invoice is written in — resolved once, by
 * `resolveInvoiceLocale`, and then snapshotted onto the document.
 *
 * The issuer's preference is read without seeding a preferences document: a
 * person who never opened Settings has none, which means "system", which
 * contributes nothing here (the server has no device to resolve it against).
 */
const invoiceLocaleFor = async (
  issuerId: string,
  clientLocale: Locale | null,
  override: Locale | undefined,
): Promise<Locale> => {
  // The preference is only consulted when nothing ahead of it decides, so the
  // read is skipped then; the ORDER stays resolveInvoiceLocale's alone.
  const issuerPreference =
    override || clientLocale
      ? null
      : ((
          await UserPreferencesModel.findOne({ userId: issuerId })
            .select("locale")
            .lean()
        )?.locale ?? null);
  return resolveInvoiceLocale({ override, clientLocale, issuerPreference });
};

/**
 * The numbers a new invoice must not collide with.
 *
 * Bounded to the most recent 500: sequences run forward, so the highest one
 * of any year is always among the newest documents, and an owner with a
 * decade of invoices should not drag the whole collection through memory to
 * find out what comes after 2026-013.
 */
const recentNumbers = async (workspaceId: string): Promise<string[]> => {
  const docs = await Invoice.find({ workspaceId })
    .select("number")
    .sort({ createdAt: -1 })
    .limit(500)
    .lean();
  return docs.map((doc) => doc.number);
};

/** The first number a create would try, from what is currently stored. */
const suggestNumber = async (workspaceId: string, year: number): Promise<string> =>
  nextInvoiceNumber(await recentNumbers(workspaceId), year);

// ── list pagination ──────────────────────────────────────────────────

export type InvoiceListResult = {
  invoices: InvoiceWire[];
  nextCursor?: string;
};

/** `<createdAt ISO>|<id>` — the same scheme `entries.list` uses. */
const encodeCursor = (invoice: InvoiceWire): string =>
  `${invoice.createdAt}|${invoice.id}`;

type DecodedCursor = { createdAt: Date; id: Types.ObjectId };

const decodeCursor = (cursor: string): DecodedCursor | null => {
  const separator = cursor.lastIndexOf("|");
  if (separator === -1) return null;
  const rawId = cursor.slice(separator + 1);
  if (!mongoose.isValidObjectId(rawId)) return null;
  const createdAtMs = Date.parse(cursor.slice(0, separator));
  if (!Number.isFinite(createdAtMs)) return null;
  return { createdAt: new Date(createdAtMs), id: new Types.ObjectId(rawId) };
};

/**
 * The refusal for a caller who may not use invoices at all, on the two
 * procedures that do not address an existing invoice. Stable, so the client
 * can explain it rather than printing a server string.
 */
export const INVOICE_PERMISSION_REQUIRED = "invoice-permission-required";

/** What the invoice gate reads off the request, and nothing more. */
type InvoiceCaller = {
  membership: { role: WorkspaceRole };
  visibility: Visibility;
};

/**
 * THE INVOICE GATE. Every procedure below asks it FIRST, before any query.
 *
 * An invoice merges whoever's billable hours fell in its range into one line,
 * so it discloses colleagues' time and money at once — `canUseInvoices` is
 * the rule (owner or admin, with both visibility flags). How a refusal reads
 * depends on what was asked:
 *
 *  - `list` answers an empty page: "no invoices you may see" is true, and a
 *    screen that lists nothing needs no error state.
 *  - Anything addressing an invoice BY ID answers NOT_FOUND, exactly as for an
 *    id that does not exist. FORBIDDEN there would confirm that the id is a
 *    real invoice in this workspace. The gate runs before the lookup, so the
 *    two answers are indistinguishable in timing as well as shape.
 *  - `preview` and `create` address no existing document, so there is nothing
 *    to hide by pretending: FORBIDDEN with {@link INVOICE_PERMISSION_REQUIRED}.
 *    It is the only honest answer, and gathering first would have read every
 *    colleague's billable entries for somebody who may see none of them.
 */
const mayUseInvoices = (caller: InvoiceCaller): boolean =>
  canUseInvoices(caller.membership.role, caller.visibility);

const requireInvoiceById = (caller: InvoiceCaller): void => {
  if (!mayUseInvoices(caller)) throw notFound();
};

const requireInvoiceAuthoring = (caller: InvoiceCaller): void => {
  if (!mayUseInvoices(caller)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: INVOICE_PERMISSION_REQUIRED,
    });
  }
};

export type InvoiceRemoveResult = {
  deleted: boolean;
  /** How many entries became billable again. */
  releasedEntries: number;
};

export const invoicesRouter = router({
  /** Roll billable time into lines WITHOUT writing anything. */
  preview: workspaceProcedure
    .input(invoicePreviewSchema)
    .query(async ({ ctx, input }): Promise<InvoicePreview> => {
      requireInvoiceAuthoring(ctx);
      const workspaceId = ctx.workspaceId;
      const gathered = await gather(workspaceId, input);
      const taxRate = input.taxRate ?? null;

      return {
        clientId: input.clientId,
        clientName: gathered.clientName,
        groupBy: input.groupBy,
        lineItems: gathered.lineItems,
        subtotal: gathered.totals.subtotal,
        taxRate,
        taxAmount: gathered.totals.taxAmount,
        total: gathered.totals.total,
        currency: gathered.currency,
        entryIds: gathered.selection.billable.map((entry) => entry.id),
        // A preview has no issue date yet, so the suggestion is sequenced by
        // the current year; `create` re-derives it from the issue date it is
        // actually given.
        suggestedNumber: await suggestNumber(workspaceId, new Date().getFullYear()),
        skippedMissingRate: gathered.selection.skippedMissingRate,
        skippedInvoiced: gathered.selection.skippedInvoiced,
        locale: await invoiceLocaleFor(ctx.user.id, gathered.clientLocale, undefined),
      };
    }),

  /**
   * Persist the preview and mark every billed entry as invoiced.
   *
   * The line items are RE-GATHERED here rather than accepted from the client.
   * A client-supplied line set would let anyone invoice numbers of their own
   * choosing against entries they may not own — and it would race, since the
   * preview the user looked at may be seconds stale.
   */
  create: workspaceProcedure
    .input(createInvoiceSchema)
    .mutation(async ({ ctx, input }): Promise<InvoiceWire> => {
      requireInvoiceAuthoring(ctx);
      const workspaceId = ctx.workspaceId;
      const gathered = await gather(workspaceId, input);
      const entryIds = gathered.selection.billable.map((entry) => entry.id);

      if (entryIds.length === 0) {
        throw badRequest(
          "There is no un-invoiced billable time for this client in that range.",
        );
      }

      const range = parseRange(input);
      const issueDate = new Date(input.issueDate);
      const dueDate = new Date(input.dueDate);
      if (Number.isNaN(issueDate.getTime()) || Number.isNaN(dueDate.getTime())) {
        throw badRequest("Invalid issue or due date");
      }
      if (dueDate.getTime() < issueDate.getTime()) {
        throw badRequest("`dueDate` cannot be before `issueDate`");
      }

      const supplied = input.number?.trim();
      // Sequenced by the ISSUE year, not today's: back-dating an invoice into
      // December must continue December's numbering, not start next year's.
      // The year is read off the ISO string rather than out of a Date, so the
      // host's zone cannot file a 1 January invoice under the previous year.
      const issueYear =
        yearOfIsoDate(input.issueDate) ?? issueDate.getUTCFullYear();
      const candidates = supplied
        ? [supplied]
        : invoiceNumberCandidates(
            nextInvoiceNumber(await recentNumbers(workspaceId), issueYear),
          );

      const issuer = issuerSnapshot(
        await BusinessProfileModel.findOne({ workspaceId }).lean(),
      );

      const draft = {
        workspaceId,
        createdBy: ctx.user.id,
        clientId: input.clientId,
        clientName: gathered.clientName,
        status: "draft" as const,
        issueDate,
        dueDate,
        from: range.from,
        to: range.to,
        groupBy: input.groupBy,
        lineItems: gathered.lineItems,
        subtotal: gathered.totals.subtotal,
        taxRate: input.taxRate ?? null,
        taxAmount: gathered.totals.taxAmount,
        total: gathered.totals.total,
        currency: gathered.currency,
        entryIds,
        notes: input.notes ?? null,
        // Both parties are frozen here and never re-read: correcting the
        // profile or the client's address afterwards must not rewrite an
        // invoice the customer already holds. Omitted rather than null when
        // there is nothing to freeze, so the document matches the old shape.
        ...(issuer ? { issuer } : {}),
        ...(gathered.recipient ? { recipient: gathered.recipient } : {}),
        // Snapshotted like every figure above: a later change to the client's
        // or the issuer's language must never re-language a sent document.
        locale: await invoiceLocaleFor(
          ctx.user.id,
          gathered.clientLocale,
          input.locale,
        ),
      };

      // Numbering is settled by the unique index on { workspaceId, number }, not
      // by a read-then-write: two concurrent creates that both read "2026-013"
      // would both propose "2026-014", and only the index can stop them. The
      // loser gets a duplicate-key error and tries the next candidate.
      let created: IInvoice | null = null;
      for (const number of candidates) {
        try {
          created = await Invoice.create({ ...draft, number });
          break;
        } catch (error) {
          if (!isDuplicateKeyError(error)) throw error;
          if (supplied) {
            throw new TRPCError({
              code: "CONFLICT",
              message: `Invoice number "${supplied}" is already used.`,
            });
          }
        }
      }
      if (!created) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Could not allocate an invoice number. Try again.",
        });
      }

      const invoiceId = String(created._id);

      // THE DOUBLE-BILLING GUARD.
      //
      // The filter carries `invoiceId: null`, so an entry that another
      // request billed between our gather and this write simply does not
      // match — and `modifiedCount` comes back short. That mismatch is the
      // only signal we get that two invoices are trying to claim the same
      // hour, so it is treated as fatal: unwind everything and make the
      // caller retry against fresh numbers, rather than issue an invoice
      // that overlaps one already sent to the customer.
      const claim = await TimeEntry.updateMany(
        { _id: { $in: entryIds }, workspaceId, invoiceId: null },
        { $set: { invoiceId } },
      );

      if (claim.modifiedCount !== entryIds.length) {
        // Release whatever this request did manage to claim, then drop the
        // half-built document. Order matters: freeing the entries first means
        // a crash mid-unwind leaves billable time and a visible draft, not
        // time stranded behind an invoice that no longer exists.
        await TimeEntry.updateMany({ workspaceId, invoiceId }, { $set: { invoiceId: null } });
        await Invoice.deleteOne({ _id: created._id, workspaceId });
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "Some of that time was invoiced by another request just now. Reload the preview and try again.",
        });
      }

      const invoice = toClientInvoice(created);
      void publishSync(
        workspaceId,
        { kind: "invoice.changed", id: invoiceId },
        input.originId,
      );
      // Fire-and-forget beside the sync publish, never awaited into the
      // failure path: an integration is a consequence of an invoice, never a
      // precondition of one. Delivery is projected at SEND time, and an
      // invoice is money end to end, so a subscription owned by somebody
      // without `canViewOthersMoney` is skipped rather than stripped.
      emitWebhookEvent(workspaceId, "invoice.created", { kind: "invoice", invoice });
      return invoice;
    }),

  /** Newest first, optionally filtered by status or client. */
  list: workspaceProcedure
    .input(invoiceListSchema)
    .query(async ({ ctx, input }): Promise<InvoiceListResult> => {
      if (!mayUseInvoices(ctx)) return { invoices: [] };
      const workspaceId = ctx.workspaceId;
      const limit = input.limit ?? DEFAULT_LIST_LIMIT;

      const conditions: Record<string, unknown>[] = [{ workspaceId }];
      if (input.status) conditions.push({ status: input.status });
      if (input.clientId) conditions.push({ clientId: input.clientId });

      if (input.cursor) {
        const cursor = decodeCursor(input.cursor);
        // An unreadable cursor is the end of the list, not a 500.
        if (!cursor) return { invoices: [] };
        conditions.push({
          $or: [
            { createdAt: { $lt: cursor.createdAt } },
            { createdAt: cursor.createdAt, _id: { $lt: cursor.id } },
          ],
        });
      }

      // One past the page, so "is there more?" needs no second query.
      const docs = await Invoice.find({ $and: conditions })
        .sort({ createdAt: -1, _id: -1 })
        .limit(limit + 1)
        .lean();

      const page = docs.slice(0, limit).map(toClientInvoice);
      const last = page[page.length - 1];
      return docs.length > limit && last
        ? { invoices: page, nextCursor: encodeCursor(last) }
        : { invoices: page };
    }),

  get: workspaceProcedure
    .input(idInputSchema)
    .query(async ({ ctx, input }): Promise<InvoiceWire> => {
      requireInvoiceById(ctx);
      const doc = await Invoice.findOne({
        _id: requireObjectId(input.id, "Invoice not found"),
        workspaceId: ctx.workspaceId,
      }).lean();
      if (!doc) throw notFound();
      return toClientInvoice(doc);
    }),

  /**
   * Status is the ONLY mutable field — the money on a sent invoice never
   * moves. An illegal step is rejected by name so the UI can explain it.
   */
  updateStatus: workspaceProcedure
    .input(updateInvoiceStatusSchema)
    .mutation(async ({ ctx, input }): Promise<InvoiceWire> => {
      requireInvoiceById(ctx);
      const workspaceId = ctx.workspaceId;
      const current = await Invoice.findOne({
        _id: requireObjectId(input.id, "Invoice not found"),
        workspaceId,
      })
        .select("status")
        .lean();
      if (!current) throw notFound();

      if (!isValidStatusTransition(current.status, input.status)) {
        throw badRequest(
          `An invoice cannot go from "${current.status}" to "${input.status}".`,
        );
      }

      const updated = await Invoice.findOneAndUpdate(
        { _id: input.id, workspaceId, status: current.status },
        { $set: { status: input.status } },
        { returnDocument: "after" },
      ).lean();
      // The `status: current.status` guard makes the write conditional on the
      // state we validated against, so a concurrent transition cannot be
      // overwritten by a decision made about a status that has since moved.
      if (!updated) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "This invoice changed status in another window. Reload it.",
        });
      }

      const invoice = toClientInvoice(updated);
      void publishSync(
        workspaceId,
        { kind: "invoice.changed", id: String(updated._id) },
        input.originId,
      );
      // `from` is the status validated against, not a re-read: by the time a
      // consumer sees this the row has moved on, and re-reading it would
      // describe a transition nobody made.
      emitWebhookEvent(workspaceId, "invoice.status_changed", {
        kind: "invoice-status",
        invoice,
        from: current.status,
        to: input.status,
      });
      return invoice;
    }),

  /**
   * Delete a DRAFT and give its time back.
   *
   * A sent or paid invoice is a record of something that left the building;
   * deleting it would leave a hole in the numbering an accountant has to
   * explain. Only a draft — a document nobody outside has seen — can go.
   */
  remove: workspaceProcedure
    .input(idInputSchema)
    .mutation(async ({ ctx, input }): Promise<InvoiceRemoveResult> => {
      requireInvoiceById(ctx);
      const workspaceId = ctx.workspaceId;
      const invoice = await Invoice.findOne({
        _id: requireObjectId(input.id, "Invoice not found"),
        workspaceId,
      })
        .select("status number")
        .lean();
      if (!invoice) throw notFound();

      if (invoice.status !== "draft") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `Invoice ${invoice.number} has been ${invoice.status} and is a record now — it cannot be deleted. Nothing may be deleted once it has left the building.`,
        });
      }

      const invoiceId = String(invoice._id);

      // Free the time FIRST, and match on `invoiceId` rather than the stored
      // `entryIds` so an entry stamped by a half-finished create is released
      // too. Deleting the invoice first would risk stranding entries behind a
      // dangling reference: billable nowhere, visible nowhere.
      const released = await TimeEntry.updateMany(
        { workspaceId, invoiceId },
        { $set: { invoiceId: null } },
      );
      await Invoice.deleteOne({ _id: invoiceId, workspaceId });

      void publishSync(
        workspaceId,
        { kind: "invoice.changed", id: invoiceId },
        input.originId,
      );
      return { deleted: true, releasedEntries: released.modifiedCount };
    }),

  /**
   * The invoice as a PDF, same base64 transport as the report exports.
   *
   * Rendered from the PERSISTED document, never from a fresh gather. An
   * invoice is a record of what was billed; re-deriving it would let a later
   * rate change or a renamed project rewrite a page the customer already has.
   */
  exportPdf: workspaceProcedure
    .input(invoicePdfSchema)
    .query(async ({ ctx, input }): Promise<PdfExportResult> => {
      requireInvoiceById(ctx);
      const doc = await Invoice.findOne({
        _id: requireObjectId(input.id, "Invoice not found"),
        workspaceId: ctx.workspaceId,
      }).lean();
      if (!doc) throw notFound();

      const invoice = toClientInvoice(doc);
      const bytes = await renderInvoicePdf(invoice, {
        generatedAt: new Date().toISOString(),
      });

      return {
        filename: invoicePdfFilename(invoice.number),
        base64: bytes.toString("base64"),
        mimeType: "application/pdf",
      };
    }),
});
