import type { Db } from "mongodb";
import type { Migration } from "./types.js";

/** The index names better-auth 1.7 gives `deviceCode`'s unique lookups. */
export const DEVICE_CODE_INDEXES = [
  { name: "deviceCode_deviceCode_uidx", key: { deviceCode: 1 } },
  { name: "deviceCode_userCode_uidx", key: { userCode: 1 } },
] as const;

const isNamespaceNotFound = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === 26;

/**
 * better-auth 1.6.33 → 1.7.15 (docs/versioning.md → "better-auth upgrades are
 * migration-bearing"). For this app's plugins the stored fields are the same in
 * both versions; two things about the data are not:
 *
 * - 1.7 rejects an account lookup that matches more than one `account` row, so
 *   a duplicated (providerId, accountId) pair would lock that person out. This
 *   migration refuses to finish while one exists: resolve it by hand first (the
 *   better-auth 1.7 upgrade guide, "Check for duplicate account keys").
 * - 1.7 declares unique indexes on `deviceCode.deviceCode` and
 *   `deviceCode.userCode` and the MongoDB adapter builds them lazily, before
 *   the first device-code write. A duplicate there would fail that write, so
 *   Raycast and CLI sign-in would break. Expired codes are deleted (they are
 *   dead after ten minutes), any duplicates left keep only the newest row, and
 *   the indexes are created here under better-auth's names, so its lazy
 *   creation finds them in place.
 *
 * Not stored here: magic links issued before the upgrade stop working, because
 * 1.7 looks them up as `magic-link:<token>`. They live for minutes; the person
 * asks for a new one.
 *
 * Readable by every release (`minReaderSchema` 0): 1.6 ignores the indexes,
 * and a deleted expired device code is one it would refuse anyway.
 *
 * Idempotent: a re-run finds no duplicates and existing indexes.
 */
export const betterAuth17: Migration = {
  id: 5,
  description: "better-auth 1.7: check account keys, unique device-code indexes",
  minReaderSchema: 0,
  up: async (db: Db) => {
    const duplicates = await db
      .collection("account")
      .aggregate<{ _id: { providerId: unknown; accountId: unknown }; count: number }>([
        { $group: { _id: { providerId: "$providerId", accountId: "$accountId" }, count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } },
        { $limit: 20 },
      ])
      .toArray();
    if (duplicates.length > 0) {
      const pairs = duplicates.map((d) => `${String(d._id.providerId)}/${String(d._id.accountId)} ×${d.count}`).join(", ");
      throw new Error(
        `better-auth 1.7 needs one account row per (providerId, accountId); these repeat: ${pairs}. ` +
          "Merge or remove the extra rows, then start again.",
      );
    }

    const codes = db.collection("deviceCode");
    try {
      await codes.deleteMany({ expiresAt: { $lt: new Date() } });
      for (const field of ["deviceCode", "userCode"] as const) {
        const groups = await codes
          .aggregate<{ ids: unknown[] }>([
            { $sort: { expiresAt: -1, _id: -1 } },
            { $group: { _id: `$${field}`, ids: { $push: "$_id" }, count: { $sum: 1 } } },
            { $match: { count: { $gt: 1 } } },
          ])
          .toArray();
        for (const group of groups) await codes.deleteMany({ _id: { $in: group.ids.slice(1) as never[] } });
      }
    } catch (error) {
      if (!isNamespaceNotFound(error)) throw error;
    }
    for (const index of DEVICE_CODE_INDEXES) await codes.createIndex(index.key, { name: index.name, unique: true });
  },
};
