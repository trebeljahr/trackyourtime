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
  BUSINESS_LOGO_MAX_BYTES,
  BUSINESS_LOGO_MAX_DIMENSION,
  BUSINESS_LOGO_REFUSALS,
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

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** SOF markers pdfkit reads a size from (its `MARKERS` list), by what they encode. */
const JPEG_SOF_SUPPORTED = new Set([0xc0, 0xc1, 0xc2]);
const JPEG_SOF_ALL = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

/** The format the bytes say they are, by their magic number. */
export function sniffLogoMime(bytes: Uint8Array): BusinessLogoMime | null {
  if (bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(PNG_SIGNATURE)) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  return null;
}

type Header = { width: number; height: number } | BusinessLogoRefusal;

/** IHDR: the first chunk by specification, so its offsets are fixed. */
function readPngHeader(bytes: Uint8Array): Header {
  if (bytes.length < 33) return BUSINESS_LOGO_REFUSALS.corrupt;
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.readUInt32BE(8) !== 13 || view.toString("latin1", 12, 16) !== "IHDR") {
    return BUSINESS_LOGO_REFUSALS.corrupt;
  }
  const width = view.readUInt32BE(16);
  const height = view.readUInt32BE(20);
  const bitDepth = view[24];
  const colorType = view[25];
  const interlace = view[28];
  if (![1, 2, 4, 8, 16].includes(bitDepth ?? -1) || ![0, 2, 3, 4, 6].includes(colorType ?? -1)) {
    return BUSINESS_LOGO_REFUSALS.corrupt;
  }
  if (interlace === 1) return BUSINESS_LOGO_REFUSALS.interlacedPng;
  if (interlace !== 0) return BUSINESS_LOGO_REFUSALS.corrupt;
  return { width, height };
}

/**
 * Walk the segments to the first SOF, the way pdfkit does, then read
 * precision, height, width and the channel count out of it.
 */
function readJpegHeader(bytes: Uint8Array): Header {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 2;
  while (pos + 4 <= view.length) {
    if (view[pos] !== 0xff) return BUSINESS_LOGO_REFUSALS.corrupt;
    const marker = view[pos + 1] ?? 0;
    pos += 2;
    // Fill bytes, restart markers, SOI and TEM carry no length.
    if (marker === 0xff) {
      pos -= 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    // EOI or scan data before any frame header: no size to read.
    if (marker === 0xd9 || marker === 0xda) return BUSINESS_LOGO_REFUSALS.corrupt;
    if (pos + 2 > view.length) return BUSINESS_LOGO_REFUSALS.corrupt;
    const length = view.readUInt16BE(pos);
    if (JPEG_SOF_ALL.has(marker)) {
      if (!JPEG_SOF_SUPPORTED.has(marker)) return BUSINESS_LOGO_REFUSALS.unsupportedJpeg;
      if (length < 8 || pos + 8 > view.length) return BUSINESS_LOGO_REFUSALS.corrupt;
      const precision = view[pos + 2];
      const height = view.readUInt16BE(pos + 3);
      const width = view.readUInt16BE(pos + 5);
      const channels = view[pos + 7];
      if (precision !== 8) return BUSINESS_LOGO_REFUSALS.unsupportedJpeg;
      if (channels === 4) return BUSINESS_LOGO_REFUSALS.cmykJpeg;
      if (channels !== 1 && channels !== 3) return BUSINESS_LOGO_REFUSALS.corrupt;
      return { width, height };
    }
    if (length < 2) return BUSINESS_LOGO_REFUSALS.corrupt;
    pos += length;
  }
  return BUSINESS_LOGO_REFUSALS.corrupt;
}

/**
 * Check the bytes and describe them, or say why they are refused.
 *
 * `declaredMime` is what the uploader believes the file is; the bytes decide,
 * and a disagreement is refused as the wrong format rather than trusted
 * either way (a `.png` that is really a WebP would otherwise be stored as a
 * PNG and fail at render time, on an invoice, with no upload to point at).
 */
export function inspectLogoBytes(
  bytes: Uint8Array,
  declaredMime?: BusinessLogoMime | null,
): LogoInspection {
  if (bytes.length > BUSINESS_LOGO_MAX_BYTES) return refuse(BUSINESS_LOGO_REFUSALS.tooLarge);
  const mime = sniffLogoMime(bytes);
  if (mime === null || (declaredMime && declaredMime !== mime)) {
    return refuse(BUSINESS_LOGO_REFUSALS.unsupportedFormat);
  }
  const header = mime === "image/png" ? readPngHeader(bytes) : readJpegHeader(bytes);
  if (typeof header === "string") return refuse(header);
  if (header.width === 0 || header.height === 0) return refuse(BUSINESS_LOGO_REFUSALS.corrupt);
  if (header.width > BUSINESS_LOGO_MAX_DIMENSION || header.height > BUSINESS_LOGO_MAX_DIMENSION) {
    return refuse(BUSINESS_LOGO_REFUSALS.tooBig);
  }
  const data = Buffer.from(bytes);
  return {
    ok: true,
    logo: {
      mime,
      data,
      width: header.width,
      height: header.height,
      sha256: createHash("sha256").update(data).digest("hex"),
    },
  };
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
