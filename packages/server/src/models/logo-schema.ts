// The logo subdocument, shared by the business profile (the live row) and
// `Invoice.issuer` (the snapshot each invoice froze at creation).
//
// No default and never required: every profile and every invoice from before
// logos has no such key, and a default applied on read would invent a logo
// for a document already sent. The bytes are a Buffer; what they are and
// how big they may be was decided by `services/invoice-logo.ts` before the
// write, so the schema only holds the shape.
import { Schema } from "mongoose";
import type { StoredLogo } from "../services/invoice-logo.js";

export const logoSchema = new Schema<StoredLogo>(
  {
    mime: { type: String, required: true },
    data: { type: Buffer, required: true },
    width: { type: Number, required: true },
    height: { type: Number, required: true },
    sha256: { type: String, required: true },
  },
  { _id: false },
);
