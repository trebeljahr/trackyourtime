/**
 * Invoice writes in an encrypted workspace: create, change status, delete a
 * draft. Each is one signed change, so the invoice and the `invoiceId` stamps
 * on the entries it bills land together or not at all — the encrypted copy's
 * version of the server's double-billing guard. The chained history refuses
 * a change made against a stale head, so two devices cannot both bill the
 * same hour.
 */
import { z } from "zod";
import { clientBillingSchema, createInvoiceSchema, invoiceBalance, invoiceCreditSchema, invoicePaymentSchema, idInputSchema, INVOICE_UPDATE_REFUSALS, isLocale, issuerSnapshot, normalizeClientBilling, updateInvoiceSchema, updateInvoiceStatusSchema, type ExemptionNotes, type Invoice, type LineTax, type Locale, type PrivateKind } from "@starter/shared";
import { InvoiceLinesError, mergeDraftLines } from "@starter/invoice-pdf/invoice-lines";
import { isValidStatusTransition } from "@starter/invoice-pdf/invoice-math";
import { invoiceNumberCandidates, nextInvoiceNumber, yearOfIsoDate } from "@starter/invoice-pdf/invoice-number";
import { appendInvoicePayment, creditInvoice, creditIssueDate, InvoiceRefusalError } from "@starter/invoice-pdf/follow-through";
import { paymentTermsSentence } from "@starter/invoice-pdf/payment-terms";
import type { PlainPrivateRecord } from "./records.js";
import { privateViewSource, type PrivateViewOptions } from "./view-source.js";
import {
  assertPrivateInvoiceAccess, gatherPrivateInvoice, privateInvoiceFromRecord, privateInvoiceLocale, privateInvoiceNumbers, privateInvoiceRecordValue, privateInvoiceRows,
  PrivateInvoiceRefusal, PRIVATE_INVOICE_UNSUPPORTED, taxPrivateInvoice,
} from "./invoice-view.js";

const paths = ["invoices.create", "invoices.update", "invoices.updateStatus", "invoices.remove", "invoices.recordPayment", "invoices.credit"] as const;
export type PrivateInvoiceEditPath = typeof paths[number];
export const isPrivateInvoiceEdit = (path: string): path is PrivateInvoiceEditPath => (paths as readonly string[]).includes(path);
/** Everything an invoice write reads: the billed time, its labels and money, the parties. */
export const PRIVATE_INVOICE_EDIT_KINDS: readonly PrivateKind[] = [
  "invoices", "entries", "entryMoney", "clients", "clientMoney", "projects", "projectMoney", "tasks", "settings", "settingsMoney",
  "businessProfile", "approvals", "approvalPolicy", "members", "memberMoney",
];

/** Records hold JSON only (`z.json()` in the replica); a credit snapshot
 * copies optional invoice fields as `undefined`, which JSON drops. */
const plainJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
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

  const args = z.object({ id: z.string().min(1).max(100), status: z.enum(["draft", "sent", "paid"]).optional() }).passthrough().parse(input);
  const found = rows.find(({ invoice }) => invoice.id === args.id);
  if (!found) throw new PrivateInvoiceRefusal("Invoice not found");
  const current = found.invoice;
  const refusing = <T>(rule: () => T): T => {
    try { return rule(); } catch (error) { if (error instanceof InvoiceRefusalError) throw new PrivateInvoiceRefusal(error.message, "PRECONDITION_FAILED"); throw error; }
  };

  if (options.path === "invoices.recordPayment" || options.path === "invoices.credit") {
    // The server's `changeFollowThrough`: the ledger rule computes the next
    // follow-through, then the status follows the balance (a credit keeps it).
    const wire = structuredClone(current), at = new Date(now);
    let created: PlainPrivateRecord | null = null;
    let next;
    if (options.path === "invoices.recordPayment") {
      const payment = invoicePaymentSchema.parse(input);
      next = refusing(() => appendInvoicePayment(wire, payment, scope.userId, at));
    } else {
      const credit = invoiceCreditSchema.parse(input);
      if (!current.followThrough?.credit && rows.some(({ invoice }) => invoice.number === `CN-${current.number}`)) throw new PrivateInvoiceRefusal("invoice-credit-number-conflict", "PRECONDITION_FAILED");
      next = refusing(() => creditInvoice(wire, credit, scope.userId, at, () => crypto.randomUUID()));
      const issued = next.credit;
      // The correction draft (the server's `ensureReplacement`), written in
      // the same change as the credit so a retry finds it and adds none.
      if (issued?.replacementId && !rows.some(({ invoice }) => invoice.id === issued.replacementId)) {
        const snapshot = issued.snapshot, issueDate = creditIssueDate(issued);
        const taken = new Set(rows.map(({ invoice }) => invoice.number));
        const number = invoiceNumberCandidates(nextInvoiceNumber([...taken], Number(issueDate.slice(0, 4)))).find((candidate) => !taken.has(candidate));
        if (!number) throw new PrivateInvoiceRefusal("invoice-replacement-retry", "CONFLICT");
        const storedIssuer = (value(found.record) as { issuer?: unknown }).issuer;
        const day = new Date(issueDate).toISOString();
        const replacement: Record<string, unknown> = {
          ...structuredClone(snapshot), _id: issued.replacementId, workspaceId: scope.workspaceId, createdBy: issued.by, number, status: "draft",
          replacementFor: current.id, issueDate: day, dueDate: day, from: snapshot.from ?? null, to: snapshot.to ?? null,
          lineItems: snapshot.lineItems.map((line, index) => ({ ...line, kind: "manual", key: `manual:${String(index).padStart(12, "0")}`, quantity: 1, unit: "piece", unitPrice: line.amount, seconds: 0, hours: 0, hourlyRate: line.amount })),
          entryIds: [], notes: issued.reason, ...(current.timezone ? { timezone: current.timezone } : {}), createdAt: stamp, updatedAt: stamp,
          ...(storedIssuer !== undefined ? { issuer: storedIssuer } : {}),
        };
        if (replacement.taxBreakdown === undefined) delete replacement.taxBreakdown;
        if (replacement.issuer === undefined) delete replacement.issuer;
        if (replacement.recipient === undefined) delete replacement.recipient;
        created = { kind: "invoices", id: issued.replacementId, authorId: issued.by, value: plainJson(replacement) };
      }
    }
    const balance = invoiceBalance({ ...wire, followThrough: next });
    if (!balance.available) throw new PrivateInvoiceRefusal("invoice-balance-unavailable", "PRECONDITION_FAILED");
    const status = next.credit ? current.status : current.status === "draft" ? "draft" : balance.outstandingMinor === 0 ? "paid" : "sent";
    const body: Record<string, unknown> = plainJson({ ...value(found.record), followThrough: next, status, updatedAt: stamp });
    const record: PlainPrivateRecord = { ...found.record, value: body };
    check(); return { records: [record, ...(created ? [created] : [])], remove: [], result: privateInvoiceFromRecord(body) };
  }

  if (options.path === "invoices.update") {
    // The server's `update`: a draft only, against the version it was read
    // at, totals recomputed through the same code `create` uses.
    const edit = updateInvoiceSchema.parse(input);
    if (current.status !== "draft") throw new PrivateInvoiceRefusal(INVOICE_UPDATE_REFUSALS.notDraft, "PRECONDITION_FAILED");
    if (Date.parse(edit.updatedAt) !== Date.parse(current.updatedAt)) throw new PrivateInvoiceRefusal("This invoice changed in another window. Reload it.", "CONFLICT");
    if (edit.number?.startsWith("CN-")) throw new PrivateInvoiceRefusal("invoice-reserved-number");
    if (edit.number !== undefined && rows.some(({ invoice }) => invoice.id !== current.id && invoice.number === edit.number)) throw new PrivateInvoiceRefusal(`Invoice number "${edit.number}" is already used.`, "CONFLICT");
    const issueDate = new Date(edit.issueDate ?? current.issueDate), dueDate = new Date(edit.dueDate ?? current.dueDate);
    if (Number.isNaN(issueDate.getTime()) || Number.isNaN(dueDate.getTime())) throw new PrivateInvoiceRefusal("Invalid issue or due date");
    if (dueDate.getTime() < issueDate.getTime()) throw new PrivateInvoiceRefusal("`dueDate` cannot be before `issueDate`");
    const locale: Locale = edit.locale ?? (isLocale(current.locale) ? current.locale : "en");
    let built: ReturnType<typeof mergeDraftLines>;
    try { built = mergeDraftLines(current.lineItems, edit.lines, current.currency); } catch (error) { if (error instanceof InvoiceLinesError) throw new PrivateInvoiceRefusal(error.message); throw error; }
    if (built.lines.length === 0) throw new PrivateInvoiceRefusal("An invoice needs at least one line.");
    // An edit that says nothing about VAT keeps the stored categories and
    // exemption reasons; one that names VAT is resolved like a create.
    const taxTouched = edit.tax !== undefined || edit.lineTax !== undefined || edit.taxRate !== undefined || edit.exemptionNotes !== undefined || built.lineTax.length > 0;
    const keptOverrides: Array<{ key: string } & LineTax> = taxTouched ? [] : built.lines.flatMap((line) => line.taxCategory ? [{ key: line.key, category: line.taxCategory, rate: line.taxRate ?? 0 }] : []);
    let keptNotes: ExemptionNotes | undefined;
    if (!taxTouched && current.taxBreakdown) {
      keptNotes = {};
      for (const row of current.taxBreakdown) if ((row.category === "E" || row.category === "AE" || row.category === "O") && row.exemptionReason) keptNotes[row.category] = row.exemptionReason;
    }
    const clientRow = ofKind("clients").find((row) => row.id === current.clientId);
    const money = clientRow ? source.paired(clientRow, "clientMoney") : null;
    const clientBilling = money?.billing ? normalizeClientBilling(clientBillingSchema.parse(money.billing)) : null;
    const { taxed } = await taxPrivateInvoice(options, { lineItems: built.lines, clientBilling, manualLineTax: built.lineTax }, {
      tax: edit.tax, lineTax: [...keptOverrides, ...(edit.lineTax ?? [])], taxRate: edit.taxRate === undefined ? current.taxRate : edit.taxRate, exemptionNotes: edit.exemptionNotes ?? keptNotes,
    }, locale); check();
    // BT-20 is frozen with the dates it explains; a moved date or a new
    // language re-freezes it from the snapshot's own terms.
    const datesChanged = issueDate.getTime() !== Date.parse(current.issueDate) || dueDate.getTime() !== Date.parse(current.dueDate);
    const localeChanged = edit.locale !== undefined && edit.locale !== current.locale;
    const body: Record<string, unknown> = {
      ...value(found.record),
      ...(edit.number !== undefined ? { number: edit.number } : {}),
      issueDate: issueDate.toISOString(), dueDate: dueDate.toISOString(),
      ...(edit.notes !== undefined ? { notes: edit.notes } : {}),
      ...(edit.locale !== undefined ? { locale: edit.locale } : {}),
      lineItems: taxed.lineItems, subtotal: taxed.subtotal, taxRate: taxed.taxRate, taxAmount: taxed.taxAmount, total: taxed.total, updatedAt: stamp,
    };
    if (taxed.taxBreakdown) body.taxBreakdown = taxed.taxBreakdown; else delete body.taxBreakdown;
    if (current.paymentTerms !== undefined && (datesChanged || localeChanged)) body.paymentTerms = paymentTermsSentence(locale, current.issuer?.paymentTermsDays ?? null, dueDate.toISOString(), { issueDateIso: issueDate.toISOString() });
    const record: PlainPrivateRecord = { ...found.record, value: body };
    check(); return { records: [record], remove: [], result: privateInvoiceFromRecord(body) };
  }

  if (options.path === "invoices.updateStatus") {
    const status = updateInvoiceStatusSchema.parse(input).status;
    if (current.followThrough?.credit || (status !== current.status && current.followThrough?.payments !== undefined)) throw new PrivateInvoiceRefusal("invoice-use-payment-ledger");
    if (status === "paid" && current.balance?.available === false) throw new PrivateInvoiceRefusal("invoice-balance-unavailable");
    if (!isValidStatusTransition(current.status, status)) throw new PrivateInvoiceRefusal(`An invoice cannot go from "${current.status}" to "${status}".`);
    const record: PlainPrivateRecord = { ...found.record, value: { ...value(found.record), status, updatedAt: stamp } };
    check(); return { records: [record], remove: [], result: privateInvoiceFromRecord(record.value as Record<string, unknown>) };
  }

  // remove: a draft only, and its time becomes billable again.
  idInputSchema.parse(input);
  if (current.replacementFor) throw new PrivateInvoiceRefusal("invoice-replacement-edit-or-issue");
  if (current.status !== "draft") throw new PrivateInvoiceRefusal(`Invoice ${current.number} has been ${current.status} and is a record now — it cannot be deleted. Nothing may be deleted once it has left the building.`);
  const released = ofKind("entries").filter((row) => value(row).invoiceId === current.id);
  const records = released.map((row) => stampEntry(entryRecord(row.id), null));
  check();
  return { records, remove: [{ kind: "invoices" as const, id: current.id, authorId: found.record.authorId }], result: { deleted: true as const, releasedEntries: records.length } };
}
