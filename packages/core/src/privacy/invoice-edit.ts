/**
 * Invoice writes in an encrypted workspace: create, change status, delete a
 * draft. Each is one signed change, so the invoice and the `invoiceId` stamps
 * on the entries it bills land together or not at all — the encrypted copy's
 * version of the server's double-billing guard. The chained history refuses
 * a change made against a stale head, so two devices cannot both bill the
 * same hour.
 */
import { z } from "zod";
import { createInvoiceSchema, idInputSchema, issuerSnapshot, updateInvoiceStatusSchema, type Invoice, type PrivateKind } from "@starter/shared";
import { isValidStatusTransition } from "@starter/invoice-pdf/invoice-math";
import { invoiceNumberCandidates, nextInvoiceNumber, yearOfIsoDate } from "@starter/invoice-pdf/invoice-number";
import { paymentTermsSentence } from "@starter/invoice-pdf/payment-terms";
import type { PlainPrivateRecord } from "./records.js";
import { privateViewSource, type PrivateViewOptions } from "./view-source.js";
import {
  assertPrivateInvoiceAccess, gatherPrivateInvoice, privateInvoiceFromRecord, privateInvoiceLocale, privateInvoiceNumbers, privateInvoiceRecordValue, privateInvoiceRows,
  PrivateInvoiceRefusal, PRIVATE_INVOICE_UNSUPPORTED, taxPrivateInvoice,
} from "./invoice-view.js";

const paths = ["invoices.create", "invoices.updateStatus", "invoices.remove"] as const;
export type PrivateInvoiceEditPath = typeof paths[number];
export const isPrivateInvoiceEdit = (path: string): path is PrivateInvoiceEditPath => (paths as readonly string[]).includes(path);
/** Everything an invoice write reads: the billed time, its labels and money, the parties. */
export const PRIVATE_INVOICE_EDIT_KINDS: readonly PrivateKind[] = [
  "invoices", "entries", "entryMoney", "clients", "clientMoney", "projects", "projectMoney", "tasks", "settings", "settingsMoney",
  "businessProfile", "approvals", "approvalPolicy", "members", "memberMoney",
];

const withoutOrigin = (input: unknown) => {
  const raw = z.record(z.string(), z.unknown()).parse(structuredClone(input ?? {}));
  const { originId: _origin, ...rest } = raw; void _origin; return rest;
};

export type PrivateInvoiceEditResult = Invoice | { deleted: true; releasedEntries: number };
export async function privateInvoiceEdit(options: PrivateViewOptions & { path: PrivateInvoiceEditPath; input: unknown; preferences?: unknown; now?: number; newId?: () => string }): Promise<{ records: PlainPrivateRecord[]; remove: { kind: PrivateKind; id: string; authorId: string | null }[]; result: PrivateInvoiceEditResult }> {
  const source = privateViewSource(options), { scope } = options, { check, ofKind, value } = source;
  if (!isPrivateInvoiceEdit(options.path)) throw new Error("Unsupported private invoice edit");
  assertPrivateInvoiceAccess(source);
  const raw = withoutOrigin(options.input);
  if (raw.workspaceId !== undefined && raw.workspaceId !== scope.workspaceId) throw new Error("Private invoice edit belongs to another workspace");
  const { workspaceId: _scope, ...input } = raw; void _scope;
  const now = options.now ?? Date.now(), stamp = new Date(now).toISOString();
  const rows = privateInvoiceRows(source);
  const entryRecord = (entryId: string) => {
    const record = ofKind("entries").find((row) => row.id === entryId);
    if (!record) throw new PrivateInvoiceRefusal("Some of that time changed just now. Reload the preview and try again.");
    // Encrypted workspaces have one member today; billing a colleague's
    // entry would need their signed record rewritten by someone else.
    if (record.authorId !== scope.userId) throw new PrivateInvoiceRefusal(PRIVATE_INVOICE_UNSUPPORTED);
    return record;
  };
  const stampEntry = (record: PlainPrivateRecord, invoiceId: string | null): PlainPrivateRecord => ({ ...record, value: { ...value(record), invoiceId, updatedAt: stamp } });

  if (options.path === "invoices.create") {
    const args = createInvoiceSchema.parse(input);
    const gathered = gatherPrivateInvoice(source, args, now);
    if (gathered.lineItems.length === 0) throw new PrivateInvoiceRefusal(gathered.range ? "There is no un-invoiced billable time for this client in that range." : "A blank invoice needs at least one line.");
    const issueDate = new Date(args.issueDate), dueDate = new Date(args.dueDate);
    if (Number.isNaN(issueDate.getTime()) || Number.isNaN(dueDate.getTime())) throw new PrivateInvoiceRefusal("Invalid issue or due date");
    if (dueDate.getTime() < issueDate.getTime()) throw new PrivateInvoiceRefusal("`dueDate` cannot be before `issueDate`");
    const taken = new Set(privateInvoiceNumbers(source)), supplied = args.number?.trim();
    if (supplied?.startsWith("CN-")) throw new PrivateInvoiceRefusal("invoice-reserved-number");
    if (supplied && taken.has(supplied)) throw new PrivateInvoiceRefusal(`Invoice number "${supplied}" is already used.`);
    const number = supplied ?? invoiceNumberCandidates(nextInvoiceNumber([...taken], yearOfIsoDate(args.issueDate) ?? issueDate.getUTCFullYear())).find((candidate) => !taken.has(candidate));
    if (!number) throw new PrivateInvoiceRefusal("Could not allocate an invoice number. Try again.");
    const locale = privateInvoiceLocale(gathered.clientLocale, args.locale, options.preferences);
    const { taxed, profile } = await taxPrivateInvoice(options, gathered, args, locale); check();
    const issuer = issuerSnapshot(profile);
    const storedLogo = issuer ? ofKind("businessProfile")[0] && value(ofKind("businessProfile")[0]!).logo : null;
    const invoiceId = z.uuid().parse((options.newId ?? (() => crypto.randomUUID()))());
    if (rows.some(({ invoice }) => invoice.id === invoiceId)) throw new Error("New invoice identity already exists");
    const entryIds = gathered.selection.billable.map((entry) => entry.id);
    const invoice: Invoice = {
      timezone: args.timezone ?? "UTC", id: invoiceId, workspaceId: scope.workspaceId, createdBy: scope.userId, number, clientId: args.clientId,
      clientName: gathered.clientName, status: "draft", issueDate: issueDate.toISOString(), dueDate: dueDate.toISOString(),
      from: gathered.range?.from.toISOString() ?? null, to: gathered.range?.to.toISOString() ?? null, groupBy: args.groupBy,
      lineItems: taxed.lineItems, subtotal: taxed.subtotal, taxRate: taxed.taxRate, taxAmount: taxed.taxAmount, total: taxed.total,
      currency: gathered.currency, entryIds, notes: args.notes ?? null, locale,
      ...(taxed.taxBreakdown ? { taxBreakdown: taxed.taxBreakdown } : {}),
      paymentTerms: paymentTermsSentence(locale, issuer?.paymentTermsDays ?? null, dueDate.toISOString(), { issueDateIso: issueDate.toISOString() }),
      ...(issuer ? { issuer } : {}), ...(gathered.recipient ? { recipient: gathered.recipient } : {}),
      createdAt: stamp, updatedAt: stamp,
    };
    const records: PlainPrivateRecord[] = [
      { kind: "invoices", id: invoiceId, authorId: scope.userId, value: privateInvoiceRecordValue(invoice, storedLogo ?? null) },
      ...entryIds.map((entryId) => stampEntry(entryRecord(entryId), invoiceId)),
    ];
    const result = privateInvoiceFromRecord(records[0]!.value as Record<string, unknown>);
    check(); return { records, remove: [], result };
  }

  const args = (options.path === "invoices.updateStatus" ? updateInvoiceStatusSchema : idInputSchema).parse(input) as { id: string; status?: Invoice["status"] };
  const found = rows.find(({ invoice }) => invoice.id === args.id);
  if (!found) throw new PrivateInvoiceRefusal("Invoice not found");
  const current = found.invoice;
  if (current.followThrough) throw new PrivateInvoiceRefusal(PRIVATE_INVOICE_UNSUPPORTED);

  if (options.path === "invoices.updateStatus") {
    const status = args.status!;
    if (status === "paid" && current.balance?.available === false) throw new PrivateInvoiceRefusal("invoice-balance-unavailable");
    if (!isValidStatusTransition(current.status, status)) throw new PrivateInvoiceRefusal(`An invoice cannot go from "${current.status}" to "${status}".`);
    const record: PlainPrivateRecord = { ...found.record, value: { ...value(found.record), status, updatedAt: stamp } };
    check(); return { records: [record], remove: [], result: privateInvoiceFromRecord(record.value as Record<string, unknown>) };
  }

  // remove: a draft only, and its time becomes billable again.
  if (current.status !== "draft") throw new PrivateInvoiceRefusal(`Invoice ${current.number} has been ${current.status} and is a record now — it cannot be deleted. Nothing may be deleted once it has left the building.`);
  const released = ofKind("entries").filter((row) => value(row).invoiceId === current.id);
  const records = released.map((row) => stampEntry(entryRecord(row.id), null));
  check();
  return { records, remove: [{ kind: "invoices" as const, id: current.id, authorId: found.record.authorId }], result: { deleted: true as const, releasedEntries: records.length } };
}
