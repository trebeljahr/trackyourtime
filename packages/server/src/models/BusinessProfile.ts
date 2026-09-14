// The workspace's own business identity — the issuer block of its invoices.
//
// One document per workspace, created on first save and never before: a
// workspace nobody has filled in has no row, and reads answer the empty
// profile. Every field is optional and blank is `null`, the rule
// `normalizeBusinessProfile` enforces on every write.
//
// Nothing here is read when an invoice renders. `invoices.create` copies the
// profile onto the invoice (`issuer`), so correcting an address later cannot
// rewrite a document that has already been sent.
import mongoose, { Schema, type Document } from "mongoose";
import {
  emptyBusinessProfile,
  normalizeBusinessProfile,
  type BusinessProfile as BusinessProfileWire,
  type BusinessProfileFields,
} from "@starter/shared";

export interface IBusinessProfile extends Document {
  workspaceId: string;
  legalName: string | null;
  addressLines: string[];
  postalCode: string | null;
  city: string | null;
  country: string | null;
  taxId: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  paymentDetails: string | null;
  paymentTermsDays: number | null;
  invoiceFooter: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const businessProfileSchema = new Schema<IBusinessProfile>(
  {
    workspaceId: { type: String, required: true, unique: true },
    legalName: { type: String, default: null, maxlength: 200 },
    addressLines: { type: [String], default: [] },
    postalCode: { type: String, default: null, maxlength: 20 },
    city: { type: String, default: null, maxlength: 120 },
    country: { type: String, default: null, maxlength: 2 },
    taxId: { type: String, default: null, maxlength: 60 },
    email: { type: String, default: null, maxlength: 254 },
    phone: { type: String, default: null, maxlength: 40 },
    website: { type: String, default: null, maxlength: 200 },
    paymentDetails: { type: String, default: null, maxlength: 1_000 },
    paymentTermsDays: { type: Number, default: null, min: 0, max: 365 },
    invoiceFooter: { type: String, default: null, maxlength: 500 },
  },
  { timestamps: true },
);

export const BusinessProfileModel = mongoose.model<IBusinessProfile>(
  "BusinessProfile",
  businessProfileSchema,
);

/** The workspace's profile, or the empty one when it was never saved. */
export async function getBusinessProfile(
  workspaceId: string,
): Promise<BusinessProfileWire> {
  const doc = await BusinessProfileModel.findOne({ workspaceId }).lean();
  if (!doc) return emptyBusinessProfile(workspaceId);
  return {
    workspaceId,
    ...normalizeBusinessProfile(doc),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

/**
 * Replace the whole profile. Idempotent: a retry writes the same row, and a
 * workspace gets at most one because the upsert is keyed on the unique
 * `workspaceId`.
 */
export async function saveBusinessProfile(
  workspaceId: string,
  fields: BusinessProfileFields,
): Promise<BusinessProfileWire> {
  await BusinessProfileModel.updateOne(
    { workspaceId },
    { $set: { workspaceId, ...normalizeBusinessProfile(fields) } },
    { upsert: true, runValidators: true },
  );
  return getBusinessProfile(workspaceId);
}
