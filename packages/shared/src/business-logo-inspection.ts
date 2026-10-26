import { BUSINESS_LOGO_MAX_BYTES, BUSINESS_LOGO_MAX_DIMENSION, BUSINESS_LOGO_REFUSALS, type BusinessLogoMime, type BusinessLogoRefusal } from "./business-logo.js";
/** Portable bounded header inspection. Identical rules for existing server
 * uploads and client rendering of authenticated encrypted originals. */
export type BusinessLogoHeaderInspection = { ok: true; logo: { mime: BusinessLogoMime; width: number; height: number } } | { ok: false; refusal: BusinessLogoRefusal };
const refuse = (refusal: BusinessLogoRefusal): BusinessLogoHeaderInspection => ({ ok: false, refusal });

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** SOF markers pdfkit reads a size from (its `MARKERS` list), by what they encode. */
const JPEG_SOF_SUPPORTED = new Set([0xc0, 0xc1, 0xc2]);
const JPEG_SOF_ALL = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

/** The format the bytes say they are, by their magic number. */
export function sniffLogoMime(bytes: Uint8Array): BusinessLogoMime | null {
  if (bytes.length >= 8 && PNG_SIGNATURE.every((value, index) => bytes[index] === value)) {
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
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== 13 || !([73, 72, 68, 82].every((value, index) => bytes[index + 12] === value))) {
    return BUSINESS_LOGO_REFUSALS.corrupt;
  }
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const bitDepth = bytes[24];
  const colorType = bytes[25];
  const interlace = bytes[28];
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
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 2;
  while (pos + 4 <= bytes.length) {
    if (bytes[pos] !== 0xff) return BUSINESS_LOGO_REFUSALS.corrupt;
    const marker = bytes[pos + 1] ?? 0;
    pos += 2;
    // Fill bytes, restart markers, SOI and TEM carry no length.
    if (marker === 0xff) {
      pos -= 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    // EOI or scan data before any frame header: no size to read.
    if (marker === 0xd9 || marker === 0xda) return BUSINESS_LOGO_REFUSALS.corrupt;
    if (pos + 2 > bytes.length) return BUSINESS_LOGO_REFUSALS.corrupt;
    const length = view.getUint16(pos);
    if (JPEG_SOF_ALL.has(marker)) {
      if (!JPEG_SOF_SUPPORTED.has(marker)) return BUSINESS_LOGO_REFUSALS.unsupportedJpeg;
      if (length < 8 || pos + 8 > bytes.length) return BUSINESS_LOGO_REFUSALS.corrupt;
      const precision = bytes[pos + 2];
      const height = view.getUint16(pos + 3);
      const width = view.getUint16(pos + 5);
      const channels = bytes[pos + 7];
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
export function inspectBusinessLogoBytes(
  bytes: Uint8Array,
  declaredMime?: BusinessLogoMime | null,
): BusinessLogoHeaderInspection {
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
  return {
    ok: true,
    logo: {
      mime,
      width: header.width,
      height: header.height,
    },
  };
}

