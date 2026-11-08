// Migration 4 against a real MongoDB: payment reminders are removed, so what
// they stored goes too — the per-invoice settings (with the customer's
// address), the index the job scanned by and the job's lease row. Everything
// else on an invoice stays, and a second run changes nothing.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import mongoose from "mongoose";
import type { Db } from "mongodb";
import { REMINDER_INDEX_KEYS, REMINDER_JOB_NAME, removeInvoiceReminders } from "../services/migrations/004-remove-invoice-reminders.js";
import { connectTestDatabase, dropTestDatabase, skipWithoutDatabase } from "./support/test-database.js";

const database = (): Db => {
  const db = mongoose.connection.db;
  if (!db) throw new Error("not connected");
  return db;
};

describe("migration 4: remove invoice reminders", { skip: skipWithoutDatabase }, () => {
  before(() => connectTestDatabase("migration-remove-invoice-reminders"));
  after(dropTestDatabase);

  it("removes stored reminders, their index and job row, keeps the rest, and runs twice harmlessly", async () => {
    const db = database();
    await db.collection("invoices").drop().catch(() => undefined);
    await db.collection("invoices").insertMany([
      { number: "A", followThrough: { payments: [{ requestId: "p1", amountMinor: 100 }], reminders: { enabled: true, recipient: "customer@example.test", timezone: "UTC", sentDays: [1] } } },
      { number: "B", followThrough: { credit: { number: "CN-B" } } },
      { number: "C" },
    ]);
    await db.collection("invoices").createIndex(REMINDER_INDEX_KEYS);
    await db.collection("invoices").createIndex({ number: 1 });
    await db.collection("scheduledjobs").insertMany([{ name: REMINDER_JOB_NAME }, { name: "runaway-reminder" }]);

    await removeInvoiceReminders.up(db);
    await removeInvoiceReminders.up(db);

    const rows = await db.collection("invoices").find({}, { projection: { _id: 0 } }).sort({ number: 1 }).toArray();
    assert.deepEqual(rows, [
      { number: "A", followThrough: { payments: [{ requestId: "p1", amountMinor: 100 }] } },
      { number: "B", followThrough: { credit: { number: "CN-B" } } },
      { number: "C" },
    ]);
    assert.equal(JSON.stringify(rows).includes("customer@example.test"), false);
    const indexes = (await db.collection("invoices").listIndexes().toArray()).map((index) => JSON.stringify(index.key));
    assert.equal(indexes.includes(JSON.stringify(REMINDER_INDEX_KEYS)), false);
    assert.equal(indexes.includes(JSON.stringify({ number: 1 })), true);
    assert.deepEqual((await db.collection("scheduledjobs").find({}, { projection: { _id: 0 } }).toArray()), [{ name: "runaway-reminder" }]);
  });

  it("is a no-op on a database that never had invoices", async () => {
    const db = database();
    await db.collection("invoices").drop().catch(() => undefined);
    await removeInvoiceReminders.up(db);
  });
});
