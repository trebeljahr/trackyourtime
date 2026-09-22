/**
 * Turning a chosen file into the square the server stores.
 *
 * The browser does the work: decode, centre-crop to a square, scale to
 * `AVATAR_SIZE`, re-encode. A 12-megapixel phone photo becomes ~40 KB before
 * it leaves the device, which is what lets the upload ride on a tRPC call
 * with a small body limit and the server store bytes without an image
 * library. `squareCrop` is the pure part; `prepareAvatar` is the DOM part.
 */
import { AVATAR_SIZE, MAX_AVATAR_BYTES } from "@starter/shared";

/** A source file larger than this is refused before decoding. */
export const MAX_SOURCE_BYTES = 25 * 1024 * 1024;

export type CropRect = { sx: number; sy: number; size: number };

/** The largest centred square inside a `width` × `height` image. */
export function squareCrop(width: number, height: number): CropRect {
  const size = Math.max(1, Math.min(width, height));
  return {
    sx: Math.floor((width - size) / 2),
    sy: Math.floor((height - size) / 2),
    size,
  };
}

/** Encoders tried in order; the first the browser really produces wins. */
const ENCODINGS: readonly { type: string; quality: number }[] = [
  { type: "image/webp", quality: 0.85 },
  { type: "image/jpeg", quality: 0.85 },
];

export type PreparedAvatar = {
  /** Base64 of the encoded bytes, no data-URL prefix. */
  base64: string;
  contentType: string;
  bytes: number;
};

export type PrepareAvatarFailure = "not-an-image" | "source-too-large" | "unreadable" | "too-large";

export class PrepareAvatarError extends Error {
  constructor(readonly reason: PrepareAvatarFailure) {
    super(`avatar: ${reason}`);
  }
}

const decode = async (file: File): Promise<ImageBitmap | HTMLImageElement> => {
  if (typeof createImageBitmap === "function") {
    try {
      // `from-image` applies the EXIF orientation, so a portrait phone photo
      // is not stored on its side.
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      // Fall through to <img>, which some browsers decode more formats with.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new PrepareAvatarError("unreadable"));
      image.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
};

const encode = (canvas: HTMLCanvasElement): Promise<Blob> =>
  (async () => {
    for (const { type, quality } of ENCODINGS) {
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, type, quality),
      );
      // A browser without an encoder for `type` answers with PNG instead of
      // failing, so the type is checked rather than trusted.
      if (blob && blob.type === type) return blob;
    }
    throw new PrepareAvatarError("unreadable");
  })();

const toBase64 = async (blob: Blob): Promise<string> => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};

/** Decode, centre-crop, scale to `AVATAR_SIZE`, encode. Throws `PrepareAvatarError`. */
export async function prepareAvatar(file: File): Promise<PreparedAvatar> {
  if (!file.type.startsWith("image/")) throw new PrepareAvatarError("not-an-image");
  if (file.size > MAX_SOURCE_BYTES) throw new PrepareAvatarError("source-too-large");

  const source = await decode(file);
  const width = "naturalWidth" in source ? source.naturalWidth : source.width;
  const height = "naturalHeight" in source ? source.naturalHeight : source.height;
  if (!width || !height) throw new PrepareAvatarError("unreadable");

  const canvas = document.createElement("canvas");
  canvas.width = AVATAR_SIZE;
  canvas.height = AVATAR_SIZE;
  const context = canvas.getContext("2d");
  if (!context) throw new PrepareAvatarError("unreadable");
  // JPEG has no alpha: a transparent PNG would otherwise come out on black.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, AVATAR_SIZE, AVATAR_SIZE);
  context.imageSmoothingQuality = "high";
  const crop = squareCrop(width, height);
  context.drawImage(source, crop.sx, crop.sy, crop.size, crop.size, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
  if ("close" in source) source.close();

  const blob = await encode(canvas);
  if (blob.size > MAX_AVATAR_BYTES) throw new PrepareAvatarError("too-large");
  return { base64: await toBase64(blob), contentType: blob.type, bytes: blob.size };
}
