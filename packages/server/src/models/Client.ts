import mongoose, { Schema, type Document } from "mongoose";
import {
  SUPPORTED_LOCALES,
  normalizeClientBilling,
  type Client as ClientWire,
  type ClientBilling,
  type Locale,
} from "@starter/shared";
import { clientBillingEinvoiceFields } from "./einvoice-schemas.js";

export const DEFAULT_CLIENT_COLOR = "#64748b";

export interface IClient extends Document {
  workspaceId: string;
  createdBy: string;
  name: string;
  color: string;
  archived: boolean;
  /** Absent on clients written before invoices were localised. */
  invoiceLocale?: Locale | null;
  /** Absent on clients written before billing details existed. */
  billing?: ClientBilling | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Structural shape accepted by {@link toClientClient} — satisfied by both a
 * `.lean()` result and a hydrated document.
 */
export type ClientDocLike = {
  _id?: unknown;
  workspaceId: string;
  createdBy: string;
  name: string;
  color: string;
  archived: boolean;
  invoiceLocale?: Locale | null;
  /** Absent on clients written before billing details existed. */
  billing?: ClientBilling | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Billing details, every field optional. The subdocument itself is NEVER
 * `required` and has no default, so a client row written before it existed
 * validates, saves and exports untouched.
 */
const clientBillingSchema = new Schema<ClientBilling>(
  {
    legalName: { type: String, default: null, maxlength: 200 },
    addressLines: { type: [String], default: [] },
    postalCode: { type: String, default: null, maxlength: 20 },
    city: { type: String, default: null, maxlength: 120 },
    country: { type: String, default: null, maxlength: 2 },
    taxId: { type: String, default: null, maxlength: 60 },
    email: { type: String, default: null, maxlength: 254 },
    reference: { type: String, default: null, maxlength: 120 },
    ...clientBillingEinvoiceFields,
  },
  { _id: false },
);

const clientSchema = new Schema<IClient>(
  {
    workspaceId: { type: String, required: true, index: true },
    // NOT `required` — mongoose's String required validator rejects ""
    // because it tests for a non-empty string, so pairing required:true
    // with default:"" makes any write that omits `createdBy` (a migration,
    // a seed, a backfill) fail with "Path `createdBy` is required".
    // Same trap as TimeEntry.description.
    createdBy: { type: String, default: "" },
    name: { type: String, required: true, maxlength: 120, trim: true },
    color: { type: String, required: true, default: DEFAULT_CLIENT_COLOR },
    archived: { type: Boolean, required: true, default: false },
    // Optional and never `required`: null/absent means "the issuer's
    // language", and every client written before this field existed has none.
    invoiceLocale: { type: String, enum: [...SUPPORTED_LOCALES, null], default: null },
    billing: { type: clientBillingSchema, default: undefined },
  },
  { timestamps: true },
);

clientSchema.index({ workspaceId: 1, archived: 1 });

export const Client = mongoose.model<IClient>("Client", clientSchema);

/** Convert a Client document into the exact wire shape. */
export function toClientClient(doc: ClientDocLike): ClientWire {
  return {
    id: String(doc._id),
    workspaceId: doc.workspaceId,
    createdBy: doc.createdBy,
    name: doc.name,
    color: doc.color,
    archived: doc.archived,
    invoiceLocale: doc.invoiceLocale ?? null,
    billing: normalizeClientBilling(doc.billing),
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}
