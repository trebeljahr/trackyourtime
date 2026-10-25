import { randomUUID } from "node:crypto";
import { BSON, type MongoClient } from "mongodb";
import { emptyRecoveryCollections, emptyRecoverySupplementCollections, recoveryDigest, recoverySupplementDigest, verifyCombinedWorkspaceRecoveryArchive } from "@starter/core";
import { RECOVERY_KINDS, RECOVERY_SUPPLEMENT_KINDS } from "@starter/shared";
/** Verify one combined original file through a real typed write/read round
 * trip in one fresh isolated database. Never overwrites source collections.
 * The user's file excludes other members' private data; this is not a complete
 * installation/operational rollback drill or permission to convert live data. */
export async function verifyCombinedRecoveryCopy(client: MongoClient, value: unknown) {
  const archive = await verifyCombinedWorkspaceRecoveryArchive(value);
  const name = `trackyourtime-recovery-check-${randomUUID().replaceAll("-", "")}`, copy = client.db(name);
  if ((await copy.listCollections({}, { nameOnly: true }).toArray()).length) throw new Error("Recovery copy destination already exists");
  const counts: Record<string, number> = {}; let records = 0;
  try {
    const business = emptyRecoveryCollections(), supplement = emptyRecoverySupplementCollections();
    for (const kind of [...RECOVERY_KINDS, ...RECOVERY_SUPPLEMENT_KINDS]) {
      const rows = kind in business ? archive.snapshot.collections[kind as keyof typeof business] : archive.supplement.collections[kind as keyof typeof supplement];
      await copy.createCollection(kind);
      for (let offset = 0; offset < rows.length; offset += 100) await copy.collection(kind).insertMany(rows.slice(offset, offset + 100).map((row) => BSON.EJSON.deserialize(row, { relaxed: false })));
      const read = await copy.collection(kind).find({}, { promoteValues: false, promoteLongs: false }).collation({ locale: "simple" }).sort({ _id: 1 }).toArray();
      const typed = BSON.EJSON.serialize(read, { relaxed: false }) as Record<string, unknown>[];
      if (kind in business) business[kind as keyof typeof business] = typed;
      else supplement[kind as keyof typeof supplement] = typed;
      counts[kind] = read.length; records += read.length;
    }
    if (await recoveryDigest(business) !== archive.snapshot.sourceRevision || await recoverySupplementDigest(supplement) !== archive.supplement.sourceRevision) throw new Error("Combined recovery copy differs from the original typed records");
    return { sourceRevision: archive.snapshot.sourceRevision, supplementRevision: archive.supplement.sourceRevision, records, counts };
  } finally {
    try { await copy.dropDatabase(); } catch (error) { throw new Error(`Combined recovery drill cleanup failed for ${name}`, { cause: error }); }
  }
}
