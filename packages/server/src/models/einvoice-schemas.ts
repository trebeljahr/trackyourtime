// Mongoose pieces for EN 16931 e-invoicing, spread into main's four schemas
// (BusinessProfile, Client.billing, Invoice.issuer, Invoice.recipient) so each
// model file changes by a few lines.
//
// The rule every field here follows is `Invoice.locale`'s: nothing snapshotted
// gets a default, because a default is applied when a legacy document is
// hydrated and would be written back on its next save — inventing data for a
// document already sent. Inside the profile and the client billing subdocument
// text fields use `default: null` like main's siblings: those are live rows,
// not documents a customer holds.
import { Schema } from "mongoose";
import {
  ELECTRONIC_ADDRESS_SCHEMES,
  IDENTITY_LIMITS,
  INVOICE_FORMATS,
  TAX_CATEGORIES,
  type TaxBreakdownRow,
} from "@starter/shared";

/** A stored issued XML. Never on the wire, never exported. */
export type IssuedXmlDoc = { xml: string; generatedAt: Date; generator: string };

/** `Invoice.einvoice`: the fill audit and the first issued XML per profile. */
export type EinvoiceMetaDoc = {
  fills?: Array<{ at: Date; by: string; fields: string[] }>;
  issuedXml?: { en16931?: IssuedXmlDoc | null; xrechnung?: IssuedXmlDoc | null } | null;
};

const text = (max: number) => ({ type: String, default: null, maxlength: max });

/** Snapshot text: no default, no length check (the live row already enforced one). */
const snapshotText = { type: String, default: null };

const schemeEnum = { type: String, enum: [...ELECTRONIC_ADDRESS_SCHEMES, null] };

/** Keys the issuer snapshot and the business profile share (`Invoice.issuer`). */
export const issuerIdentityFields = {
  vatId: snapshotText,
  taxNumber: snapshotText,
  registrationNumber: snapshotText,
  sellerIdentifier: snapshotText,
  contactName: snapshotText,
  electronicAddress: snapshotText,
  electronicAddressScheme: { ...schemeEnum, default: null },
  iban: snapshotText,
  bic: snapshotText,
  bankName: snapshotText,
  accountHolder: snapshotText,
  // No default: an issuer snapshot from before the flag existed says nothing.
  smallBusiness: { type: Boolean },
};

/** Keys the recipient snapshot adds to main's (`Invoice.recipient`). */
export const recipientIdentityFields = {
  vatId: snapshotText,
  electronicAddress: snapshotText,
  electronicAddressScheme: { ...schemeEnum, default: null },
};

/** The business profile's e-invoice fields. */
export const profileEinvoiceFields = {
  vatId: text(IDENTITY_LIMITS.vatId),
  taxNumber: text(IDENTITY_LIMITS.taxNumber),
  registrationNumber: text(IDENTITY_LIMITS.registrationNumber),
  sellerIdentifier: text(IDENTITY_LIMITS.sellerIdentifier),
  contactName: text(IDENTITY_LIMITS.contactName),
  electronicAddress: text(IDENTITY_LIMITS.electronicAddress),
  electronicAddressScheme: { ...schemeEnum, default: null },
  iban: text(IDENTITY_LIMITS.iban),
  bic: text(IDENTITY_LIMITS.bic),
  bankName: text(IDENTITY_LIMITS.bankName),
  accountHolder: text(IDENTITY_LIMITS.accountHolder),
  smallBusiness: { type: Boolean, default: false },
  smallBusinessNote: text(IDENTITY_LIMITS.smallBusinessNote),
  defaultTaxCategory: { type: String, enum: [...TAX_CATEGORIES, null], default: null },
  defaultTaxRate: { type: Number, min: 0, max: 100, default: null },
};

/** The client billing subdocument's e-invoice fields. */
export const clientBillingEinvoiceFields = {
  vatId: text(IDENTITY_LIMITS.vatId),
  electronicAddress: text(IDENTITY_LIMITS.electronicAddress),
  electronicAddressScheme: { ...schemeEnum, default: null },
  preferredFormat: { type: String, enum: [...INVOICE_FORMATS, null], default: null },
  defaultTaxCategory: { type: String, enum: [...TAX_CATEGORIES, null], default: null },
};

/** Per-line VAT on `Invoice.lineItems`. No defaults: absent means "not categorised". */
export const lineTaxFields = {
  taxCategory: { type: String, enum: [...TAX_CATEGORIES] },
  taxRate: { type: Number, min: 0, max: 100 },
};

/** One BG-23 row. Required inside the row is safe: a row never exists partially. */
export const taxBreakdownRowSchema = new Schema<TaxBreakdownRow>(
  {
    category: { type: String, enum: [...TAX_CATEGORIES], required: true },
    rate: { type: Number, required: true, min: 0, max: 100 },
    basisAmount: { type: Number, required: true },
    taxAmount: { type: Number, required: true },
    exemptionReason: { type: String, default: null, maxlength: IDENTITY_LIMITS.exemptionNote },
    exemptionReasonCode: { type: String, default: null },
  },
  { _id: false },
);

const issuedXmlSchema = new Schema<IssuedXmlDoc>(
  {
    xml: { type: String, required: true, maxlength: 5_000_000 },
    generatedAt: { type: Date, required: true },
    generator: { type: String, required: true },
  },
  { _id: false },
);

const einvoiceFillSchema = new Schema<{ at: Date; by: string; fields: string[] }>(
  {
    at: { type: Date, required: true },
    by: { type: String, required: true },
    fields: { type: [String], default: undefined },
  },
  { _id: false },
);

export const einvoiceMetaSchema = new Schema<EinvoiceMetaDoc>(
  {
    fills: { type: [einvoiceFillSchema], default: undefined },
    issuedXml: {
      type: new Schema(
        {
          en16931: { type: issuedXmlSchema, default: undefined },
          xrechnung: { type: issuedXmlSchema, default: undefined },
        },
        { _id: false },
      ),
      default: undefined,
    },
  },
  { _id: false },
);
