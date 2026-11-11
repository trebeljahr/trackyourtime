// Migration 5 against a real MongoDB: the better-auth 1.7 upgrade refuses to
// finish while an account key repeats, clears expired and duplicated device
// codes, and leaves the unique indexes better-auth 1.7 looks for. A second run
// changes nothing.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import mongoose from "mongoose";
import type { Db } from "mongodb";
import { betterAuth17, DEVICE_CODE_INDEXES } from "../services/migrations/005-better-auth-1-7.js";
import { connectTestDatabase, dropTestDatabase, skipWithoutDatabase } from "./support/test-database.js";

const database = (): Db => {
  const db = mongoose.connection.db;
  if (!db) throw new Error("not connected");
  return db;
};

const minutes = (n: number) => new Date(Date.now() + n * 60_000);

describe("migration 5: better-auth 1.7", { skip: skipWithoutDatabase }, () => {
  before(() => connectTestDatabase("migration-better-auth-1-7"));
  after(dropTestDatabase);

  it("refuses while an account key repeats, and names it", async () => {
    const db = database();
    await db.collection("account").drop().catch(() => undefined);
    await db.collection("deviceCode").drop().catch(() => undefined);
    await db.collection("account").insertMany([
      { providerId: "google", accountId: "g-1", userId: "u1" },
      { providerId: "google", accountId: "g-1", userId: "u2" },
      { providerId: "credential", accountId: "u3", userId: "u3" },
    ]);
    await assert.rejects(betterAuth17.up(db), /google\/g-1 ×2/);
  });

  it("clears expired and duplicated device codes, creates the indexes, runs twice", async () => {
    const db = database();
    await db.collection("account").drop().catch(() => undefined);
    await db.collection("deviceCode").drop().catch(() => undefined);
    await db.collection("account").insertMany([
      { providerId: "google", accountId: "g-1", userId: "u1" },
      { providerId: "credential", accountId: "u1", userId: "u1" },
    ]);
    await db.collection("deviceCode").insertMany([
      { deviceCode: "dead", userCode: "AAAA-AAAA", expiresAt: minutes(-30), status: "pending" },
      { deviceCode: "live-1", userCode: "BBBB-BBBB", expiresAt: minutes(5), status: "pending" },
      { deviceCode: "live-1", userCode: "CCCC-CCCC", expiresAt: minutes(8), status: "pending" },
      { deviceCode: "live-2", userCode: "CCCC-CCCC", expiresAt: minutes(3), status: "pending" },
      { deviceCode: "live-3", userCode: "DDDD-DDDD", expiresAt: minutes(9), status: "approved" },
    ]);

    await betterAuth17.up(db);
    await betterAuth17.up(db);

    const rows = await db.collection("deviceCode").find({}, { projection: { _id: 0, deviceCode: 1, userCode: 1 } }).sort({ deviceCode: 1 }).toArray();
    assert.deepEqual(rows, [
      { deviceCode: "live-1", userCode: "CCCC-CCCC" },
      { deviceCode: "live-3", userCode: "DDDD-DDDD" },
    ]);
    const indexes = await db.collection("deviceCode").listIndexes().toArray();
    for (const wanted of DEVICE_CODE_INDEXES) {
      const found = indexes.find((index) => index.name === wanted.name);
      assert.ok(found, `${wanted.name} exists`);
      assert.equal(found.unique, true);
      assert.deepEqual(found.key, wanted.key);
    }
    await assert.rejects(db.collection("deviceCode").insertOne({ deviceCode: "live-3", userCode: "EEEE-EEEE", expiresAt: minutes(5) }));
    assert.equal(await db.collection("account").countDocuments(), 2);
  });

  it("is a no-op on a database without device codes", async () => {
    const db = database();
    await db.collection("account").drop().catch(() => undefined);
    await db.collection("deviceCode").drop().catch(() => undefined);
    await betterAuth17.up(db);
    await betterAuth17.up(db);
  });
});
