// A real MongoDB for the few unit tests whose subject IS the database's
// behaviour: an atomic claim racing another, a partial-unique index, a filter
// that has to match an absent field. A stub of `findOneAndUpdate` would only
// test the stub.
//
// Opt-in through TEST_MONGODB_URI, because the unit suite otherwise needs no
// database at all. Without it these files skip with the reason printed,
// rather than failing on a machine with no Mongo. CI sets it.
//
// Every file connects to a database of its OWN, named here and dropped after,
// so the URI may point at a shared server: nothing outside that database is
// read or written, and two files running in parallel processes never meet.
//
// Cases that need multi-document transactions (approval locks, durable entry
// replay, invoice deletion) skip on a standalone mongod, which is right on a
// laptop and wrong in CI, where a skip makes no sound. REQUIRE_TRANSACTIONS=1
// turns both kinds of quiet skip into failures: no TEST_MONGODB_URI, and a
// URI that is not a replica set. CI sets it; scripts/mongo-replica-set-container.sh
// starts a set that satisfies it.
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { supportsBusinessTransactions } from "../../services/business-transaction.js";

const uri = (process.env.TEST_MONGODB_URI ?? "").trim();
const transactionsRequired = process.env.REQUIRE_TRANSACTIONS === "1";

/**
 * `false` when a database is available, else the reason to skip. Pass it as
 * `describe(name, { skip: skipWithoutDatabase }, ...)`. Never a skip under
 * REQUIRE_TRANSACTIONS=1: `connectTestDatabase` then fails instead.
 */
export const skipWithoutDatabase: false | string = uri || transactionsRequired
  ? false
  : "TEST_MONGODB_URI is not set (e.g. mongodb://127.0.0.1:27017)";

/**
 * Connect mongoose to a fresh database for this file and build the indexes of
 * the given models, which the tests usually depend on (a unique name, the
 * one-running-timer index).
 */
export async function connectTestDatabase(
  label: string,
  models: readonly mongoose.Model<never>[] = [],
): Promise<void> {
  if (!uri) {
    throw new Error("REQUIRE_TRANSACTIONS=1 needs TEST_MONGODB_URI, pointing at a replica set");
  }
  const dbName = `trackyourtime-unit-${label}-${randomUUID().slice(0, 8)}`;
  await mongoose.connect(uri, { dbName, serverSelectionTimeoutMS: 5000 });
  for (const model of models) {
    await model.syncIndexes();
  }
}

/**
 * Whether the connected database runs transactions (a replica set or mongos),
 * by the same test the application uses. Call it after `connectTestDatabase`
 * and branch or skip on the answer; under REQUIRE_TRANSACTIONS=1 a standalone
 * answer throws instead, so every case behind it fails rather than skips.
 */
export async function testDatabaseTransactions(): Promise<boolean> {
  const supported = await supportsBusinessTransactions();
  if (!supported && transactionsRequired) {
    throw new Error(
      "REQUIRE_TRANSACTIONS=1, but TEST_MONGODB_URI is a standalone mongod. " +
        "Point it at a replica set (scripts/mongo-replica-set-container.sh).",
    );
  }
  return supported;
}

/** Drop this file's database and disconnect. */
export async function dropTestDatabase(): Promise<void> {
  if (mongoose.connection.readyState !== 1) return;
  const dbName = mongoose.connection.db?.databaseName ?? "";
  // The name was generated above; refuse anything else rather than trusting
  // that nothing reconnected mongoose somewhere in between.
  if (dbName.startsWith("trackyourtime-unit-")) {
    await mongoose.connection.dropDatabase();
  }
  await mongoose.disconnect();
}

/** Empty every collection, between cases. */
export async function clearTestDatabase(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) return;
  for (const collection of await db.collections()) {
    await collection.deleteMany({});
  }
}
