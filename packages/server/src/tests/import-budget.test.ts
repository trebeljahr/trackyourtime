import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import mongoose from "mongoose";
import { ImportBudget, ImportLease } from "../models/ImportBudget.js";
import {
  createImportBudget,
  importBudget,
  importPayloadBytes,
  mongoImportBudgetStore,
  type ImportBudgetStore,
} from "../services/import/budget.js";
import { beforeBusinessCommit, transactionSession, withBusinessTransaction } from "../services/business-transaction.js";
import { dataRouter } from "../trpc/routers/data.js";
import { contextFor, freshStore, installStore, OWNER } from "./support/shared-workspace.js";
import {
  clearTestDatabase,
  connectTestDatabase,
  dropTestDatabase,
  skipWithoutDatabase,
  testDatabaseTransactions,
} from "./support/test-database.js";

function memoryStore() {
  const counters = new Map<string, { attempts: number; bytes: number }>();
  const leases = new Map<string, { token: string; until: number }>();
  const store: ImportBudgetStore = {
    async consume(key, bytes, now, limits) {
      const id = JSON.stringify([key, Math.floor(now.getTime() / limits.windowMs)]);
      const counter = counters.get(id) ?? { attempts: 0, bytes: 0 };
      counters.set(id, counter);
      if (counter.attempts >= limits.attempts || counter.bytes + bytes > limits.bytes) return false;
      counter.attempts++;
      counter.bytes += bytes;
      return true;
    },
    async acquire(key, token, now, leaseMs) {
      if ((leases.get(key)?.until ?? 0) > now.getTime()) return false;
      leases.set(key, { token, until: now.getTime() + leaseMs });
      return true;
    },
    async assertActive(key, token, now) {
      const lease = leases.get(key);
      return !!lease && lease.token === token && lease.until > now.getTime();
    },
    async release(key, token) {
      if (leases.get(key)?.token === token) leases.delete(key);
    },
  };
  return { store, counters, leases };
}

const args = (userId = "user-a", workspaceId = "workspace-a", input: unknown = { text: "review" }) =>
  ({ userId, workspaceId, input });

describe("import budgets", () => {
  it("counts the UTF-8 payload including malformed fields", () => {
    assert.equal(importPayloadBytes({ text: "🕒é", extra: "秘密" }), Buffer.byteLength('{"text":"🕒é","extra":"秘密"}', "utf8"));
    assert.equal(importPayloadBytes(undefined), 0);
  });

  it("charges failed parsing and caps attempts across workspaces", async () => {
    const { store, counters, leases } = memoryStore();
    const run = createImportBudget(store, { limits: { attempts: 2 } });
    await assert.rejects(run(args(), async () => { throw new Error("invalid file"); }), /invalid file/);
    await run(args("user-a", "workspace-b"), async () => undefined);
    await assert.rejects(run(args("user-a", "workspace-c"), async () => undefined), { code: "TOO_MANY_REQUESTS" });
    assert.equal([...counters.values()].filter((c) => c.attempts === 2).length, 1);
    assert.equal(leases.size, 0);
  });

  it("caps the shared workspace across different users and resets next hour", async () => {
    const { store } = memoryStore();
    let clock = new Date("2026-10-23T09:00:00Z");
    const run = createImportBudget(store, { limits: { attempts: 1 }, now: () => clock });
    await run(args(), async () => undefined);
    await assert.rejects(run(args("user-b"), async () => undefined), { code: "TOO_MANY_REQUESTS" });
    clock = new Date("2026-10-23T10:00:00Z");
    await run(args("user-b"), async () => undefined);
  });

  it("refuses cumulative UTF-8 bytes without invoking the handler", async () => {
    const { store } = memoryStore();
    const input = { text: "🕒é" };
    const run = createImportBudget(store, { limits: { bytes: importPayloadBytes(input) * 2 } });
    let calls = 0;
    const work = async () => { calls++; };
    await run(args("user-a", "workspace-a", input), work);
    await run(args("user-a", "workspace-a", input), work);
    await assert.rejects(run(args("user-a", "workspace-a", input), work), { code: "TOO_MANY_REQUESTS" });
    assert.equal(calls, 2);
  });

  it("holds both scopes, releases partial claims and isolates unrelated imports", async () => {
    const { store, leases } = memoryStore();
    const run = createImportBudget(store);
    await run(args(), async () => {
      await assert.rejects(run(args("user-a", "workspace-b"), async () => undefined), { code: "TOO_MANY_REQUESTS" });
      await assert.rejects(run(args("user-b", "workspace-a"), async () => undefined), { code: "TOO_MANY_REQUESTS" });
      assert.equal(leases.size, 2);
      await run(args("user-c", "workspace-c"), async () => undefined);
    });
    assert.equal(leases.size, 0);
  });

  it("refuses an expired holder and cannot release its successor's lease", async () => {
    const { store, leases } = memoryStore();
    let clock = new Date("2026-10-23T09:00:00Z");
    const run = createImportBudget(store, { limits: { leaseMs: 100 }, now: () => clock });
    await run(args(), async (oldLease) => {
      clock = new Date(clock.getTime() + 101);
      await run(args(), async (newLease) => {
        await assert.rejects(oldLease(), { code: "TIMEOUT" });
        await newLease();
        assert.equal(leases.size, 2);
      });
    });
    assert.equal(leases.size, 0);
  });

  it("fails closed when the shared store is unavailable", async () => {
    const { store } = memoryStore();
    store.consume = async () => { throw new Error("offline"); };
    let called = false;
    await assert.rejects(createImportBudget(store)(args(), async () => { called = true; }), { code: "SERVICE_UNAVAILABLE" });
    assert.equal(called, false);
  });

  it("charges both analyze and commit before schema/parser validation", async () => {
    const restore = installStore(freshStore());
    const { store, counters } = memoryStore();
    const stub = mock.method(importBudget, "run", createImportBudget(store, { limits: { attempts: 3 } }));
    try {
      const caller = dataRouter.createCaller(contextFor(OWNER));
      await assert.rejects(caller.analyze({ text: "" }), { code: "BAD_REQUEST" });
      await assert.rejects(caller.analyze({ text: '{"ciphertext":"opaque"}' }), { code: "BAD_REQUEST" });
      await assert.rejects(caller.commit({ text: '{"ciphertext":"opaque"}' }), { code: "BAD_REQUEST" });
      assert.ok([...counters.values()].every((counter) => counter.attempts === 3));
      await assert.rejects(caller.analyze({ text: "" }), { code: "TOO_MANY_REQUESTS" });
    } finally {
      stub.mock.restore();
      restore();
    }
  });
});

describe("shared MongoDB import budgets", { skip: skipWithoutDatabase }, () => {
  before(async () => {
    await connectTestDatabase("import-budget", [ImportBudget, ImportLease] as never);
  });
  beforeEach(clearTestDatabase);
  after(dropTestDatabase);

  it("admits only the budgeted attempts when processes race", async () => {
    const limits = { attempts: 3, bytes: 100, windowMs: 3_600_000, leaseMs: 300_000 };
    const now = new Date();
    const outcomes = await Promise.all(Array.from({ length: 12 }, () =>
      mongoImportBudgetStore.consume("race", 30, now, limits)));
    assert.equal(outcomes.filter(Boolean).length, 3);
    const counter = await ImportBudget.findOne().lean();
    assert.equal(counter?.attempts, 3);
    assert.equal(counter?.bytes, 90);
  });

  it("admits only one shared lease, recovers expiry, and releases by token", async () => {
    const now = new Date();
    const claims = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      mongoImportBudgetStore.acquire("lease", `token-${i}`, now, 100)));
    assert.equal(claims.filter(Boolean).length, 1);
    const winner = `token-${claims.indexOf(true)}`;
    const later = new Date(now.getTime() + 101);
    assert.equal(await mongoImportBudgetStore.acquire("lease", "successor", later, 100), true);
    await mongoImportBudgetStore.release("lease", winner);
    assert.equal(await mongoImportBudgetStore.assertActive("lease", "successor", later), true);
    assert.equal(await mongoImportBudgetStore.assertActive("lease", winner, later), false);
    assert.equal((await ImportLease.findById("lease").lean())?.token, "successor");
    assert.equal(ImportLease.schema.indexes().some(([, options]) => "expireAfterSeconds" in options), false);
  });

  it("retains budget after a business transaction rolls back", async (t) => {
    if (!await testDatabaseTransactions()) return t.skip("Replica set required");
    const run = createImportBudget(mongoImportBudgetStore);
    await assert.rejects(run(args(), async () => withBusinessTransaction(async () => {
      await mongoose.connection.db!.collection("import-test-records").insertOne({ value: 1 }, { session: transactionSession() });
      throw new Error("rollback");
    })), /rollback/);
    const counters = await ImportBudget.find().lean();
    assert.equal(counters.length, 2);
    assert.ok(counters.every((counter) => counter.attempts === 1));
    assert.equal(await mongoose.connection.db!.collection("import-test-records").countDocuments(), 0);
    assert.ok((await ImportLease.find().lean()).every((lease) => lease.token === null));
  });

  it("does not charge again when the database retries a business transaction", async (t) => {
    if (!await testDatabaseTransactions()) return t.skip("Replica set required");
    let attempts = 0;
    await createImportBudget(mongoImportBudgetStore)(args(), async () =>
      withBusinessTransaction(async () => {
        attempts++;
        if (attempts === 1) {
          const error = new mongoose.mongo.MongoServerError({ message: "retry import", code: 112 });
          error.addErrorLabel("TransientTransactionError");
          throw error;
        }
      }));
    assert.equal(attempts, 2);
    assert.ok((await ImportBudget.find().lean()).every((counter) => counter.attempts === 1));
  });

  it("rolls back an expired import after another process takes its lease", async (t) => {
    if (!await testDatabaseTransactions()) return t.skip("Replica set required");
    let clock = new Date();
    let tookOver = false;
    const run = createImportBudget(mongoImportBudgetStore, { now: () => clock, limits: { leaseMs: 100 } });
    await assert.rejects(run(args(), async (assertActive) => withBusinessTransaction(async () => {
      beforeBusinessCommit(() => assertActive(transactionSession()));
      await mongoose.connection.db!.collection("import-test-records").insertOne({ value: 1 }, { session: transactionSession() });
      if (!tookOver) {
        clock = new Date(clock.getTime() + 101);
        for (const key of [JSON.stringify(["user", "user-a"]), JSON.stringify(["workspace", "workspace-a"])]) {
          assert.equal(await mongoImportBudgetStore.acquire(key, "successor", clock, 100), true);
        }
        tookOver = true;
      }
    })), { code: "TIMEOUT" });
    assert.equal(await mongoose.connection.db!.collection("import-test-records").countDocuments(), 0);
    assert.ok((await ImportLease.find().lean()).every((lease) => lease.token === "successor"));
    assert.ok((await ImportBudget.find().lean()).every((counter) => counter.attempts === 1));
  });
});
