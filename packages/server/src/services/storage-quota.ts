import { guardPlaintextWorkspaceWrites } from "./privacy/plaintext-guard.js";
import mongoose, { type Model } from "mongoose";
import { TRPCError } from "@trpc/server";
import { env } from "../config/env.js";
import { StorageFence, StorageUsage } from "../models/StorageUsage.js";
import { beforeBusinessCommit, transactionResource, transactionSession, withBusinessTransaction } from "./business-transaction.js";

// Change the accounting version whenever the collection list or charge changes.
// Literal collection names allow a baseline before every model is imported.
export function quotaCollections(): Record<string, string> {
  return {
    TimeEntry: "timeentries", Client: "clients", Project: "projects", Task: "tasks",
    Tag: "tags", Favorite: "favorites", Invoice: "invoices", ImportBatch: "importbatches",
    EntryOperation: "entryoperations", WorkspaceSettings: "workspacesettings",
    BusinessProfile: "businessprofiles", TimesheetApproval: "timesheetapprovals",
    TimesheetPolicy: "timesheetpolicies", WorkspaceMember: "workspacemembers",
    ApiToken: "apitokens", WebhookSubscription: "webhooksubscriptions",
    PrivateRecord: "privaterecords", PrivateWorkspaceCommit: "privateworkspacecommits",
    PrivateSnapshotChunk: "privatesnapshotchunks", PrivateSnapshotReader: "privatesnapshotreaders",
    PrivateDirectory: "privatedirectories", PrivateMigrationReceipt: "privatemigrationreceipts",
    PrivateWorkspace: "privateworkspaces",
  };
}

type Row = { _id: unknown; workspaceId: string; bytes: number; userId?: string };
type State = { fences: Set<string>; workspaces: Map<string, number>; usage: Map<string, number>; accounts: Map<string, number>; adopting: boolean };
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};

type ModelIdentity = Pick<Model<unknown>, "modelName" | "collection">;
type RuntimeCall = (...args: unknown[]) => Promise<unknown>;
type StorageDocument = { _id: unknown; workspaceId: string; userId: string };
type StorageQuery = {
  op: string;
  exec: RuntimeCall;
  clone(): StorageQuery;
  cast(model: ModelIdentity): Record<string, unknown>;
  getOptions(): { sort?: unknown; upsert?: boolean };
  getUpdate(): unknown;
  setUpdate(update: Record<string, unknown>): void;
  setQuery(filter: Record<string, unknown>): void;
};
// Mongoose overloads vary by model. This boundary describes only the runtime
// methods the wrappers forward, without changing the caller's model types.
type StorageModel = ModelIdentity & {
  [marker: symbol]: unknown;
  Query: { prototype: StorageQuery };
  prototype: { save: RuntimeCall; $save: RuntimeCall };
  create: RuntimeCall;
  insertMany(docs: unknown, options?: unknown): Promise<unknown>;
  bulkWrite(operations: unknown[], options?: unknown): Promise<unknown>;
  updateOne(filter: unknown, update: unknown, options: Record<string, unknown>): PromiseLike<{ modifiedCount: number }>;
};

export function storageLimitError(): TRPCError {
  // 412 is retryable by offline clients. A quota refusal must not discard queued time.
  return new TRPCError({ code: "PRECONDITION_FAILED", message: "Storage limit reached. Export and remove unneeded records, or contact the server operator. Existing records remain available." });
}

/** Logical storage allowance, not filesystem usage. A floor bounds record/index
 * overhead. Running timers reserve room for their stop and durable receipt. */
function charge(modelName: string): Record<string, unknown> {
  return { $add: [
    { $max: [4096, { $bsonSize: "$$ROOT" }] },
    ...(modelName === "TimeEntry" ? [{ $cond: [{ $eq: ["$end", null] }, 8192, 0] }] : []),
  ] };
}

function database() {
  if (!mongoose.connection.db) throw new Error("Storage accounting needs a database");
  return mongoose.connection.db;
}

async function fence(key: string, state: State): Promise<void> {
  if (state.fences.has(key)) return;
  try {
    await StorageFence.updateOne({ _id: key }, { $inc: { revision: 1 } }, { upsert: true });
  } catch (error) {
    if (error instanceof mongoose.mongo.MongoServerError && error.code === 11000) error.addErrorLabel("TransientTransactionError");
    throw error;
  }
  state.fences.add(key);
}

async function baseline(workspaceId: string, state: State): Promise<number> {
  const cached = state.usage.get(workspaceId);
  if (cached !== undefined) return cached;
  await fence(`workspace:${workspaceId}`, state);
  const stored = await StorageUsage.findById(workspaceId).lean();
  if (stored?.version === 2) { state.usage.set(workspaceId, stored.bytes); return stored.bytes; }
  let bytes = 0;
  // One scan on adoption, never one scan per timer tick. All later writes use deltas.
  for (const [modelName, collection] of Object.entries(quotaCollections())) {
    const [sum] = await database().collection(collection).aggregate([
      { $match: { workspaceId } }, { $group: { _id: null, bytes: { $sum: charge(modelName) } } },
    ], { session: transactionSession() }).toArray();
    bytes += Number(sum?.bytes ?? 0);
  }
  await StorageUsage.updateOne({ _id: workspaceId }, { $set: { bytes, version: 2 } }, { upsert: true });
  state.usage.set(workspaceId, bytes);
  return bytes;
}

async function ownedWorkspaces(userId: string): Promise<string[]> {
  const members = await database().collection("workspacemembers").find(
    { userId, role: "owner" }, { session: transactionSession(), projection: { workspaceId: 1 } },
  ).toArray();
  return [...new Set(members.map((row) => String(row.workspaceId)))].sort();
}

async function accountBytes(userId: string, state: State): Promise<number> {
  let bytes = 0;
  for (const workspaceId of await ownedWorkspaces(userId)) bytes += await baseline(workspaceId, state);
  return bytes;
}

function quotaState(): State {
  return transactionResource("storage-quota", () => {
    const state: State = { fences: new Set(), workspaces: new Map(), usage: new Map(), accounts: new Map(), adopting: false };
    beforeBusinessCommit(async () => {
      for (const [workspaceId, before] of state.workspaces) {
        const after = (await StorageUsage.findById(workspaceId).lean())?.bytes ?? 0;
        if (state.adopting && after > before) throw new Error("Ownership adoption cannot add stored content");
        if (!state.adopting && after > before && after > env.STORAGE_QUOTA_BYTES) throw storageLimitError();
      }
      for (const [userId, before] of state.accounts) {
        const after = await accountBytes(userId, state);
        if (!state.adopting && after > before && after > env.STORAGE_QUOTA_BYTES) throw storageLimitError();
      }
    });
    return state;
  });
}

async function prepare(workspaces: string[], members: string[] = [], privateData = false): Promise<void> {
  const state = quotaState();
  const ids = [...new Set(workspaces)].sort();
  if (!privateData) await guardPlaintextWorkspaceWrites(ids);
  const owners = await database().collection("workspacemembers").find(
    { workspaceId: { $in: ids }, role: "owner" },
    { session: transactionSession(), projection: { userId: 1 } },
  ).toArray();
  for (const userId of [...new Set([...members, ...owners.map((row) => String(row.userId))])].sort()) {
    await fence(`account:${userId}`, state);
    if (!state.accounts.has(userId)) state.accounts.set(userId, await accountBytes(userId, state));
  }
  for (const id of ids) {
    const bytes = await baseline(id, state);
    if (!state.workspaces.has(id)) state.workspaces.set(id, bytes);
  }
}

async function snapshot(model: ModelIdentity, filter: Record<string, unknown>, single = false, sort?: unknown): Promise<Row[]> {
  return database().collection(model.collection.collectionName).aggregate<Row>([
    { $match: filter },
    ...(sort ? [{ $sort: sort }] : []),
    ...(single ? [{ $limit: 1 }] : []),
    { $project: { _id: 1, workspaceId: 1, userId: 1, bytes: charge(model.modelName) } },
  ], { session: transactionSession() }).toArray();
}

async function accountChange(before: Row[], after: Row[]): Promise<void> {
  const delta = new Map<string, number>();
  for (const [rows, sign] of [[before, -1], [after, 1]] as const) {
    for (const row of rows) {
      if (typeof row.workspaceId !== "string" || !row.workspaceId) throw new Error("Storage writes require a workspace");
      delta.set(row.workspaceId, (delta.get(row.workspaceId) ?? 0) + sign * row.bytes);
    }
  }
  for (const [workspaceId, bytes] of delta) {
    if (!quotaState().workspaces.has(workspaceId)) throw new Error("Storage write changed workspace unexpectedly");
    if (bytes) await StorageUsage.updateOne({ _id: workspaceId }, { $inc: { bytes } });
    const state = quotaState();
    state.usage.set(workspaceId, (state.usage.get(workspaceId) ?? 0) + bytes);
  }
}

async function guarded<T>(work: () => Promise<T>): Promise<T> {
  return withBusinessTransaction(async () => {
    if (!transactionSession()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Storage protection requires MongoDB transactions. Configure a replica set." });
    return work();
  });
}

/** Account erasure can leave an existing shared workspace with a successor
 * already over allowance. Permit only adoption of existing bytes; future
 * growth stays blocked. Never make deleting an account depend on free space. */
export async function withStorageOwnershipAdoption<T>(work: () => Promise<T>): Promise<T> {
  return guarded(async () => {
    quotaState().adopting = true;
    return work();
  });
}

/** Install on each persistent workspace model, so REST, tRPC, jobs and direct
 * service callers share the boundary. Native collection writes are reserved
 * for migrations/account erasure; new application writers must use models. */
export function installStorageQuota(mongooseModel: ModelIdentity): void {
  const model = mongooseModel as unknown as StorageModel;
  // These models store ciphertext/commitments and must remain writable during
  // preparation/private mode. Authentication and workspace fences stay in the
  // private services; ordinary models keep their plaintext-write guard.
  const privateData = ["PrivateRecord", "PrivateWorkspaceCommit", "PrivateSnapshotChunk", "PrivateSnapshotReader", "PrivateDirectory", "PrivateMigrationReceipt", "PrivateWorkspace"].includes(model.modelName);
  const marker = Symbol.for("trackyourtime.storageQuota");
  if (model[marker]) return;
  model[marker] = true;
  const prototype = model.Query.prototype;
  const exec = prototype.exec;
  prototype.exec = function (this: StorageQuery, ...args: unknown[]): Promise<unknown> {
    const op = this.op;
    if (!["updateOne", "updateMany", "findOneAndUpdate", "deleteOne", "deleteMany", "findOneAndDelete", "replaceOne", "findOneAndReplace"].includes(op)) return Reflect.apply(exec, this, args);
    const original = this;
    return guarded(async () => {
      const query = original.clone();
      const filter = query.cast(model);
      const options = query.getOptions();
      const update = query.getUpdate();
      if (Array.isArray(update) || op.includes("Replace") || op === "replaceOne") throw new TRPCError({ code: "BAD_REQUEST", message: "Unsupported storage update" });
      const before = await snapshot(model, filter, !op.endsWith("Many"), options.sort);
      // Pin a single write to the row chosen for accounting and privacy
      // fencing. A later query plan must not select a different workspace.
      if (before.length && !op.endsWith("Many")) query.setQuery({ ...filter, _id: before[0]!._id });
      const proposed = { ...record(filter), ...record(update), ...record(record(update).$setOnInsert), ...record(record(update).$set) };
      const ids = before.map((row) => row._id);
      if (!before.length && options.upsert) {
        const id = proposed._id ?? new mongoose.Types.ObjectId();
        query.setUpdate({ ...record(update), $setOnInsert: { ...record(record(update).$setOnInsert), _id: id } });
        ids.push(id);
      }
      await prepare([...before.map((row) => row.workspaceId), ...(typeof proposed.workspaceId === "string" ? [proposed.workspaceId] : [])],
        model.modelName === "WorkspaceMember" ? [...before.map((row) => row.userId!), ...(typeof proposed.userId === "string" ? [proposed.userId] : [])] : [], privateData);
      const result = await Reflect.apply(exec, query, args);
      await accountChange(before, await snapshot(model, { _id: { $in: ids } }));
      return result;
    });
  };
  const save = model.prototype.save;
  model.prototype.save = function (this: StorageDocument, ...args: unknown[]): Promise<unknown> {
    const doc = this;
    return guarded(async () => {
      const before = await snapshot(model, { _id: doc._id });
      await prepare([...before.map((row) => row.workspaceId), doc.workspaceId], model.modelName === "WorkspaceMember" ? [doc.userId] : [], privateData);
      const result = await Reflect.apply(save, doc, [{ ...record(args[0]), session: transactionSession() }, ...args.slice(1)]);
      await accountChange(before, await snapshot(model, { _id: doc._id }));
      return result;
    });
  };
  // Mongoose create()/insertOne() call the $save alias rather than save().
  model.prototype.$save = model.prototype.save;
  const create = model.create;
  model.create = function (...args: unknown[]): Promise<unknown> {
    return guarded(() => Reflect.apply(create, model, Array.isArray(args[0]) ? [args[0], { ...record(args[1]), ordered: true }] : args));
  };
  const insertMany = model.insertMany;
  model.insertMany = function (docs: unknown, options?: unknown): Promise<unknown> {
    return guarded(async () => {
      const documents: unknown[] = Array.isArray(docs) ? docs : [docs];
      const rows = documents.map((doc) => ({ ...record(doc), _id: (doc as StorageDocument)._id ?? new mongoose.Types.ObjectId() } as StorageDocument));
      await prepare(rows.map((row) => row.workspaceId), model.modelName === "WorkspaceMember" ? rows.map((row) => row.userId) : [], privateData);
      const result = await Reflect.apply(insertMany, model, [rows, { ...record(options), ordered: true, throwOnValidationError: true }]);
      await accountChange([], await snapshot(model, { _id: { $in: rows.map((row) => row._id) } }));
      return result;
    });
  };
  // The only application bulk writer reorders favorites. Execute supported
  // operations through the same guarded queries; never create an unmetered door.
  model.bulkWrite = function (operations: unknown[], options?: unknown): Promise<unknown> {
    return guarded(async () => {
      let modifiedCount = 0;
      for (const value of operations) {
        const operation = value as { updateOne?: { filter: unknown; update: unknown; upsert?: boolean } };
        if (!operation.updateOne || Object.keys(operation).length !== 1 || operation.updateOne.upsert) throw new TRPCError({ code: "BAD_REQUEST", message: "Unsupported storage bulk operation" });
        const result = await model.updateOne(operation.updateOne.filter, operation.updateOne.update, { ...record(options), upsert: false });
        modifiedCount += result.modifiedCount;
      }
      return { modifiedCount };
    });
  };
}
