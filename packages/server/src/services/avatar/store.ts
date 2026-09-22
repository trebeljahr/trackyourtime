// Profile pictures: the stored bytes, and `user.image` pointing at them.
import { randomBytes } from "node:crypto";
import { Avatar } from "../../models/Avatar.js";
import { getAuth } from "../../auth/auth.js";
import { env } from "../../config/env.js";
import { avatarUrl, decodeAvatar, type DecodedAvatar } from "./image.js";

export type StoredAvatar = {
  contentType: string;
  size: number;
  bytes: Buffer;
};

/** The bytes at `${AVATAR_PATH_PREFIX}/<userId>/<key>`, or null. */
export async function findAvatar(userId: string, key: string): Promise<StoredAvatar | null> {
  const row = await Avatar.findOne({ userId, key })
    .select({ contentType: 1, size: 1, bytes: 1 })
    .lean<{ contentType: string; size: number; bytes: Buffer } | null>();
  if (!row) return null;
  // mongoose hands a `Binary` back from `lean()`; normalise to a Buffer.
  const bytes = Buffer.isBuffer(row.bytes)
    ? row.bytes
    : Buffer.from((row.bytes as unknown as { buffer: Uint8Array }).buffer);
  return { contentType: row.contentType, size: row.size, bytes };
}

const newAvatarKey = (): string => randomBytes(16).toString("hex");

/**
 * Write `user.image` on better-auth's own user row.
 *
 * Through the adapter rather than `auth.api.updateUser`, which would need the
 * caller's request headers and would answer with a Set-Cookie nobody here can
 * forward. The web app's cookie cache (five minutes) therefore still holds
 * the old value after this returns; the client re-reads the session with
 * `disableCookieCache` right after, which rewrites the cache.
 */
async function setUserImage(userId: string, image: string | null): Promise<void> {
  const context = (await getAuth().$context) as {
    adapter: {
      update: (args: {
        model: string;
        where: { field: string; value: string }[];
        update: Record<string, unknown>;
      }) => Promise<unknown>;
    };
  };
  await context.adapter.update({
    model: "user",
    where: [{ field: "id", value: userId }],
    update: { image, updatedAt: new Date() },
  });
}

export type SetAvatarOutcome =
  | { ok: true; image: string }
  | { ok: false; refusal: Extract<DecodedAvatar, { ok: false }>["refusal"] };

/**
 * Store a picture for `userId` and point `user.image` at it.
 *
 * The row is written first and the user row second, so a crash in between
 * leaves an orphaned picture that nothing links to (the next upload replaces
 * it) rather than a link to nothing.
 */
export async function storeAvatar(userId: string, base64: string): Promise<SetAvatarOutcome> {
  const decoded = decodeAvatar(base64);
  if (!decoded.ok) return decoded;
  const key = newAvatarKey();
  await Avatar.findOneAndUpdate(
    { userId },
    {
      $set: {
        key,
        contentType: decoded.contentType,
        size: decoded.bytes.length,
        bytes: decoded.bytes,
      },
    },
    { upsert: true, returnDocument: "after" },
  );
  const image = avatarUrl(env.BETTER_AUTH_URL, userId, key);
  await setUserImage(userId, image);
  return { ok: true, image };
}

/**
 * Delete the stored picture and clear `user.image`.
 *
 * Clears the field whatever it held: a picture that came with a Google
 * sign-in is a picture the person is asking to remove too. Idempotent.
 */
export async function removeAvatar(userId: string): Promise<void> {
  await Avatar.deleteOne({ userId });
  await setUserImage(userId, null);
}
