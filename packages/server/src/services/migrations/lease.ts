// The migration lock: one row in `app_meta`, claimed and released the way a
// scheduled job is (services/scheduler/lease.ts). An atomic `findOneAndUpdate`
// matches only while nobody holds a live lease, so two server processes
// booting together — a Coolify deploy overlaps the old and new container —
// never run migrations side by side.
//
// Unlike a job run, a migration can outlast any fixed lease, so the holder
// renews it while it works. A holder that dies stops renewing and the lease
// lapses; the next process takes over and re-runs whatever was not recorded,
// which is why every migration must be idempotent.
import type { Db } from "mongodb";

export const APP_META_COLLECTION = "app_meta";
export const MIGRATION_LOCK_ID = "schema-migrations-lock";

type LockRow = {
  _id: string;
  lockedBy: string | null;
  lockedUntil: Date | null;
};

const locks = (db: Db) => db.collection<LockRow>(APP_META_COLLECTION);

/** Make sure the lock row exists. Safe with two processes racing on it. */
export async function ensureMigrationLock(db: Db): Promise<void> {
  try {
    await locks(db).updateOne(
      { _id: MIGRATION_LOCK_ID },
      { $setOnInsert: { lockedBy: null, lockedUntil: null } },
      { upsert: true },
    );
  } catch (error) {
    // Two concurrent upserts on `_id`: the loser's insert fails, and the row
    // it wanted exists.
    if (!isDuplicateKeyError(error)) throw error;
  }
}

/** Take the lock, or learn somebody else holds a live one. */
export async function claimMigrationLock(
  db: Db,
  args: { owner: string; leaseMs: number; now: Date },
): Promise<boolean> {
  const { owner, leaseMs, now } = args;
  const claimed = await locks(db).findOneAndUpdate(
    {
      _id: MIGRATION_LOCK_ID,
      $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }],
    },
    { $set: { lockedBy: owner, lockedUntil: new Date(now.getTime() + leaseMs) } },
    { returnDocument: "after" },
  );
  return claimed !== null;
}

/** Push the lease forward. False when this process no longer holds it. */
export async function renewMigrationLock(
  db: Db,
  args: { owner: string; leaseMs: number; now: Date },
): Promise<boolean> {
  const { owner, leaseMs, now } = args;
  const result = await locks(db).updateOne(
    { _id: MIGRATION_LOCK_ID, lockedBy: owner },
    { $set: { lockedUntil: new Date(now.getTime() + leaseMs) } },
  );
  return result.matchedCount === 1;
}

/**
 * Give the lock back. Filtered on `lockedBy`, so a process whose lease lapsed
 * and was taken over cannot free the new holder's lock on its way out.
 */
export async function releaseMigrationLock(db: Db, owner: string): Promise<void> {
  await locks(db).updateOne(
    { _id: MIGRATION_LOCK_ID, lockedBy: owner },
    { $set: { lockedBy: null, lockedUntil: null } },
  );
}

export const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code: unknown }).code === 11000;
