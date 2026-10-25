import { randomUUID } from "node:crypto";
import { BSON, type MongoClient } from "mongodb";
import { emptyRecoveryCollections, recoveryDigest, verifyWorkspaceRecovery } from "@starter/core";
import { RECOVERY_KINDS, type WorkspaceRecovery } from "@starter/shared";

/** Restore only into a fresh disposable database, never into live collections.
 * The same exact typed records must survive a Mongo write/read round trip.
 * No live rollback is mounted on an API until workspace conversion is ready. */
export async function verifyRecoveryCopy(client: MongoClient, value: unknown): Promise<{ sourceRevision: string; records: number; counts: Record<string, number> }> {
  const snapshot = await verifyWorkspaceRecovery(value);
  const name = `trackyourtime-recovery-check-${randomUUID().replaceAll("-", "")}`;
  const copy = client.db(name);
  const counts: Record<string, number> = {};
  let records = 0;
  // Check before entering cleanup ownership; never drop an observed existing
  // database, even in the astronomically unlikely event of a UUID collision.
  if ((await copy.listCollections({}, { nameOnly: true }).toArray()).length) throw new Error("Recovery copy destination already exists");
  try {
    const restored = emptyRecoveryCollections();
    for (const kind of RECOVERY_KINDS) {
      await copy.createCollection(kind);
      const rows = snapshot.collections[kind];
      // Bound each insert command as well as the whole archive.
      for (let offset = 0; offset < rows.length; offset += 100) {
        const typed = rows.slice(offset, offset + 100).map((row) => BSON.EJSON.deserialize(row, { relaxed: false }));
        await copy.collection(kind).insertMany(typed);
      }
      const read = await copy.collection(kind).find({}, { promoteValues: false, promoteLongs: false }).collation({ locale: "simple" }).sort({ _id: 1 }).toArray();
      restored[kind] = BSON.EJSON.serialize(read, { relaxed: false }) as WorkspaceRecovery["collections"][typeof kind];
      counts[kind] = read.length; records += read.length;
    }
    // Arrays remain in source order; a differing restore cannot pass merely
    // because record counts happen to match.
    if (await recoveryDigest(restored) !== snapshot.sourceRevision) throw new Error("Recovery copy differs from the original typed records");
    return { sourceRevision: snapshot.sourceRevision, records, counts };
  } finally {
    // A failed cleanup is itself a failed drill, never a claimed success.
    try { await copy.dropDatabase(); }
    catch (error) { throw new Error(`Recovery drill cleanup failed for ${name}`, { cause: error }); }
  }
}
