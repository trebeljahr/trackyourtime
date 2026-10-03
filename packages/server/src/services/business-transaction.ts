import { AsyncLocalStorage } from "node:async_hooks";
import mongoose, { type ClientSession } from "mongoose";
import { TRPCError } from "@trpc/server";
import { WorkspaceWriteFence } from "../models/TimesheetApproval.js";

mongoose.set("transactionAsyncLocalStorage", true);
type State = { session: ClientSession; fenced: Set<string>; effects: (() => void | Promise<void>)[] };
const context = new AsyncLocalStorage<State>();
let topology: { db: object; supported: boolean } | undefined;

export async function supportsBusinessTransactions(): Promise<boolean> {
  const db = mongoose.connection.db;
  if (!db || mongoose.connection.readyState !== 1) return false;
  if (topology?.db === db) return topology.supported;
  const hello = await db.admin().command({ hello: 1 });
  const supported = !!hello.logicalSessionTimeoutMinutes && (!!hello.setName || hello.msg === "isdbgrid");
  topology = { db, supported };
  return supported;
}

export function approvalConflict(message = "TIMESHEET_LOCKED"): TRPCError {
  return new TRPCError({ code: "CONFLICT", message });
}
export function transactionSession(): ClientSession | undefined { return context.getStore()?.session; }

/** Return true when publication was queued; discarded retries publish nothing. */
export function deferAfterCommit(effect: () => void | Promise<void>): boolean {
  const state = context.getStore();
  if (!state) return false;
  state.effects.push(effect);
  return true;
}

export async function withBusinessTransaction<T>(work: () => Promise<T>): Promise<T> {
  if (context.getStore() || !(await supportsBusinessTransactions())) return work();
  let committedEffects: State["effects"] = [];
  const result = await mongoose.connection.transaction(async (session) => {
    const state: State = { session, fenced: new Set(), effects: [] };
    const value = await context.run(state, async () => {
      try { return await work(); } catch (error) {
        // tRPC wraps a resolver's Mongo error. Preserve the driver's retry
        // label instead of turning a write conflict into a permanent 500.
        let cause: unknown = error;
        for (let depth = 0; depth < 5 && cause instanceof TRPCError; depth++) cause = cause.cause;
        if (cause instanceof mongoose.mongo.MongoError && cause.hasErrorLabel("TransientTransactionError")) throw cause;
        throw error;
      }
    });
    committedEffects = state.effects;
    return value;
  }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, readPreference: "primary" });
  // Commit has succeeded. Publication failure must never turn it into a failed
  // mutation response or replay an external effect in a transaction retry.
  for (const effect of committedEffects) {
    try { await effect(); } catch (error) { console.error("[after-commit] publication failed", error); }
  }
  return result;
}

export function transactional<A extends unknown[], R>(work: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return (...args) => withBusinessTransaction(() => work(...args));
}

export async function fenceWorkspace(workspaceId: string): Promise<void> {
  const state = context.getStore();
  if (!state) throw approvalConflict("TIMESHEET_TRANSACTION_REQUIRED");
  if (state.fenced.has(workspaceId)) return;
  try {
    await WorkspaceWriteFence.updateOne({ _id: workspaceId }, { $inc: { revision: 1 } }, { upsert: true });
  } catch (error) {
    // Two first writers can race the fence's insert. Retry the transaction,
    // exactly as an existing fence's write conflict is retried by the driver.
    if (error instanceof mongoose.mongo.MongoServerError && error.code === 11000) error.addErrorLabel("TransientTransactionError");
    throw error;
  }
  state.fenced.add(workspaceId);
}

/** Mongoose forbids concurrent commands on a transaction's session. Callers
 * supply thunks so commands start only when their predecessor finishes. */
export async function businessReads<const T extends readonly (() => unknown)[]>(reads: T): Promise<{ [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
  if (!transactionSession()) return Promise.all(reads.map((read) => read())) as Promise<{ [K in keyof T]: Awaited<ReturnType<T[K]>> }>;
  const results: unknown[] = [];
  for (const read of reads) results.push(await read());
  return results as { [K in keyof T]: Awaited<ReturnType<T[K]>> };
}
