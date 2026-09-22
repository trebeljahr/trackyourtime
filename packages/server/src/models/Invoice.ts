import mongoose, { Schema, type Document } from "mongoose";
import {
  normalizeIssuer,
  normalizeRecipient,
  type Invoice as InvoiceWire,
  type InvoiceIssuer,
  type InvoiceLineItem,
  type InvoiceRecipient,
  type InvoiceStatus,
  type Locale,
  type TaxBreakdownRow,
} from "@starter/shared";
import {
  einvoiceMetaSchema,
  issuerIdentityFields,
  lineTaxFields,
  recipientIdentityFields,
  taxBreakdownRowSchema,
  type EinvoiceMetaDoc,
} from "./einvoice-schemas.js";

/**
 * An invoice is a SNAPSHOT, not a query.
 *
 * Every figure on it — the client's name, each line's rate and currency, the
 * seconds billed — is copied onto the document at creation. Nothing is
 * re-derived at read time, so renaming a client or changing a project's rate
 * afterwards can never rewrite a document that has already been sent to a
 * customer.
 */
export interface IInvoice extends Document {
  workspaceId: string;
  createdBy: string;
  number: string;
  clientId: string;
  clientName: string;
  status: InvoiceStatus;
  issueDate: Date;
  dueDate: Date;
  /** The billed range; `null` on a blank invoice (no tracked time, no period). */
  from: Date | null;
  to: Date | null;
  groupBy: "project" | "task";
  lineItems: InvoiceLineItem[];
  subtotal: number;
  taxRate: number | null;
  taxAmount: number;
  total: number;
  currency: string;
  entryIds: string[];
  notes: string | null;
  /** Snapshotted at creation; absent on invoices issued before localisation (English). */
  locale?: Locale | null;
  /** Snapshotted at creation; absent on invoices issued before issuer profiles. */
  issuer?: InvoiceIssuer | null;
  /** Snapshotted at creation; absent when the client had no billing details. */
  recipient?: InvoiceRecipient | null;
  /** EN 16931 VAT breakdown; absent when the lines carry no categories. */
  taxBreakdown?: TaxBreakdownRow[] | null;
  /** BT-20, frozen at create or fill; absent on invoices from before e-invoicing. */
  paymentTerms?: string | null;
  /** Fill audit and stored issued XML. `issuedXml` never reaches the wire. */
  einvoice?: EinvoiceMetaDoc | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Structural shape accepted by {@link toClientInvoice} — satisfied by both a
 * `.lean()` result and a hydrated document.
 */
export type InvoiceDocLike = {
  _id?: unknown;
  workspaceId: string;
  createdBy: string;
  number: string;
  clientId: string;
  clientName: string;
  status: InvoiceStatus;
  issueDate: Date;
  dueDate: Date;
  /** `null` (or, on a lean read of an old row, never absent) on a blank invoice. */
  from: Date | null;
  to: Date | null;
  groupBy: "project" | "task";
  lineItems: InvoiceLineItem[];
  subtotal: number;
  taxRate: number | null;
  taxAmount: number;
  total: number;
  currency: string;
  entryIds: string[];
  notes: string | null;
  locale?: Locale | null;
  /** Snapshotted at creation; absent on invoices issued before issuer profiles. */
  issuer?: InvoiceIssuer | null;
  /** Snapshotted at creation; absent when the client had no billing details. */
  recipient?: InvoiceRecipient | null;
  /** EN 16931 VAT breakdown; absent when the lines carry no categories. */
  taxBreakdown?: TaxBreakdownRow[] | null;
  /** BT-20, frozen at create or fill; absent on invoices from before e-invoicing. */
  paymentTerms?: string | null;
  /** Fill audit and stored issued XML. `issuedXml` never reaches the wire. */
  einvoice?: EinvoiceMetaDoc | null;
  createdAt: Date;
  updatedAt: Date;
};

const lineItemSchema = new Schema<InvoiceLineItem>(
  {
    key: { type: String, required: true },
    label: { type: String, required: true, maxlength: 300 },
    projectId: { type: String, default: null },
    taskId: { type: String, default: null },
    seconds: { type: Number, required: true, min: 0 },
    hours: { type: Number, required: true, min: 0 },
    hourlyRate: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true },
    amount: { type: Number, required: true },
    // Manual-line keys, and the explicit quantity of a time line written since
    // they exist. No defaults and no `enum` (models/README.md): a row from
    // before reads as a time line through `lineKind`, and a unit a newer
    // release may add must not fail a save here.
    kind: { type: String },
    quantity: { type: Number, min: 0 },
    unit: { type: String },
    unitPrice: { type: Number, min: 0 },
    ...lineTaxFields,
  },
  { _id: false },
);

// Snapshot subdocuments. Every field optional; the subdocuments themselves
// have no default, for the same reason `locale` has none: a default applied
// to an old invoice on read would invent an issuer it was never sent with.
const issuerSchema = new Schema<InvoiceIssuer>(
  {
    legalName: { type: String, default: null },
    addressLines: { type: [String], default: [] },
    postalCode: { type: String, default: null },
    city: { type: String, default: null },
    country: { type: String, default: null },
    taxId: { type: String, default: null },
    email: { type: String, default: null },
    phone: { type: String, default: null },
    website: { type: String, default: null },
    paymentDetails: { type: String, default: null },
    paymentTermsDays: { type: Number, default: null },
    invoiceFooter: { type: String, default: null },
    ...issuerIdentityFields,
  },
  { _id: false },
);

const recipientSchema = new Schema<InvoiceRecipient>(
  {
    name: { type: String, required: true },
    legalName: { type: String, default: null },
    addressLines: { type: [String], default: [] },
    postalCode: { type: String, default: null },
    city: { type: String, default: null },
    country: { type: String, default: null },
    taxId: { type: String, default: null },
    email: { type: String, default: null },
    reference: { type: String, default: null },
    ...recipientIdentityFields,
  },
  { _id: false },
);

const invoiceSchema = new Schema<IInvoice>(
  {
    // No `index: true` here — the compound indexes below already cover
    // workspaceId, and declaring both makes mongoose warn about a duplicate.
    workspaceId: { type: String, required: true },
    createdBy: { type: String, required: true, default: "" },
    number: { type: String, required: true, maxlength: 40, trim: true },
    clientId: { type: String, required: true },
    clientName: { type: String, required: true, maxlength: 120 },
    status: {
      // Must stay in lockstep with InvoiceStatus — a drifted enum surfaces as
      // a ValidationError deep inside a mutation, not at startup.
      type: String,
      enum: ["draft", "sent", "paid"],
      required: true,
      default: "draft",
    },
    issueDate: { type: Date, required: true },
    dueDate: { type: Date, required: true },
    // A blank invoice bills no tracked time and has no period: both null,
    // written as such, so a blank row and a ranged row are told apart by the
    // value and never by a missing key.
    from: { type: Date, default: null },
    to: { type: Date, default: null },
    groupBy: {
      type: String,
      enum: ["project", "task"],
      required: true,
      default: "project",
    },
    lineItems: { type: [lineItemSchema], default: [] },
    subtotal: { type: Number, required: true, default: 0 },
    taxRate: { type: Number, default: null },
    taxAmount: { type: Number, required: true, default: 0 },
    total: { type: Number, required: true, default: 0 },
    currency: { type: String, required: true, default: "EUR" },
    entryIds: { type: [String], default: [] },
    notes: { type: String, default: null, maxlength: 2_000 },
    // A snapshot like every figure above, so NO default: a default would be
    // applied on read to invoices that predate localisation and could later be
    // changed, re-languaging documents already sent. Absent reads as English.
    // No enum either: a copied value is checked where it is resolved
    // (`invoiceLocaleFor`), and a newer release's locale must not fail a
    // create here (models/README.md).
    locale: { type: String },
    issuer: { type: issuerSchema, default: undefined },
    recipient: { type: recipientSchema, default: undefined },
    // Snapshots too: no defaults, so a legacy invoice reads and saves untouched.
    taxBreakdown: { type: [taxBreakdownRowSchema], default: undefined },
    paymentTerms: { type: String, maxlength: 500 },
    einvoice: { type: einvoiceMetaSchema, default: undefined },
  },
  { timestamps: true },
);

/** The invoice list is "newest first, for this owner". */
invoiceSchema.index({ workspaceId: 1, createdAt: -1 });
invoiceSchema.index({ workspaceId: 1, status: 1, createdAt: -1 });
invoiceSchema.index({ workspaceId: 1, clientId: 1, createdAt: -1 });

/**
 * Invoice numbers are the thing accountants match payments against, so two
 * documents sharing one is a real-world problem, not a cosmetic one. The
 * uniqueness lives in the database because the router's own "next number"
 * read-then-write is racy under two concurrent creates.
 */
invoiceSchema.index({ workspaceId: 1, number: 1 }, { unique: true });

export const Invoice = mongoose.model<IInvoice>("Invoice", invoiceSchema);

/** Convert an Invoice document into the exact wire shape. */
export function toClientInvoice(doc: InvoiceDocLike): InvoiceWire {
  return {
    id: String(doc._id),
    workspaceId: doc.workspaceId,
    createdBy: doc.createdBy,
    number: doc.number,
    clientId: doc.clientId,
    clientName: doc.clientName,
    status: doc.status,
    issueDate: doc.issueDate.toISOString(),
    dueDate: doc.dueDate.toISOString(),
    // A blank invoice has no period; a row from before blank invoices always
    // has both dates.
    from: doc.from ? doc.from.toISOString() : null,
    to: doc.to ? doc.to.toISOString() : null,
    groupBy: doc.groupBy,
    lineItems: (doc.lineItems ?? []).map(copyLineItem),
    subtotal: doc.subtotal,
    taxRate: doc.taxRate ?? null,
    taxAmount: doc.taxAmount,
    total: doc.total,
    currency: doc.currency,
    entryIds: doc.entryIds ?? [],
    notes: doc.notes ?? null,
    ...(doc.locale ? { locale: doc.locale } : {}),
    issuer: doc.issuer ? normalizeIssuer(doc.issuer) : null,
    recipient: doc.recipient ? normalizeRecipient(doc.recipient) : null,
    // Each e-invoice field only when the document has it, so an invoice from
    // before e-invoicing serialises exactly as it did.
    ...(doc.taxBreakdown && doc.taxBreakdown.length > 0
      ? { taxBreakdown: doc.taxBreakdown.map(copyBreakdownRow) }
      : {}),
    ...(doc.paymentTerms !== undefined ? { paymentTerms: doc.paymentTerms ?? null } : {}),
    ...(doc.einvoice?.fills && doc.einvoice.fills.length > 0
      ? {
          einvoiceFills: doc.einvoice.fills.map((fill) => ({
            at: fill.at.toISOString(),
            by: fill.by,
            fields: [...(fill.fields ?? [])],
          })),
        }
      : {}),
    // einvoice.issuedXml is deliberately never mapped.
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

/**
 * A plain copy of a stored line. The manual-line keys (`kind`, `quantity`,
 * `unit`, `unitPrice`) and the VAT pair appear only when the row has them, so
 * a line written before either existed serialises exactly as it did.
 */
export function copyLineItem(line: InvoiceLineItem): InvoiceLineItem {
  return {
    key: line.key,
    label: line.label,
    projectId: line.projectId ?? null,
    taskId: line.taskId ?? null,
    ...(line.kind ? { kind: line.kind } : {}),
    seconds: line.seconds,
    hours: line.hours,
    hourlyRate: line.hourlyRate,
    currency: line.currency,
    amount: line.amount,
    ...(typeof line.quantity === "number" ? { quantity: line.quantity } : {}),
    ...(line.unit ? { unit: line.unit } : {}),
    ...(typeof line.unitPrice === "number" ? { unitPrice: line.unitPrice } : {}),
    ...(line.taxCategory
      ? { taxCategory: line.taxCategory, taxRate: line.taxRate ?? 0 }
      : {}),
  };
}

/** A plain copy of a stored breakdown row (a hydrated subdocument carries more). */
function copyBreakdownRow(row: TaxBreakdownRow): TaxBreakdownRow {
  return {
    category: row.category,
    rate: row.rate,
    basisAmount: row.basisAmount,
    taxAmount: row.taxAmount,
    exemptionReason: row.exemptionReason ?? null,
    exemptionReasonCode: row.exemptionReasonCode ?? null,
  };
}
