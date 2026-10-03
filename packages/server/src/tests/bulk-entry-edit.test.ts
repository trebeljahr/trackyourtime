import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bulkEditEntriesSchema, type BulkEditEntriesInput } from "@starter/shared";
import { bulkEntryCAS, bulkTagIds, executeBulkEdit, type BulkEntry, type BulkEntryStore } from "../services/entries/bulk.js";
import type { WorkspaceScope } from "../services/scope.js";

const scope: WorkspaceScope = { workspaceId: "workspace", userId: "author", visibility: { userId: "author", canViewOthersTime: true, canViewOthersMoney: true } };
const first = "000000000000000000000001";
const second = "000000000000000000000002";
const stamp = "2026-10-03T10:00:00.000Z";
function entry(id: string, patch: Partial<BulkEntry> = {}): BulkEntry {
  return { _id: id, workspaceId: scope.workspaceId, authorId: scope.userId, description: "Keep this", projectId: null, taskId: null, billable: false,
    start: new Date(stamp), end: null, durationSec: 0, hourlyRate: null, currency: "EUR", source: "web", timeZone: "Europe/Berlin", tagIds: [], invoiceId: null, createdAt: new Date(stamp), updatedAt: new Date(stamp), ...patch };
}
function request(operation: BulkEditEntriesInput["operation"] = { kind: "update", taskId: null }): BulkEditEntriesInput {
  return { workspaceId: scope.workspaceId, entries: [first, second].map((id) => ({ id, expectedUpdatedAt: stamp })), operation };
}
function fixture(rows: BulkEntry[], patch: Partial<BulkEntryStore> = {}): { store: BulkEntryStore; writes: string[] } {
  const writes: string[] = [];
  return { writes, store: {
    member: async () => true, read: async () => rows, locked: async () => false,
    prepare: async (_scope, _entry, operation) => operation.kind === "update" ? { taskId: operation.taskId } : {},
    write: async (_scope, plan) => { writes.push(String(plan.entry._id)); return true; }, ...patch,
  } };
}

describe("bounded bulk entry editing", () => {
  it("rejects duplicate ids, empty operations, excess targets and unknown fields", () => {
    for (const raw of [
      { ...request(), entries: [request().entries[0], request().entries[0]] },
      { ...request(), entries: Array.from({ length: 101 }, (_, i) => ({ id: String(i), expectedUpdatedAt: stamp })) },
      { ...request(), operation: { kind: "update" } },
      { ...request(), operation: { kind: "update", taskId: null, description: "overwrite" } },
    ]) assert.equal(bulkEditEntriesSchema.safeParse(raw).success, false);
  });
  it("validates all ownership/workspace targets before any writes, even with time visibility", async () => {
    for (const foreign of [entry(second, { authorId: "colleague" }), entry(second, { workspaceId: "elsewhere" })]) {
      const { store, writes } = fixture([entry(first), foreign]);
      const result = await executeBulkEdit(scope, request(), store);
      assert.equal(result.phase, "validation"); assert.deepEqual(writes, []);
      assert.deepEqual(result.results, [{ id: first, success: false, reason: "not-applied" }, { id: second, success: false, reason: "not-found" }]);
    }
  });
  it("invalid references, stale revisions and approval locks stop the entire preflight", async () => {
    const fixtures = [
      fixture([entry(first), entry(second)], { prepare: async (_scope, row) => { if (String(row._id) === second) throw Error("foreign task"); return {}; } }),
      fixture([entry(first), entry(second, { updatedAt: new Date("2026-10-03T11:00:00Z") })]),
      fixture([entry(first), entry(second)], { locked: async (_scope, row) => String(row._id) === second }),
    ];
    for (const { store, writes } of fixtures) {
      const result = await executeBulkEdit(scope, request(), store);
      assert.equal(result.phase, "validation"); assert.deepEqual(writes, []);
    }
  });
  it("rejects invoiced task/deletion changes but permits deliberately changing tags", async () => {
    for (const operation of [{ kind: "update", taskId: null }, { kind: "delete" }] as const) {
      const { store, writes } = fixture([entry(first), entry(second, { invoiceId: "invoice" })]);
      const result = await executeBulkEdit(scope, request(operation), store);
      assert.deepEqual(result.results[1], { id: second, success: false, reason: "invoiced" }); assert.deepEqual(writes, []);
    }
    const { store, writes } = fixture([entry(first), entry(second, { invoiceId: "invoice" })]);
    const result = await executeBulkEdit(scope, request({ kind: "update", tags: { mode: "clear" } }), store);
    assert.equal(result.results.every((row) => row.success), true); assert.equal(writes.length, 2);
  });
  it("set/add/remove/clear preserve deliberate tag semantics and enforce the final union limit", async () => {
    assert.equal(bulkTagIds([first], undefined), undefined);
    assert.deepEqual(bulkTagIds([first], { mode: "set", ids: [second] }), [second]);
    assert.deepEqual(bulkTagIds([first], { mode: "add", ids: [first, second] }), [first, second]);
    assert.deepEqual(bulkTagIds([first, second], { mode: "remove", ids: [first] }), [second]);
    assert.deepEqual(bulkTagIds([first, second], { mode: "clear" }), []);
    const { store, writes } = fixture([entry(first), entry(second, { tagIds: Array.from({ length: 20 }, (_, index) => `tag-${index}`) })]);
    const result = await executeBulkEdit(scope, request({ kind: "update", tags: { mode: "add", ids: [first] } }), store);
    assert.deepEqual(writes, []); assert.deepEqual(result.results[1], { id: second, success: false, reason: "too-many-tags" });
  });
  it("reports a CAS race after one success without claiming an atomic transaction", async () => {
    const { store } = fixture([entry(first), entry(second)], { write: async (_scope, plan) => String(plan.entry._id) === first });
    const result = await executeBulkEdit(scope, request(), store);
    assert.equal(result.atomic, false); assert.equal(result.phase, "write");
    assert.deepEqual(result.results, [{ id: first, success: true }, { id: second, success: false, reason: "conflict" }]);
  });
  it("checks membership again during writes and retains later failed targets", async () => {
    let checks = 0;
    const { store, writes } = fixture([entry(first), entry(second)], { member: async () => ++checks < 3 });
    const result = await executeBulkEdit(scope, request(), store);
    assert.deepEqual(writes, [first]);
    assert.deepEqual(result.results[1], { id: second, success: false, reason: "not-found" });
  });
  it("does not misreport committed writes when notification effects throw or reject", async () => {
    for (const effects of [() => { throw Error("sync failed"); }, async () => { throw Error("webhook failed"); }]) {
      const { store } = fixture([entry(first), entry(second)], { effects });
      const result = await executeBulkEdit(scope, request(), store);
      assert.equal(result.results.every((row) => row.success), true);
    }
  });
  it("stops after an uncertain database write and explicitly reports untouched targets", async () => {
    const { store } = fixture([entry(first), entry(second)], { write: async () => { throw Error("connection lost"); } });
    const result = await executeBulkEdit(scope, request(), store);
    assert.deepEqual(result.results, [{ id: first, success: false, reason: "unconfirmed" }, { id: second, success: false, reason: "not-applied" }]);
  });
  it("CAS protects a running entry without overwriting its times, source, description or money", () => {
    const row = entry(first);
    const filter = bulkEntryCAS(scope, row);
    assert.equal(filter.authorId, scope.userId); assert.equal(filter.workspaceId, scope.workspaceId);
    assert.equal(filter.updatedAt, row.updatedAt); assert.equal(filter.invoiceId, null);
    assert.deepEqual(filter.tagIds, []); assert.equal(filter.taskId, null);
  });
});

describe("Mongo bulk write predicates", () => {
  it("applies only the planned fields and rejects a same-millisecond invoice/tag race", async () => {
    const { TimeEntry } = await import("../models/TimeEntry.js");
    const { mongoBulkEntryStore } = await import("../services/entries/bulk.js");
    const handle = TimeEntry as unknown as {
      findOneAndUpdate: (filter: Record<string, unknown>, update: { $set: Record<string, unknown> }, options: Record<string, unknown>) => { lean: () => Promise<BulkEntry | null> };
    };
    const original = handle.findOneAndUpdate;
    let current = entry(first);
    handle.findOneAndUpdate = (filter, update, options) => ({ lean: async () => {
      assert.equal(options.timestamps, false);
      for (const [key, value] of Object.entries(filter)) {
        const actual = (current as unknown as Record<string, unknown>)[key];
        if (typeof value === "object" && value !== null && "$exists" in value) {
          if ((actual !== undefined) !== value.$exists) return null;
        } else if (JSON.stringify(actual) !== JSON.stringify(value)) return null;
      }
      current = { ...current, ...update.$set } as BulkEntry;
      return current;
    } });
    try {
      const before = structuredClone(current);
      const plan = { entry: before, set: { taskId: second, tagIds: [second] } };
      assert.equal(await mongoBulkEntryStore.write(scope, plan, { kind: "update", taskId: second, tags: { mode: "set", ids: [second] } }), true);
      assert.equal(current.taskId, second); assert.deepEqual(current.tagIds, [second]);
      for (const field of ["description", "clientId", "projectId", "billable", "start", "end", "durationSec", "hourlyRate", "currency", "source", "timeZone"] as const) {
        assert.deepEqual(current[field], before[field], `Unrelated ${field} must survive`);
      }
      assert.ok(current.updatedAt.getTime() > before.updatedAt.getTime());
      const selected = structuredClone(current);
      current = { ...current, invoiceId: "claimed", tagIds: [first] };
      assert.equal(await mongoBulkEntryStore.write(scope, { entry: selected, set: { taskId: null } }, { kind: "update", taskId: null }), false);
      assert.equal(current.taskId, second); assert.equal(current.invoiceId, "claimed"); assert.deepEqual(current.tagIds, [first]);
    } finally { handle.findOneAndUpdate = original; }
  });
  it("validates even remove-tag ids before building a patch", async () => {
    const { Tag } = await import("../models/Tag.js");
    const { mongoBulkEntryStore } = await import("../services/entries/bulk.js");
    const handle = Tag as unknown as { countDocuments: (filter: Record<string, unknown>) => Promise<number> };
    const original = handle.countDocuments;
    let checkedWorkspace: unknown;
    handle.countDocuments = async (filter) => { checkedWorkspace = filter.workspaceId; return 0; };
    try {
      await assert.rejects(() => mongoBulkEntryStore.prepare(scope, entry(first), { kind: "update", tags: { mode: "remove", ids: [second] } }));
      assert.equal(checkedWorkspace, scope.workspaceId);
    } finally { handle.countDocuments = original; }
  });
});
