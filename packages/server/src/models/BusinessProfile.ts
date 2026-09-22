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
  businessProfileProblems,
  emptyBusinessProfile,
  mergeIdentityInput,
  normalizeBusinessProfile,
  type BusinessProfile as BusinessProfileWire,
  type BusinessProfileFields,
  type ElectronicAddressScheme,
  type TaxCategory,
} from "@starter/shared";
import { profileEinvoiceFields } from "./einvoice-schemas.js";
import { logoSchema } from "./logo-schema.js";
import { logoToWire, storedLogoOf, type StoredLogo } from "../services/invoice-logo.js";

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
  // E-invoice fields. Absent on rows saved before e-invoicing; they read as
  // null / false through normalizeBusinessProfile.
  vatId?: string | null;
  taxNumber?: string | null;
  registrationNumber?: string | null;
  sellerIdentifier?: string | null;
  contactName?: string | null;
  electronicAddress?: string | null;
  electronicAddressScheme?: ElectronicAddressScheme | null;
  iban?: string | null;
  bic?: string | null;
  bankName?: string | null;
  accountHolder?: string | null;
  smallBusiness?: boolean;
  smallBusinessNote?: string | null;
  defaultTaxCategory?: TaxCategory | null;
  defaultTaxRate?: number | null;
  /** The invoice logo. Absent until one is uploaded; `$unset` when removed. */
  logo?: StoredLogo | null;
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
    ...profileEinvoiceFields,
    logo: { type: logoSchema, default: undefined },
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
  const logo = storedLogoOf(doc.logo);
  return {
    workspaceId,
    ...normalizeBusinessProfile(doc),
    logo: logo ? logoToWire(logo) : null,
    // A row a logo upload created has no timestamps (see setBusinessLogo):
    // the identity was never saved, and the form reads null as exactly that.
    updatedAt: doc.updatedAt ? doc.updatedAt.toISOString() : null,
  };
}

/** The stored logo bytes, for the invoice snapshot; `null` when there are none. */
export async function getBusinessLogo(workspaceId: string): Promise<StoredLogo | null> {
  const doc = await BusinessProfileModel.findOne({ workspaceId }).select("logo").lean();
  return doc ? storedLogoOf(doc.logo) : null;
}

/**
 * Store the logo. Only the logo: the identity fields are untouched, and so
 * is `updatedAt` — the settings form re-seeds its draft on that value, and a
 * logo upload beside a half-typed address must not throw the address away.
 * A workspace with no profile row gets one holding only the logo.
 */
export async function setBusinessLogo(
  workspaceId: string,
  logo: StoredLogo,
): Promise<BusinessProfileWire> {
  await BusinessProfileModel.updateOne(
    { workspaceId },
    { $set: { logo }, $setOnInsert: { workspaceId } },
    { upsert: true, timestamps: false },
  );
  return getBusinessProfile(workspaceId);
}

/** Remove the logo. Idempotent; a profile without one is left as it is. */
export async function clearBusinessLogo(workspaceId: string): Promise<BusinessProfileWire> {
  await BusinessProfileModel.updateOne({ workspaceId }, { $unset: { logo: 1 } }, { timestamps: false });
  return getBusinessProfile(workspaceId);
}

/**
 * The merged profile breaks a cross-field rule (an electronic address without
 * a valid scheme, a default category that disagrees with its rate, a small
 * business defaulting to VAT). The message is the rule's own sentence;
 * `settings.updateBusinessProfile` turns it into BAD_REQUEST.
 */
export class BusinessProfileInvalidError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.name = "BusinessProfileInvalidError";
    this.path = path;
  }
}

/**
 * Save the profile. A key left `undefined` keeps its stored value and `null`
 * clears it, so a stale form, an older export file or an older API client
 * cannot erase a field by leaving it out. The rules that relate two fields are
 * checked on the merged row, because the input alone may carry only one side.
 *
 * Idempotent: a retry writes the same row, and a workspace gets at most one
 * because the upsert is keyed on the unique `workspaceId`.
 */
export async function saveBusinessProfile(
  workspaceId: string,
  fields: BusinessProfileFields,
): Promise<BusinessProfileWire> {
  const { workspaceId: _workspace, updatedAt: _updated, ...stored } =
    await getBusinessProfile(workspaceId);
  const raw = mergeIdentityInput<BusinessProfileFields>(stored, fields);
  // Checked before normalising, which would drop an address without its scheme.
  const [problem] = businessProfileProblems(raw, false);
  if (problem) throw new BusinessProfileInvalidError(problem.path, problem.message);
  const merged = normalizeBusinessProfile(raw);
  await BusinessProfileModel.updateOne(
    { workspaceId },
    { $set: { workspaceId, ...merged } },
    { upsert: true, runValidators: true },
  );
  return getBusinessProfile(workspaceId);
}
