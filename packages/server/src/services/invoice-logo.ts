/**
 * The business logo's bytes: what is accepted, and what is stored.
 *
 * Pure. Reads the PNG IHDR or the JPEG SOF header by hand (no image
 * library, no native dependency) and answers with the stored shape or a
 * refusal code from `@starter/shared`. The rules follow what pdfkit 0.20
 * does with `doc.image(bytes)` on the invoice renderer, measured against
 * generated files rather than assumed:
 *
 * - A plain PNG's compressed stream is embedded as it is in the file, with
 *   the PNG predictor declared. An INTERLACED PNG is instead rebuilt from
 *   png-js's decoded pixels, so what lands in the PDF is not the uploaded
 *   bytes. Refused: every stored logo is embedded byte for byte, which is
 *   what its `sha256` stands for.
 * - A JPEG is embedded unchanged as DCTDecode with the colour space read
 *   from its channel count. Four channels become /DeviceCMYK, which PDF/A-3b
 *   forbids beside the sRGB output intent the ZUGFeRD variant declares (one
 *   output intent per file). Refused, for the plain PDF too — the same
 *   invoice must download in both shapes. 12-bit, lossless (SOF3) and
 *   arithmetic-coded (SOF9+) JPEGs are outside what DCTDecode viewers read;
 *   refused as well. Progressive (SOF2) is fine.
 * - Anything else (SVG, WebP, GIF, a renamed file) throws "Unknown image
 *   format" in pdfkit; refused before it gets there.
 * - PNG alpha becomes an /SMask, which PDF/A-3 allows; the sample with a
 *   logo runs through veraPDF in `pnpm einvoice:validate` to keep that true.
 *
 * Caps: {@link BUSINESS_LOGO_MAX_BYTES} on the file and
 * {@link BUSINESS_LOGO_MAX_DIMENSION} per side, the latter because pdfkit
 * decodes a PNG with alpha pixel by pixel on every render.
 */
import { createHash } from "node:crypto";
import {
  BUSINESS_LOGO_REFUSALS,
  inspectBusinessLogoBytes,
  imageDataUrl,
  type BusinessLogo,
  type BusinessLogoMime,
  type BusinessLogoRefusal,
  type BusinessLogoUpload,
  type Invoice,
  type InvoiceIssuer,
} from "@starter/shared";

/** A logo as the profile and every invoice issuer store it. */
export type StoredLogo = {
  mime: BusinessLogoMime;
  data: Buffer;
  width: number;
  height: number;
  /** Hex SHA-256 of `data`; the identity of the bytes, for tests and audits. */
  sha256: string;
};

/**
 * What `renderInvoicePdf` draws from: the wire invoice with the issuer
 * logo's bytes kept. A plain wire `Invoice` satisfies it too (the key is
 * optional), so an invoice without a logo renders exactly as before, and
 * every caller that builds one goes through `renderableInvoice` in the
 * Invoice model — the one place the bytes leave the document.
 */
export type RenderableInvoice = Omit<Invoice, "issuer"> & {
  issuer?: (InvoiceIssuer & { logo?: StoredLogo | null }) | null;
};

export type LogoInspection =
  | { ok: true; logo: StoredLogo }
  | { ok: false; refusal: BusinessLogoRefusal };

const refuse = (refusal: BusinessLogoRefusal): LogoInspection => ({ ok: false, refusal });

/** Portable header rules are also used by encrypted clients. */
export { sniffLogoMime } from "@starter/shared";
export function inspectLogoBytes(bytes: Uint8Array, declaredMime?: BusinessLogoMime | null): LogoInspection {
  const result = inspectBusinessLogoBytes(bytes, declaredMime);
  if (!result.ok) return result;
  const data = Buffer.from(bytes);
  return { ok: true, logo: { ...result.logo, data, sha256: createHash("sha256").update(data).digest("hex") } };
}

/**
 * The upload body decoded and checked. The zod schema already bounded the
 * base64 length; the decoded size is checked again here because base64 is
 * not the cap, bytes are.
 */
export function inspectLogoUpload(upload: BusinessLogoUpload): LogoInspection {
  const data = Buffer.from(upload.base64, "base64");
  if (data.length === 0) return refuse(BUSINESS_LOGO_REFUSALS.corrupt);
  return inspectLogoBytes(data, upload.mime);
}

/**
 * A stored logo read back through mongoose. `.lean()` hands a Buffer field
 * back as the driver's `Binary` on some paths and as a `Buffer` on others;
 * both are read, and anything else is "no logo" rather than a crash in the
 * middle of a settings read.
 */
export function storedLogoOf(value: unknown): StoredLogo | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as {
    mime?: unknown;
    data?: unknown;
    width?: unknown;
    height?: unknown;
    sha256?: unknown;
  };
  const data = bytesOf(row.data);
  if (
    !data ||
    (row.mime !== "image/png" && row.mime !== "image/jpeg") ||
    typeof row.width !== "number" ||
    typeof row.height !== "number"
  ) {
    return null;
  }
  return {
    mime: row.mime,
    data,
    width: row.width,
    height: row.height,
    sha256:
      typeof row.sha256 === "string" && row.sha256 !== ""
        ? row.sha256
        : createHash("sha256").update(data).digest("hex"),
  };
}

function bytesOf(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) return value.length > 0 ? value : null;
  if (value instanceof Uint8Array) return value.length > 0 ? Buffer.from(value) : null;
  // The driver's Binary: `.buffer` is the bytes (a Buffer or a Uint8Array).
  if (typeof value === "object" && value !== null && "buffer" in value) {
    return bytesOf((value as { buffer: unknown }).buffer);
  }
  return null;
}

/** The wire shape of a stored logo: the bytes as a data URL, and the pixel size. */
export function logoToWire(logo: Pick<StoredLogo, "mime" | "data" | "width" | "height">): BusinessLogo {
  return {
    dataUrl: imageDataUrl({ mime: logo.mime, base64: logo.data.toString("base64") }),
    width: logo.width,
    height: logo.height,
  };
}
