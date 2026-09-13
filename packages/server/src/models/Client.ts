import mongoose, { Schema, type Document } from "mongoose";
import { SUPPORTED_LOCALES, type Client as ClientWire, type Locale } from "@starter/shared";

export const DEFAULT_CLIENT_COLOR = "#64748b";

export interface IClient extends Document {
  workspaceId: string;
  createdBy: string;
  name: string;
  color: string;
  archived: boolean;
  /** Absent on clients written before invoices were localised. */
  invoiceLocale?: Locale | null;
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
  createdAt: Date;
  updatedAt: Date;
};

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
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}
