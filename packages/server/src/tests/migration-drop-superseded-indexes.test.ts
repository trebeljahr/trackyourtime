// Migration 3 against a real MongoDB: it drops each index an `_id`-suffixed
// one superseded, builds the replacement first when it is missing, leaves
// every document and every non-plain index alone, and runs twice harmlessly.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import mongoose from "mongoose";
import type { Db } from "mongodb";
import { buildModelIndexes } from "../db/indexes.js";
import { allModels } from "../models/registry.js";
import { SUPERSEDED_INDEXES, dropSupersededIndexes } from "../services/migrations/003-drop-superseded-indexes.js";
import { connectTestDatabase, dropTestDatabase, skipWithoutDatabase } from "./support/test-database.js";

const database = (): Db => {
  const db = mongoose.connection.db;
  if (!db) throw new Error("not connected");
  return db;
};

const keysOf = async (collection: string): Promise<string[]> =>
  (await database().collection(collection).listIndexes().toArray()).map((index) => JSON.stringify(index.key)).sort();

/** Every document of a collection, in `_id` order, as stored. */
const snapshot = async (collection: string): Promise<unknown[]> =>
  database().collection(collection).find({}).sort({ _id: 1 }).toArray();

describe("migration 3: drop superseded indexes", { skip: skipWithoutDatabase }, () => {
  before(async () => {
    await connectTestDatabase("migration-superseded-indexes");
    // Let mongoose's automatic index builds finish, then start from bare
    // collections, so each case shapes the indexes an older database has.
    await Promise.all(allModels().map((model) => model.init().catch(() => undefined)));
    for (const name of new Set(SUPERSEDED_INDEXES.map((entry) => entry.collection))) {
      await database().collection(name).drop().catch(() => undefined);
    }
  });
  after(dropTestDatabase);

  it("names, for each old index, a replacement the schema declares plainly, and no longer declares the old one", () => {
    for (const { collection, old, replacement } of SUPERSEDED_INDEXES) {
      const model = allModels().find((candidate) => candidate.collection.collectionName === collection);
      assert.ok(model, `no model stores ${collection}`);
      const declared = model.schema.indexes() as [Record<string, unknown>, Record<string, unknown>][];
      const same = (keys: Record<string, unknown>) => (index: [Record<string, unknown>, unknown]) =>
        JSON.stringify(index[0]) === JSON.stringify(keys);
      const current = declared.find(same(replacement));
      assert.ok(current, `${collection} does not declare ${JSON.stringify(replacement)}`);
      assert.deepEqual(current[1], {}, `${collection} ${JSON.stringify(replacement)} is not plain`);
      assert.equal(declared.find(same(old)), undefined, `${collection} still declares ${JSON.stringify(old)}`);
    }
  });

  it("drops the plain old indexes, builds a missing replacement, keeps the rest and every document", async () => {
    const db = database();
    const at = new Date("2026-10-01T00:00:00Z");
    await db.collection("timeentries").insertMany(Array.from({ length: 20 }, (_, n) => ({
      workspaceId: "w", authorId: `a${n % 3}`, start: new Date(at.getTime() - n * 3_600_000), end: null,
    })).map((doc, n) => ({ ...doc, end: n === 0 ? null : doc.start })));
    await db.collection("invoices").insertMany(Array.from({ length: 10 }, (_, n) => ({
      workspaceId: "w", status: n % 2 ? "paid" : "sent", clientId: `c${n % 3}`, number: `N-${n}`,
      createdAt: new Date(at.getTime() - n * 86_400_000),
    })));
    // A database last started before 823cabad: old time entry indexes only.
    await db.collection("timeentries").createIndex({ workspaceId: 1, start: -1 });
    await db.collection("timeentries").createIndex({ workspaceId: 1, authorId: 1, start: -1 });
    // Upgraded since f84e7c2b: both generations of the plain invoice indexes.
    await db.collection("invoices").createIndex({ workspaceId: 1, createdAt: -1 });
    await db.collection("invoices").createIndex({ workspaceId: 1, createdAt: -1, _id: -1 });
    await db.collection("invoices").createIndex({ workspaceId: 1, status: 1, createdAt: -1 });
    // Somebody built this one with a rule of their own: not ours to drop.
    await db.collection("invoices").createIndex({ workspaceId: 1, clientId: 1, createdAt: -1 }, { sparse: true });
    // `webhookdeliveries` does not exist at all.

    const before = { entries: await snapshot("timeentries"), invoices: await snapshot("invoices") };
    await dropSupersededIndexes.up(db);

    assert.deepEqual(await keysOf("timeentries"), [
      JSON.stringify({ _id: 1 }),
      JSON.stringify({ workspaceId: 1, authorId: 1, start: -1, _id: -1 }),
      JSON.stringify({ workspaceId: 1, start: -1, _id: -1 }),
    ].sort());
    assert.deepEqual(await keysOf("invoices"), [
      JSON.stringify({ _id: 1 }),
      JSON.stringify({ workspaceId: 1, clientId: 1, createdAt: -1 }),
      JSON.stringify({ workspaceId: 1, createdAt: -1, _id: -1 }),
      JSON.stringify({ workspaceId: 1, status: 1, createdAt: -1, _id: -1 }),
    ].sort());
    assert.equal((await db.listCollections({ name: "webhookdeliveries" }).toArray()).length, 0);
    assert.deepEqual(await snapshot("timeentries"), before.entries);
    assert.deepEqual(await snapshot("invoices"), before.invoices);

    // Again, as after a crash before the record was written.
    await dropSupersededIndexes.up(db);
    assert.equal((await keysOf("timeentries")).length, 3);
    assert.equal((await keysOf("invoices")).length, 4);

    // The boot index build that follows finds the replacements already
    // there under the names it would have given them, and fails on nothing.
    const outcomes = await buildModelIndexes(allModels());
    assert.deepEqual(outcomes.filter((outcome) => outcome.error !== null), []);
    assert.deepEqual(await snapshot("timeentries"), before.entries);
    assert.deepEqual(await snapshot("invoices"), before.invoices);
  });
});
