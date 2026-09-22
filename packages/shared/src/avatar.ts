import { z } from "zod";

/**
 * Profile pictures.
 *
 * The client crops and scales the chosen image to a square of
 * {@link AVATAR_SIZE} pixels before sending it, so the bytes the server stores
 * are always small and always square. The server checks the bytes again: the
 * magic number decides the content type (never the client's word), and the
 * decoded size must stay under {@link MAX_AVATAR_BYTES}.
 */
export const AVATAR_SIZE = 512;

/** Decoded bytes a stored picture may have. 512² JPEG or WebP is well under. */
export const MAX_AVATAR_BYTES = 256_000;

/** What the server accepts and serves. No SVG: it can carry script. */
export const AVATAR_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type AvatarContentType = (typeof AVATAR_CONTENT_TYPES)[number];

/** Where the API serves a stored picture: `${prefix}/<userId>/<key>`. */
export const AVATAR_PATH_PREFIX = "/api/avatars";

/** Base64 of {@link MAX_AVATAR_BYTES}, with padding. */
const MAX_AVATAR_BASE64_LENGTH = Math.ceil(MAX_AVATAR_BYTES / 3) * 4;

/** `profile.setAvatar`: the picture as base64 (no data-URL prefix). */
export const setAvatarSchema = z.object({
  data: z.string().min(1).max(MAX_AVATAR_BASE64_LENGTH),
});
export type SetAvatarInput = z.infer<typeof setAvatarSchema>;

/**
 * Refusals `profile.setAvatar` answers with, as the BAD_REQUEST message, so
 * every client can translate them.
 */
export const AVATAR_REFUSALS = {
  /** Not a JPEG, PNG or WebP by its magic number. */
  UNSUPPORTED_IMAGE: "AVATAR_UNSUPPORTED_IMAGE",
  /** Decoded bytes over {@link MAX_AVATAR_BYTES}. */
  TOO_LARGE: "AVATAR_TOO_LARGE",
  /** The base64 could not be decoded. */
  INVALID_DATA: "AVATAR_INVALID_DATA",
} as const;
export type AvatarRefusal = (typeof AVATAR_REFUSALS)[keyof typeof AVATAR_REFUSALS];
