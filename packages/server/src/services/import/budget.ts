import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import mongoose, { type ClientSession } from "mongoose";
import { ImportBudget, ImportLease } from "../../models/ImportBudget.js";

export const IMPORT_ATTEMPTS_PER_HOUR = 60;
export const IMPORT_BYTES_PER_HOUR = 128 * 1024 * 1024;
export const IMPORT_WINDOW_MS = 60 * 60 * 1000;
export const IMPORT_LEASE_MS = 5 * 60 * 1000;

export type ImportBudgetLimits = {
  attempts: number;
  bytes: number;
  windowMs: number;
  leaseMs: number;
};
const defaultLimits: ImportBudgetLimits = {
  attempts: IMPORT_ATTEMPTS_PER_HOUR,
  bytes: IMPORT_BYTES_PER_HOUR,
  windowMs: IMPORT_WINDOW_MS,
  leaseMs: IMPORT_LEASE_MS,
};

export interface ImportBudgetStore {
  consume(key: string, bytes: number, now: Date, limits: ImportBudgetLimits): Promise<boolean>;
  acquire(key: string, token: string, now: Date, leaseMs: number): Promise<boolean>;
  assertActive(key: string, token: string, now: Date, session?: ClientSession): Promise<boolean>;
  release(key: string, token: string): Promise<void>;
}

const duplicateKey = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === 11000;
const unavailable = (cause: unknown): TRPCError => new TRPCError({
  code: "SERVICE_UNAVAILABLE",
  message: "Import protection is temporarily unavailable. Please try again later.",
  cause,
});
const limited = (): TRPCError => new TRPCError({
  code: "TOO_MANY_REQUESTS",
  message: "The hourly import limit has been reached. Please try again next hour.",
});
const busy = (): TRPCError => new TRPCError({
  code: "TOO_MANY_REQUESTS",
  message: "Another import is running for this account or workspace. Please wait for it to finish.",
});

/** Include malformed fields and the envelope, using UTF-8 bytes, not JS characters. */
export function importPayloadBytes(input: unknown): number {
  return Buffer.byteLength(JSON.stringify(input) ?? "", "utf8");
}

async function ready(): Promise<void> {
  if (mongoose.connection.readyState !== 1) throw unavailable(new Error("Database unavailable"));
  await Promise.all([ImportBudget.init(), ImportLease.init()]);
}

type BudgetRow = { _id: string; attempts: number; bytes: number; expiresAt: Date };
type LeaseRow = { _id: string; token: string | null; until: Date; revision: number };

function nativeCollections() {
  const db = mongoose.connection.db;
  if (!db || mongoose.connection.readyState !== 1) throw unavailable(new Error("Database unavailable"));
  return {
    budgets: db.collection<BudgetRow>(ImportBudget.collection.collectionName),
    leases: db.collection<LeaseRow>(ImportLease.collection.collectionName),
  };
}

/** Native collections deliberately bypass Mongoose's transaction AsyncLocalStorage.
 * A rejected import still spent resources; its budget must survive rollback.
 */
export const mongoImportBudgetStore: ImportBudgetStore = {
  async consume(key, bytes, now, limits) {
    await ready();
    if (bytes > limits.bytes) return false;
    const window = Math.floor(now.getTime() / limits.windowMs);
    const id = JSON.stringify([key, window]);
    try {
      await nativeCollections().budgets.updateOne({ _id: id }, {
        $setOnInsert: {
          attempts: 0,
          bytes: 0,
          // Keep an old window briefly for in-flight requests. TTL never
          // expires a current window and cannot reset a live counter.
          expiresAt: new Date((window + 2) * limits.windowMs),
        },
      }, { upsert: true, timeoutMS: 5_000 });
    } catch (error) {
      if (!duplicateKey(error)) throw error;
    }
    const result = await nativeCollections().budgets.updateOne({
      _id: id,
      attempts: { $lt: limits.attempts },
      bytes: { $lte: limits.bytes - bytes },
    }, { $inc: { attempts: 1, bytes } }, { timeoutMS: 5_000 });
    return result.matchedCount === 1;
  },
  async acquire(key, token, now, leaseMs) {
    await ready();
    try {
      const result = await nativeCollections().leases.updateOne({
        _id: key,
        until: { $lte: now },
      }, {
        $set: { token, until: new Date(now.getTime() + leaseMs) },
        $inc: { revision: 1 },
      }, { upsert: true, timeoutMS: 5_000 });
      return result.matchedCount === 1 || result.upsertedCount === 1;
    } catch (error) {
      if (duplicateKey(error)) return false;
      throw error;
    }
  },
  async assertActive(key, token, now, session) {
    // When called before commit, this write participates in the import's
    // transaction. A takeover conflicts with it, so a stale holder cannot
    // pass a read and then commit behind the new holder.
    const result = await nativeCollections().leases.updateOne({
      _id: key, token, until: { $gt: now },
    }, { $inc: { revision: 1 } }, { session, timeoutMS: 5_000 });
    return result.matchedCount === 1;
  },
  async release(key, token) {
    await nativeCollections().leases.updateOne({ _id: key, token }, {
      $set: { token: null, until: new Date(0) },
    }, { timeoutMS: 5_000 });
  },
};

export type AssertImportLease = (session?: ClientSession) => Promise<void>;

/** Injectable storage/clock; production always uses the shared database. */
export function createImportBudget(
  store: ImportBudgetStore,
  options: { limits?: Partial<ImportBudgetLimits>; now?: () => Date; token?: () => string } = {},
) {
  const limits = { ...defaultLimits, ...options.limits };
  const now = options.now ?? (() => new Date());
  return async function withImportBudget<T>(
    args: { userId: string; workspaceId: string; input: unknown },
    work: (assertActive: AssertImportLease) => Promise<T>,
  ): Promise<T> {
    const keys = [JSON.stringify(["user", args.userId]), JSON.stringify(["workspace", args.workspaceId])];
    const token = (options.token ?? randomUUID)();
    const acquired: string[] = [];
    const started = now();
    const bytes = importPayloadBytes(args.input);
    try {
      // Charges are deliberately not refunded when another scope refuses,
      // validation fails, or the business transaction aborts/retries.
      for (const key of keys) {
        if (!await store.consume(key, bytes, started, limits)) throw limited();
      }
      for (const key of keys) {
        if (!await store.acquire(key, token, started, limits.leaseMs)) throw busy();
        acquired.push(key);
      }
    } catch (error) {
      await release();
      if (error instanceof TRPCError) throw error;
      throw unavailable(error);
    }

    const assertActive: AssertImportLease = async (session) => {
      try {
        for (const key of keys) {
          if (!await store.assertActive(key, token, now(), session)) {
            throw new TRPCError({ code: "TIMEOUT", message: "This import timed out. Please try a smaller file." });
          }
        }
      } catch (error) {
        // Preserve Mongo transaction retry labels for the transaction wrapper.
        if (session || error instanceof TRPCError) throw error;
        throw unavailable(error);
      }
    };
    try {
      return await work(assertActive);
    } finally {
      await release();
    }

    async function release(): Promise<void> {
      for (const key of acquired) {
        try { await store.release(key, token); }
        catch (error) {
          // A successful commit must not become a failed response. A failed
          // release is safe: only this token is held, and its lease expires.
          console.error("[import] Could not release import lease", error);
        }
      }
    }
  };
}

/** An explicit seam for caller tests to supply an isolated fake. */
export const importBudget = { run: createImportBudget(mongoImportBudgetStore) };
