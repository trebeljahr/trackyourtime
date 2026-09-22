// The pure half of profile pictures: what bytes are accepted, and where a
// stored picture is served from. No database here, so it is unit-tested
// without one.
import {
  AVATAR_PATH_PREFIX,
  AVATAR_REFUSALS,
  MAX_AVATAR_BYTES,
  type AvatarContentType,
  type AvatarRefusal,
} from "@starter/shared";

/**
 * The content type by magic number, or null. The client's declared type is
 * never consulted: a browser serving a stored file sniffs the bytes, so the
 * bytes are what has to be safe.
 */
export function sniffImageType(bytes: Uint8Array): AvatarContentType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= PNG.length && PNG.every((byte, i) => bytes[i] === byte)) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

const ascii = (bytes: Uint8Array, from: number, to: number): string =>
  String.fromCharCode(...bytes.subarray(from, to));

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export type DecodedAvatar =
  | { ok: true; bytes: Buffer; contentType: AvatarContentType }
  | { ok: false; refusal: AvatarRefusal };

/** Decode and check an upload. Refusals are codes every client can translate. */
export function decodeAvatar(base64: string): DecodedAvatar {
  if (base64.length % 4 !== 0 || !BASE64.test(base64)) {
    return { ok: false, refusal: AVATAR_REFUSALS.INVALID_DATA };
  }
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length === 0) return { ok: false, refusal: AVATAR_REFUSALS.INVALID_DATA };
  if (bytes.length > MAX_AVATAR_BYTES) {
    return { ok: false, refusal: AVATAR_REFUSALS.TOO_LARGE };
  }
  const contentType = sniffImageType(bytes);
  if (!contentType) return { ok: false, refusal: AVATAR_REFUSALS.UNSUPPORTED_IMAGE };
  return { ok: true, bytes, contentType };
}

/** 32 hex characters: the shape `newAvatarKey()` produces and the route accepts. */
export const AVATAR_KEY_PATTERN = /^[0-9a-f]{32}$/;

/** better-auth user ids: ObjectIds today, but any URL-safe id is served. */
export const AVATAR_USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The absolute address a picture is served from. Absolute, because
 * `user.image` is read by every client — the web app, the shells, the
 * extension — and each would otherwise have to know which server the session
 * came from. `origin` is the API's own public origin (`BETTER_AUTH_URL`).
 */
export function avatarUrl(origin: string, userId: string, key: string): string {
  return `${origin.replace(/\/+$/, "")}${AVATAR_PATH_PREFIX}/${userId}/${key}`;
}

/** A picture's path when `avatarUrl` built it: `{ userId, key }` or null. */
export function parseAvatarPath(userId: unknown, key: unknown): { userId: string; key: string } | null {
  if (typeof userId !== "string" || typeof key !== "string") return null;
  if (!AVATAR_USER_ID_PATTERN.test(userId) || !AVATAR_KEY_PATTERN.test(key)) return null;
  return { userId, key };
}
