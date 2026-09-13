import mongoose, { Schema, type Document } from "mongoose";
import {
  SUPPORTED_LOCALES,
  type Invoice as InvoiceWire,
  type InvoiceLineItem,
  type InvoiceStatus,
  type Locale,
} from "@starter/shared";

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
  from: Date;
  to: Date;
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
  from: Date;
  to: Date;
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
    from: { type: Date, required: true },
    to: { type: Date, required: true },
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
    locale: { type: String, enum: [...SUPPORTED_LOCALES] },
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
    from: doc.from.toISOString(),
    to: doc.to.toISOString(),
    groupBy: doc.groupBy,
    lineItems: (doc.lineItems ?? []).map((line) => ({
      key: line.key,
      label: line.label,
      projectId: line.projectId ?? null,
      taskId: line.taskId ?? null,
      seconds: line.seconds,
      hours: line.hours,
      hourlyRate: line.hourlyRate,
      currency: line.currency,
      amount: line.amount,
    })),
    subtotal: doc.subtotal,
    taxRate: doc.taxRate ?? null,
    taxAmount: doc.taxAmount,
    total: doc.total,
    currency: doc.currency,
    entryIds: doc.entryIds ?? [],
    notes: doc.notes ?? null,
    ...(doc.locale ? { locale: doc.locale } : {}),
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}
