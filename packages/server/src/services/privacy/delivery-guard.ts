import mongoose, { type Model } from "mongoose";
import { TRPCError } from "@trpc/server";
import { transactionSession, withBusinessTransaction } from "../business-transaction.js";
import { guardPlaintextWorkspaceWrites } from "./plaintext-guard.js";
type Call = (...args: unknown[]) => Promise<unknown>;
type Query = { op: string; clone(): Query; cast(model: unknown): Record<string, unknown>; getOptions(): { upsert?: boolean }; getUpdate(): unknown };
type Document = { _id: unknown; workspaceId: string };
type GuardModel = { modelName: string; collection: { collectionName: string }; Query: { prototype: { exec: Call } }; prototype: { save: Call; $save: Call }; create: Call; insertMany: Call; bulkWrite: Call; [key: symbol]: unknown };
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const unsupported = () => new TRPCError({ code: "BAD_REQUEST", message: "Unsupported plaintext delivery update" });
/** Deliveries are not quota records, but their stored envelopes contain private
 * content. Give every model write the same migration fence without changing
 * standard-workspace quota charges or wrapping the outbound HTTP request. */
export function installPlaintextDeliveryGuard(identity: Pick<Model<unknown>, "modelName" | "collection">): void {
  const model = identity as unknown as GuardModel, marker = Symbol.for("trackyourtime.privateDeliveryGuard");
  if (model[marker]) return; model[marker] = true;
  const workspaces = async (filter: Record<string, unknown>): Promise<string[]> => {
    if (!mongoose.connection.db) throw new Error("Delivery storage needs a database");
    const values = await mongoose.connection.db.collection(model.collection.collectionName).distinct("workspaceId", filter, { session: transactionSession() });
    return values.filter((value): value is string => typeof value === "string");
  };
  const prototype = model.Query.prototype, exec = prototype.exec;
  prototype.exec = function (this: Query, ...args) {
    if (!["updateOne", "updateMany", "findOneAndUpdate", "deleteOne", "deleteMany", "findOneAndDelete", "replaceOne", "findOneAndReplace"].includes(this.op)) return Reflect.apply(exec, this, args);
    const original = this;
    return withBusinessTransaction(async () => {
      const query = original.clone(), filter = query.cast(model), update = query.getUpdate(), options = query.getOptions();
      if (options.upsert || Array.isArray(update) || query.op.includes("Replace") || query.op === "replaceOne") throw unsupported();
      // An envelope belongs to its original workspace for its entire lifetime.
      for (const [key, value] of Object.entries(record(update))) if (key === "workspaceId" || Object.keys(record(value)).some((field) => field === "workspaceId" || field.startsWith("workspaceId.")) || (key === "$rename" && Object.values(record(value)).some((target) => target === "workspaceId"))) throw unsupported();
      await guardPlaintextWorkspaceWrites(await workspaces(filter));
      return Reflect.apply(exec, query, args);
    });
  };
  const save = model.prototype.save;
  model.prototype.save = function (this: Document, ...args) {
    const doc = this;
    return withBusinessTransaction(async () => {
      const existing = await workspaces({ _id: doc._id });
      if (typeof doc.workspaceId !== "string" || !doc.workspaceId || existing.some((id) => id !== doc.workspaceId)) throw unsupported();
      await guardPlaintextWorkspaceWrites([doc.workspaceId]);
      return Reflect.apply(save, doc, [{ ...record(args[0]), session: transactionSession() }, ...args.slice(1)]);
    });
  };
  model.prototype.$save = model.prototype.save;
  const create = model.create;
  model.create = (...args) => withBusinessTransaction(() => Reflect.apply(create, model, Array.isArray(args[0]) ? [args[0], { ...record(args[1]), ordered: true }] : args));
  const insertMany = model.insertMany;
  model.insertMany = (input, options) => withBusinessTransaction(async () => {
    const rows = Array.isArray(input) ? input : [input], ids = rows.map((row) => record(row).workspaceId);
    if (ids.some((id) => typeof id !== "string" || !id)) throw unsupported();
    await guardPlaintextWorkspaceWrites(ids as string[]);
    return Reflect.apply(insertMany, model, [input, { ...record(options), ordered: true, session: transactionSession() }]);
  });
  // There is no application bulk delivery writer. Refuse an unguarded door.
  model.bulkWrite = async () => { throw unsupported(); };
}
