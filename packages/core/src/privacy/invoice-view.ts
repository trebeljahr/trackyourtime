/**
 * Invoices in an encrypted workspace, read on the device
 * (docs/private-workspace-protocol.md → "Invoices in an encrypted workspace").
 *
 * The server never sees an invoice here, so `invoices.preview`, `list` and
 * `get` are answered from the decrypted records with the same pure rules the
 * server's router uses (`@starter/invoice-pdf/invoice-math`, `invoice-lines`,
 * `resolve-tax`, `invoice-number`). A stored invoice record holds the wire
 * invoice under `_id`, plus the issuer logo bytes as the business profile
 * stores them; the wire never carries the bytes, only `hasLogo`.
 */
import { z } from "zod";
import {
  canSeeMoneyFor, canUseInvoices, clientBillingSchema, clipInterval, idInputSchema, invoiceBalance, invoiceListSchema, invoicePreviewSchema, isLocale,
  isLocalePreference, normalizeClientBilling, overlappingIntervals, parallelShares, recipientSnapshot, resolveInvoiceLocale,
  type ClientBilling, type ExemptionNotes, type Invoice, type InvoiceLineItem, type InvoiceRecipient, type LineTax, type Locale, type ManualInvoiceLineInput, type TaxBreakdownRow,
} from "@starter/shared";
import { InvoiceInputError, invoiceLineItems, parseInvoiceRange, selectBillableEntries, type BillableCandidate, type BillableSelection, type InvoiceGroupBy, type InvoiceRange } from "@starter/invoice-pdf/invoice-math";
import { InvoiceLinesError, manualLineItems } from "@starter/invoice-pdf/invoice-lines";
import { applyInvoiceTax, resolveInvoiceTax, type TaxedInvoiceFigures } from "@starter/invoice-pdf/resolve-tax";
import { nextInvoiceNumber } from "@starter/invoice-pdf/invoice-number";
import { privateBusinessProfileQuery, privateStoredBusinessLogo } from "./business-profile-view.js";
import { privateEntryReader } from "./entry-view.js";
import type { PlainPrivateRecord } from "./records.js";
import { privateQuickStartCatalog, privateViewSource, type PrivateViewOptions } from "./view-source.js";

const id = z.string().min(1).max(100);
const paths = ["invoices.list", "invoices.get", "invoices.preview"] as const;
export type PrivateInvoiceQueryPath = typeof paths[number];
export const isPrivateInvoiceQuery = (path: string): path is PrivateInvoiceQueryPath => (paths as readonly string[]).includes(path);

/** Same refusal text as the server, so the client translates it the same way. */
export const PRIVATE_INVOICE_PERMISSION_REQUIRED = "invoice-permission-required";
/** Not yet in an encrypted workspace; named so the screen can say so. */
export const PRIVATE_INVOICE_UNSUPPORTED = "This invoice action is not available in encrypted workspaces yet. Nothing was changed.";

/** A refusal the person can act on (bad range, nothing to bill): BAD_REQUEST on the server. */
export class PrivateInvoiceRefusal extends Error {
  /** The tRPC code the server would answer with, where a screen branches on it. */
  constructor(message: string, readonly code?: "CONFLICT" | "PRECONDITION_FAILED") { super(message); this.name = "PrivateInvoiceRefusal"; }
}

const MAX_INVOICE_ENTRIES = 20_000;

const storedInvoiceSchema = z.object({
  _id: id, workspaceId: id, createdBy: id, number: z.string().min(1).max(40), clientId: id, clientName: z.string().max(200),
  status: z.enum(["draft", "sent", "paid"]), issueDate: z.iso.datetime(), dueDate: z.iso.datetime(),
  from: z.iso.datetime().nullable(), to: z.iso.datetime().nullable(), groupBy: z.enum(["project", "task"]),
  lineItems: z.array(z.record(z.string(), z.unknown())), subtotal: z.number().finite(), taxRate: z.number().finite().nullable(),
  taxAmount: z.number().finite(), total: z.number().finite(), currency: z.string().regex(/^[A-Z]{3}$/), entryIds: z.array(id),
  notes: z.string().max(2_000).nullable(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
}).passthrough();

/** The wire invoice from a stored record: `_id` back to `id`, the logo bytes to `hasLogo`, balance derived. */
export function privateInvoiceFromRecord(value: Record<string, unknown>): Invoice {
  const { _id, issuer, ...rest } = storedInvoiceSchema.parse(value) as z.infer<typeof storedInvoiceSchema> & { issuer?: Record<string, unknown> | null };
  const wireIssuer = issuer ? (() => { const { logo, ...fields } = issuer; return { ...fields, ...(logo ? { hasLogo: true } : {}) }; })() : issuer;
  const wire = { ...rest, id: _id, issued: false, ...(issuer !== undefined ? { issuer: wireIssuer } : {}) } as unknown as Invoice;
  wire.balance = invoiceBalance(wire);
  return wire;
}

/** The stored value of an invoice: the wire shape under `_id`, logo bytes on the issuer, nothing derived. */
export function privateInvoiceRecordValue(invoice: Invoice, logo: unknown): Record<string, unknown> {
  const { id: invoiceId, balance: _balance, issued: _issued, deletionPending: _pending, issuer, ...rest } = invoice; void _balance; void _issued; void _pending;
  const storedIssuer = issuer ? (() => { const { hasLogo: _has, ...fields } = issuer; void _has; return { ...fields, ...(logo ? { logo } : {}) }; })() : issuer;
  return { _id: invoiceId, ...rest, ...(issuer !== undefined ? { issuer: storedIssuer } : {}) };
}

type Source = ReturnType<typeof privateViewSource>;

export function assertPrivateInvoiceAccess(source: Source): void {
  if (!canUseInvoices(source.actor.role, source.visibility)) throw new Error(PRIVATE_INVOICE_PERMISSION_REQUIRED);
}

export function privateInvoiceRows(source: Source): { record: PlainPrivateRecord; invoice: Invoice }[] {
  return source.ofKind("invoices").map((record) => {
    const invoice = privateInvoiceFromRecord(source.value(record));
    if (invoice.createdBy !== record.authorId) throw new Error("Private invoice author differs from its signed record");
    return { record, invoice };
  });
}

const newestFirst = (a: Invoice, b: Invoice) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

export type PrivateInvoicePreview = {
  clientId: string; clientName: string; groupBy: InvoiceGroupBy; lineItems: InvoiceLineItem[]; subtotal: number; taxRate: number | null;
  taxAmount: number; total: number; currency: string; entryIds: string[]; suggestedNumber: string; skippedMissingRate: number;
  skippedInvoiced: number; skippedApproval: number; locale: Locale; taxBreakdown: TaxBreakdownRow[] | null;
  resolvedTax: { lines: Array<{ key: string } & LineTax> } | null; exemptionNotes: ExemptionNotes;
};

export type PrivateInvoiceGathered = {
  clientName: string; recipient: InvoiceRecipient | null; clientBilling: ClientBilling | null; clientLocale: Locale | null;
  range: InvoiceRange | null; selection: BillableSelection; lineItems: InvoiceLineItem[]; manualLineTax: Array<{ key: string } & LineTax>; currency: string;
};

type GatherInput = { clientId: string; from?: string | undefined; to?: string | undefined; groupBy: InvoiceGroupBy; lines?: ManualInvoiceLineInput[] | undefined };

const refuse = (error: unknown): never => {
  if (error instanceof InvoiceInputError || error instanceof InvoiceLinesError) throw new PrivateInvoiceRefusal(error.message);
  throw error;
};

/**
 * The client's billable, un-invoiced, stopped time whose START lies in the
 * range, rolled into lines — the server's `gather`, over the decrypted copy.
 * Parallel entries bill their even share, against every entry of the same
 * author that overlaps them, exactly as `invoiceParallelShares` does.
 */
export function gatherPrivateInvoice(source: Source, input: GatherInput, now = Date.now()): PrivateInvoiceGathered {
  const { ofKind, value, paired, visibility } = source;
  const clientRow = ofKind("clients").find((row) => row.id === input.clientId);
  if (!clientRow) throw new PrivateInvoiceRefusal("Client not found");
  const client = z.object({ name: z.string().min(1).max(200), invoiceLocale: z.unknown().optional() }).parse(value(clientRow));
  const money = paired(clientRow, "clientMoney"), billingRaw = money.billing === undefined || money.billing === null ? null : clientBillingSchema.parse(money.billing);
  if (ofKind("approvalPolicy").length || ofKind("approvals").length) throw new PrivateInvoiceRefusal("Timesheet approvals are not available for invoices in encrypted workspaces yet.");
  let range: InvoiceRange | null = null;
  try { range = parseInvoiceRange(input); } catch (error) { refuse(error); }
  const settings = ofKind("settings"); if (settings.length > 1) throw new Error("Duplicate workspace settings");
  const workspaceCurrency = settings.length ? z.string().regex(/^[A-Z]{3}$/).parse(value(settings[0]!).currency) : "EUR";
  let selection: BillableSelection = { billable: [], skippedMissingRate: 0, skippedInvoiced: 0, currencies: [] };
  if (range) {
    const catalog = privateQuickStartCatalog(source), { quick, detailed } = privateEntryReader(source);
    const clientOf = (doc: (typeof quick)[number]["doc"]) => doc.clientId === undefined ? (doc.projectId ? catalog.projects.get(doc.projectId)?.clientId ?? null : null) : doc.clientId;
    const from = range.from.getTime(), to = range.to.getTime();
    const rows = quick.filter(({ doc }) => doc.billable && doc.end !== null && clientOf(doc) === input.clientId && Date.parse(doc.start) >= from && Date.parse(doc.start) < to);
    if (rows.length > MAX_INVOICE_ENTRIES) throw new PrivateInvoiceRefusal(`That range holds more than ${MAX_INVOICE_ENTRIES.toLocaleString("en-US")} billable entries. Invoice a shorter period.`);
    if (rows.some(({ doc }) => !canSeeMoneyFor(visibility, doc.authorId))) throw new Error(PRIVATE_INVOICE_PERMISSION_REQUIRED);
    const entries = rows.map((row) => detailed(row));
    let shares = new Map<string, { seconds: number }>();
    if (entries.length) {
      const fromMs = Math.min(...entries.map((e) => Date.parse(e.start))), toMs = Math.max(...entries.map((e) => Date.parse(e.end!)));
      const authors = new Set(entries.map((e) => e.authorId));
      const partners = quick.map(({ doc }) => doc).filter((doc) => authors.has(doc.authorId) && Date.parse(doc.start) < toMs && (doc.end === null || Date.parse(doc.end) > fromMs));
      shares = parallelShares(overlappingIntervals(partners.map((doc) => clipInterval({ id: doc.id, authorId: doc.authorId, startMs: Date.parse(doc.start), endMs: doc.end === null ? null : Date.parse(doc.end) }, { fromMs, toMs }, now))));
    }
    const candidates: BillableCandidate[] = entries.map((entry) => ({
      id: entry.id, projectId: entry.projectId, projectName: entry.projectId ? catalog.projects.get(entry.projectId)?.name ?? null : null,
      taskId: entry.taskId, taskName: entry.taskId ? catalog.tasks.get(entry.taskId)?.name ?? null : null,
      seconds: shares.get(entry.id)?.seconds ?? entry.durationSec, hourlyRate: entry.hourlyRate, currency: entry.currency, invoiceId: entry.invoiceId,
    }));
    selection = { ...selectBillableEntries(candidates.sort((a, b) => a.id < b.id ? -1 : 1)), skippedApproval: 0 };
  }
  if (selection.currencies.length > 1) throw new PrivateInvoiceRefusal(`This range mixes currencies (${selection.currencies.join(", ")}). Invoice each currency separately.`);
  const timeLines = range ? invoiceLineItems(selection.billable, input.groupBy) : [];
  const currency = selection.currencies[0] ?? workspaceCurrency;
  let manual: ReturnType<typeof manualLineItems> = { lines: [], lineTax: [] };
  try { manual = manualLineItems(input.lines ?? [], currency, new Set(timeLines.map((line) => line.key))); } catch (error) { refuse(error); }
  return {
    clientName: client.name, recipient: recipientSnapshot(client.name, billingRaw), clientBilling: normalizeClientBilling(billingRaw),
    clientLocale: isLocale(client.invoiceLocale) ? client.invoiceLocale : null, range, selection,
    lineItems: [...timeLines, ...manual.lines], manualLineTax: manual.lineTax, currency,
  };
}

export type PrivateInvoiceTaxInput = { tax?: LineTax | undefined; lineTax?: Array<LineTax & { key: string }> | undefined; taxRate?: number | null | undefined; exemptionNotes?: ExemptionNotes | undefined };

/** VAT for the gathered lines — the server's `taxGathered`, with the profile read from the encrypted copy. */
export async function taxPrivateInvoice(options: PrivateViewOptions, gathered: Pick<PrivateInvoiceGathered, "lineItems" | "clientBilling" | "manualLineTax">, input: PrivateInvoiceTaxInput, locale: Locale) {
  const profile = await privateBusinessProfileQuery({ ...options, input: {} });
  const lineTax = [...(input.lineTax ?? []), ...gathered.manualLineTax];
  const resolved = resolveInvoiceTax(gathered.lineItems.map((line) => line.key), { ...input, lineTax }, { client: gathered.clientBilling, profile, locale });
  if (resolved.kind === "unknownKeys") throw new PrivateInvoiceRefusal(`Unknown line keys: ${resolved.keys.join(", ")}`);
  const taxed: TaxedInvoiceFigures = applyInvoiceTax(gathered.lineItems, resolved, input.taxRate ?? null);
  if (resolved.kind !== "resolved") return { taxed, resolvedTax: null, exemptionNotes: {} as ExemptionNotes, profile };
  const exemptionNotes: ExemptionNotes = {};
  for (const category of ["E", "AE", "O"] as const) { const note = resolved.notes[category]; if (note !== undefined) exemptionNotes[category] = note; }
  return { taxed, resolvedTax: { lines: resolved.lines.map((line) => ({ key: line.key, category: line.category, rate: line.rate })) }, exemptionNotes, profile };
}

/** The language a new invoice is written in: override, the client's, then the issuer's preference. */
export function privateInvoiceLocale(clientLocale: Locale | null, override: Locale | undefined, preferences: unknown): Locale {
  const stored = preferences && typeof preferences === "object" ? (preferences as { locale?: unknown }).locale : undefined;
  return resolveInvoiceLocale({ override, clientLocale, issuerPreference: isLocalePreference(stored) ? stored : null });
}

export function privateInvoiceNumbers(source: Source): string[] {
  return privateInvoiceRows(source).map(({ invoice }) => invoice.number);
}

export async function privateInvoiceQuery(options: PrivateViewOptions & { path: PrivateInvoiceQueryPath; input: unknown; preferences?: unknown; now?: number }) {
  const source = privateViewSource(options), { check } = source;
  const raw = z.record(z.string(), z.unknown()).parse(options.input ?? {});
  if (raw.workspaceId !== undefined && raw.workspaceId !== options.scope.workspaceId) throw new Error("Private invoice filter belongs to another workspace");
  const { workspaceId: _scope, direction: _direction, ...input } = raw; void _scope; void _direction;
  if (options.path === "invoices.list") {
    const args = invoiceListSchema.strict().parse(input);
    if (!canUseInvoices(source.actor.role, source.visibility)) { check(); return { invoices: [] }; }
    const now = options.now ?? Date.now();
    const matching = privateInvoiceRows(source).map(({ invoice }) => invoice)
      .filter((invoice) => (!args.status || invoice.status === args.status) && (!args.clientId || invoice.clientId === args.clientId) && (!args.overdue || (invoice.balance?.overdueDays ?? 0) > 0))
      .sort(newestFirst);
    void now;
    const limit = args.limit ?? 50, start = args.cursor ? matching.findIndex((invoice) => invoice.id === args.cursor) + 1 : 0;
    if (args.cursor && start === 0) { check(); return { invoices: [] }; }
    const page = matching.slice(start, start + limit), last = page.at(-1);
    check(); return matching.length > start + limit && last ? { invoices: page, nextCursor: last.id } : { invoices: page };
  }
  assertPrivateInvoiceAccess(source);
  if (options.path === "invoices.get") {
    const args = idInputSchema.strict().parse(input), found = privateInvoiceRows(source).find(({ invoice }) => invoice.id === args.id);
    if (!found) throw new PrivateInvoiceRefusal("Invoice not found");
    check(); return found.invoice;
  }
  const args = invoicePreviewSchema.parse(input);
  const gathered = gatherPrivateInvoice(source, args, options.now);
  const locale = privateInvoiceLocale(gathered.clientLocale, undefined, options.preferences);
  const { taxed, resolvedTax, exemptionNotes } = await taxPrivateInvoice(options, gathered, args, locale); check();
  const preview: PrivateInvoicePreview = {
    clientId: args.clientId, clientName: gathered.clientName, groupBy: args.groupBy, lineItems: taxed.lineItems, subtotal: taxed.subtotal,
    taxRate: taxed.taxRate, taxAmount: taxed.taxAmount, total: taxed.total, currency: gathered.currency,
    entryIds: gathered.selection.billable.map((entry) => entry.id), suggestedNumber: nextInvoiceNumber(privateInvoiceNumbers(source), new Date(options.now ?? Date.now()).getFullYear()),
    skippedMissingRate: gathered.selection.skippedMissingRate, skippedInvoiced: gathered.selection.skippedInvoiced, skippedApproval: 0,
    locale, taxBreakdown: taxed.taxBreakdown, resolvedTax, exemptionNotes,
  };
  return preview;
}

/**
 * The stored invoice with its issuer logo's bytes, for `renderInvoicePdf`:
 * the one reader of the bytes, as `renderableInvoice` is on the server. The
 * logo is checked exactly as a stored business logo is (format, dimensions,
 * hash) before any byte reaches the renderer.
 */
export async function privateRenderableInvoice(options: PrivateViewOptions & { input: unknown }) {
  const source = privateViewSource(options);
  assertPrivateInvoiceAccess(source);
  const args = z.object({ id, workspaceId: id.optional() }).strict().parse(options.input ?? {});
  if (args.workspaceId !== undefined && args.workspaceId !== options.scope.workspaceId) throw new Error("Private invoice belongs to another workspace");
  const found = privateInvoiceRows(source).find(({ invoice }) => invoice.id === args.id);
  if (!found) throw new PrivateInvoiceRefusal("Invoice not found");
  const stored = source.value(found.record) as { issuer?: { logo?: unknown } | null };
  const { hasLogo: _has, ...issuer } = found.invoice.issuer ?? {}; void _has;
  let logo: { data: Uint8Array } | null = null;
  if (stored.issuer?.logo) {
    await privateStoredBusinessLogo(stored.issuer.logo);
    const base64 = (stored.issuer.logo as { data: { $binary: { base64: string } } }).data.$binary.base64;
    logo = { data: Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)) };
  }
  source.check();
  return { ...found.invoice, ...(found.invoice.issuer ? { issuer: { ...issuer, logo } } : {}) } as Omit<Invoice, "issuer"> & { issuer?: (Omit<NonNullable<Invoice["issuer"]>, "hasLogo"> & { logo: { data: Uint8Array } | null }) | null };
}

/**
 * The credit note of an invoice as `renderInvoicePdf` draws it — the server's
 * `exportCreditPdf`: the original's issuer (logo bytes checked), the credited
 * snapshot, numbered `CN-…`, dated the credit's own day, with no payment terms.
 */
export async function privateRenderableCredit(options: PrivateViewOptions & { input: unknown }) {
  const original = await privateRenderableInvoice(options);
  const credit = original.followThrough?.credit;
  if (!credit) throw new PrivateInvoiceRefusal("invoice-no-credit");
  return {
    ...original, ...credit.snapshot, issuer: original.issuer, number: credit.number, documentKind: "credit" as const,
    creditReference: { number: credit.originalNumber, reason: credit.reason },
    issueDate: credit.issueDate ?? credit.at.slice(0, 10), notes: credit.reason, paymentTerms: null, generatedAt: credit.at,
  };
}
