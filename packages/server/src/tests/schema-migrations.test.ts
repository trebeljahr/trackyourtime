// The migration runner against a real MongoDB: once per migration, idempotent,
// safe with several server processes booting together, a failed migration
// left unrecorded and retried, and a database migrated by a newer release
// refused. Plus the boot index check and `admin migrate`.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import mongoose, { Schema } from "mongoose";
import type { Db } from "mongodb";
import { runMigrate } from "../cli/migrate.js";
import { buildModelIndexes, inspectModelIndexes, reportIndexOutcomes } from "../db/indexes.js";
import { APP_META_COLLECTION, MIGRATION_LOCK_ID } from "../services/migrations/lease.js";
import {
  MIGRATIONS,
  SCHEMA_MIGRATIONS_COLLECTION,
  SCHEMA_VERSION,
  SchemaTooNewError,
  assertMigrationSequence,
  migrationStatus,
  runMigrations,
  type Migration,
} from "../services/migrations/index.js";
import {
  clearTestDatabase,
  connectTestDatabase,
  dropTestDatabase,
  skipWithoutDatabase,
} from "./support/test-database.js";

const silent = { log: () => {}, error: () => {} };

const database = (): Db => {
  const db = mongoose.connection.db;
  if (!db) throw new Error("not connected");
  return db;
};

/** A migration that counts its runs in a collection, as an idempotent `up` would. */
const counting = (id: number, minReaderSchema = 0, delayMs = 0): Migration => ({
  id,
  description: `test migration ${id}`,
  minReaderSchema,
  up: async (db) => {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    await db.collection("runs").updateOne({ _id: id as never }, { $inc: { count: 1 } }, { upsert: true });
  },
});

const runs = async (id: number): Promise<number> =>
  ((await database().collection("runs").findOne({ _id: id as never })) as { count?: number } | null)?.count ?? 0;

const run = (migrations: readonly Migration[], overrides: Partial<Parameters<typeof runMigrations>[0]> = {}) =>
  runMigrations({
    db: database(),
    migrations,
    schemaVersion: migrations.length,
    owner: "test-process",
    release: "0.1.0",
    logger: silent,
    pollMs: 10,
    ...overrides,
  });

// ── no database needed ───────────────────────────────────────────────

describe("migration registry", () => {
  it("is 1…n in order, and SCHEMA_VERSION is the last id", () => {
    assert.doesNotThrow(() => assertMigrationSequence(MIGRATIONS));
    assert.equal(SCHEMA_VERSION, MIGRATIONS.length);
    assert.equal(MIGRATIONS[0]?.minReaderSchema, 0, "the baseline is readable by every release");
  });

  it("refuses gaps, reordering and a reader newer than the migration", () => {
    assert.throws(() => assertMigrationSequence([counting(1), counting(3)]));
    assert.throws(() => assertMigrationSequence([counting(2), counting(1)]));
    assert.throws(() => assertMigrationSequence([counting(1, 2)]));
  });
});

// ── against a database ───────────────────────────────────────────────

describe("migration runner", { skip: skipWithoutDatabase }, () => {
  before(async () => {
    await connectTestDatabase("schema-migrations");
  });
  beforeEach(clearTestDatabase);
  after(dropTestDatabase);

  it("applies each pending migration once, records it, and is a no-op the second time", async () => {
    const migrations = [counting(1), counting(2)];
    assert.deepEqual(await run(migrations), [1, 2]);
    assert.deepEqual(await run(migrations), []);
    assert.equal(await runs(1), 1);
    assert.equal(await runs(2), 1);

    const records = await database().collection(SCHEMA_MIGRATIONS_COLLECTION).find({}).sort({ _id: 1 }).toArray();
    assert.deepEqual(records.map((record) => [record._id, record.release]), [
      [1, "0.1.0"],
      [2, "0.1.0"],
    ]);
    assert.ok(records.every((record) => record.appliedAt instanceof Date));

    // A later release appends a migration: only that one runs.
    assert.deepEqual(await run([...migrations, counting(3)]), [3]);
    assert.equal(await runs(1), 1);
  });

  it("releases the lock when done", async () => {
    await run([counting(1)]);
    const lock = await database().collection(APP_META_COLLECTION).findOne({ _id: MIGRATION_LOCK_ID as never });
    assert.equal(lock?.lockedBy, null);
    assert.equal(lock?.lockedUntil, null);
  });

  it("runs each migration once with several processes booting at once", async () => {
    const migrations = [counting(1, 0, 30), counting(2, 0, 30), counting(3, 0, 30)];
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, i) => run(migrations, { owner: `process-${i}` })),
    );
    assert.deepEqual(results.flat().sort(), [1, 2, 3]);
    for (const id of [1, 2, 3]) assert.equal(await runs(id), 1, `migration ${id}`);
  });

  it("takes over a lock whose holder died, once the lease lapses", async () => {
    await database()
      .collection(APP_META_COLLECTION)
      .insertOne({ _id: MIGRATION_LOCK_ID as never, lockedBy: "dead", lockedUntil: new Date(Date.now() + 80) });
    assert.deepEqual(await run([counting(1)]), [1]);
  });

  it("leaves a failed migration unrecorded, keeps the ones before it, and retries it", async () => {
    let fail = true;
    const flaky: Migration = {
      id: 2,
      description: "fails once",
      minReaderSchema: 0,
      up: async (db) => {
        if (fail) throw new Error("disk on fire");
        await db.collection("runs").updateOne({ _id: 2 as never }, { $inc: { count: 1 } }, { upsert: true });
      },
    };
    const migrations = [counting(1), flaky, counting(3)];

    await assert.rejects(run(migrations), /disk on fire/);
    const status = await migrationStatus(database(), migrations, 3);
    assert.deepEqual(status.applied.map((record) => record._id), [1]);
    assert.deepEqual(status.pending.map((migration) => migration.id), [2, 3]);
    assert.equal(await runs(3), 0, "nothing after the failure ran");
    const lock = await database().collection(APP_META_COLLECTION).findOne({ _id: MIGRATION_LOCK_ID as never });
    assert.equal(lock?.lockedBy, null, "the lock is released on failure");

    fail = false;
    assert.deepEqual(await run(migrations), [2, 3]);
    assert.equal(await runs(1), 1);
  });

  it("refuses a database whose migrations need a newer reader, before running anything", async () => {
    // A newer release applied migration 3, which older readers cannot read.
    await run([counting(1), counting(2), counting(3, 3)], { release: "2.0.0" });

    const error = await run([counting(1), counting(2)], { schemaVersion: 2 }).catch((e: unknown) => e);
    assert.ok(error instanceof SchemaTooNewError);
    assert.equal(error.requiredReaderSchema, 3);
    assert.match(error.message, /newer Track Your Time \(v2\.0\.0\)/);
    assert.match(error.message, /mongodump/);
  });

  it("starts an older build against a newer database when its migrations stay readable", async () => {
    await run([counting(1), counting(2), counting(3, 0)], { release: "2.0.0" });
    const status = await migrationStatus(database(), [counting(1), counting(2)], 2);
    assert.equal(status.readable, true);
    assert.deepEqual(status.unknownApplied.map((record) => record._id), [3]);
    assert.deepEqual(await run([counting(1), counting(2)], { schemaVersion: 2 }), []);
  });

  it("admin migrate: --dry-run and --status change nothing; apply records", async () => {
    const migrations = [counting(1), counting(2)];
    const dry = await runMigrate(database(), "0.1.0", "dry-run", false, migrations, 2);
    assert.equal(dry.exitCode, 0);
    assert.match(dry.stdout, /Would apply:\n\s+1\s+test migration 1\n\s+2\s+test migration 2/);
    const status = await runMigrate(database(), "0.1.0", "status", true, migrations, 2);
    assert.deepEqual(JSON.parse(status.stdout).pending.map((m: { id: number }) => m.id), [1, 2]);
    assert.equal(await runs(1), 0);

    const applied = await runMigrate(database(), "0.1.0", "apply", false, migrations, 2);
    assert.equal(applied.exitCode, 0);
    assert.match(applied.stdout, /Applied 1, 2\./);

    await run([...migrations, counting(3, 3)], { release: "9.0.0" });
    const refused = await runMigrate(database(), "0.1.0", "status", false, migrations, 2);
    assert.equal(refused.exitCode, 1);
    assert.match(refused.stdout, /REFUSED.*v9\.0\.0/);
  });
});

describe("boot index check", { skip: skipWithoutDatabase }, () => {
  const schema = new Schema({ key: String, other: String });
  schema.index({ key: 1 }, { unique: true });
  schema.index({ other: 1 });
  const Probe = mongoose.model("MigrationIndexProbe", schema);
  const critical = [{ model: "MigrationIndexProbe", keys: { key: 1 } }];

  before(async () => {
    await connectTestDatabase("schema-indexes");
  });
  after(dropTestDatabase);

  it("reports a unique index that duplicates prevent, as critical, and builds the rest", async () => {
    await Probe.init().catch(() => undefined);
    await Probe.collection.dropIndexes();
    await Probe.collection.insertMany([{ key: "a", other: "x" }, { key: "a", other: "y" }]);

    const outcomes = await buildModelIndexes([Probe as never], critical);
    const errors: string[] = [];
    const fatal = reportIndexOutcomes(outcomes, { warn: () => {}, error: (line) => errors.push(line) });

    assert.equal(fatal.length, 1);
    assert.deepEqual(fatal[0]?.keys, { key: 1 });
    assert.match(errors[0] ?? "", /MigrationIndexProbe \{"key":1\} \(unique\).*duplicate key/i);
    const other = outcomes.find((outcome) => outcome.keys.other === 1);
    assert.equal(other?.error, null, "a failure does not stop the other indexes");

    const inspected = await inspectModelIndexes(database(), [Probe as never], critical);
    assert.deepEqual(
      inspected.map((outcome) => [Object.keys(outcome.keys)[0], outcome.error]),
      [
        ["key", "missing"],
        ["other", null],
      ],
    );

    await Probe.collection.deleteOne({ other: "y" });
    const retried = await buildModelIndexes([Probe as never], critical);
    assert.ok(retried.every((outcome) => outcome.error === null));
  });
});
