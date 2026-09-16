// Builds every schema index at boot and says which failed.
//
// Mongoose starts the same build when a model registers, but swallows the
// result (`Model.init()` is caught with a no-op), so a unique index that could
// not be built — because duplicates already exist — leaves its invariant
// unenforced with nothing in the log. Here each index is created on its own,
// every failure is reported with the model, the key pattern and the reason,
// and a failure on an invariant the app relies on stops the boot.
//
// Never `syncIndexes()`: it drops indexes the schema does not declare, which
// includes every index a newer release added. An older build rolled back onto
// the database must leave those alone.
import type { CreateIndexesOptions } from "mongodb";
import type mongoose from "mongoose";

export type IndexKeys = Record<string, unknown>;

export type IndexOutcome = {
  model: string;
  collection: string;
  keys: IndexKeys;
  unique: boolean;
  /** A failure here stops the boot. */
  critical: boolean;
  /** Null when the index exists or was built. */
  error: string | null;
};

/**
 * Unique indexes whose absence corrupts data rather than slowing a query. A
 * duplicate running timer, membership, invoice number, job row or token prefix
 * is a wrong answer the app cannot recover from on its own; every other index
 * failing is logged as a warning.
 */
export const CRITICAL_INDEXES: readonly { model: string; keys: IndexKeys }[] = [
  { model: "TimeEntry", keys: { authorId: 1 } },
  { model: "WorkspaceMember", keys: { workspaceId: 1, userId: 1 } },
  { model: "Invoice", keys: { workspaceId: 1, number: 1 } },
  { model: "ScheduledJob", keys: { name: 1 } },
  { model: "ApiToken", keys: { prefix: 1 } },
];

export const sameKeys = (a: IndexKeys, b: IndexKeys): boolean =>
  JSON.stringify(Object.entries(a)) === JSON.stringify(Object.entries(b));

export function isCritical(
  model: string,
  keys: IndexKeys,
  critical: readonly { model: string; keys: IndexKeys }[] = CRITICAL_INDEXES,
): boolean {
  return critical.some((entry) => entry.model === model && sameKeys(entry.keys, keys));
}

/** Build each declared index of each model, one at a time. */
export async function buildModelIndexes(
  models: readonly mongoose.Model<unknown>[],
  critical: readonly { model: string; keys: IndexKeys }[] = CRITICAL_INDEXES,
): Promise<IndexOutcome[]> {
  const outcomes: IndexOutcome[] = [];
  for (const model of models) {
    // Let the automatic build finish first, so two builds of one index do not
    // race. Its error is the first failure of the loop below, reported there.
    await model.init().catch(() => undefined);
    for (const index of model.schema.indexes()) {
      const [keys, options] = index as [IndexKeys, { unique?: boolean }];
      let error: string | null = null;
      try {
        // `toCreate` builds exactly this index, with mongoose's own option
        // handling (collation, TTL). `init()` above marked the model as caught,
        // so a failure rejects here instead of being emitted.
        const only: Record<string, unknown> = { toCreate: [index] };
        await model.ensureIndexes(only as CreateIndexesOptions);
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
      outcomes.push({
        model: model.modelName,
        collection: model.collection.collectionName,
        keys,
        unique: options.unique === true,
        critical: isCritical(model.modelName, keys, critical),
        error,
      });
    }
  }
  return outcomes;
}

export function describeIndex(outcome: Pick<IndexOutcome, "model" | "keys" | "unique">): string {
  return `${outcome.model} ${JSON.stringify(outcome.keys)}${outcome.unique ? " (unique)" : ""}`;
}

/** Log every failure. Returns the critical ones. */
export function reportIndexOutcomes(
  outcomes: readonly IndexOutcome[],
  logger: { warn: (message: string) => void; error: (message: string) => void },
): IndexOutcome[] {
  const fatal: IndexOutcome[] = [];
  for (const outcome of outcomes) {
    if (outcome.error === null) continue;
    if (outcome.critical) {
      fatal.push(outcome);
      logger.error(`[db] Index ${describeIndex(outcome)} could not be built: ${outcome.error}`);
    } else {
      logger.warn(
        `[db] Index ${describeIndex(outcome)} could not be built; queries still work, more slowly or without this guarantee: ${outcome.error}`,
      );
    }
  }
  return fatal;
}

/**
 * Which declared indexes exist, without building anything: `admin doctor`
 * must not write. An index counts as present when one with the same key
 * pattern and the same uniqueness exists; the name is not compared, since an
 * operator may have built one by hand.
 */
export async function inspectModelIndexes(
  db: import("mongodb").Db,
  models: readonly mongoose.Model<unknown>[],
  critical: readonly { model: string; keys: IndexKeys }[] = CRITICAL_INDEXES,
): Promise<IndexOutcome[]> {
  const outcomes: IndexOutcome[] = [];
  for (const model of models) {
    const collection = model.collection.collectionName;
    let existing: { key: IndexKeys; unique?: boolean }[] = [];
    try {
      existing = (await db.collection(collection).listIndexes().toArray()) as typeof existing;
    } catch (error) {
      // 26 NamespaceNotFound: a collection nothing has written to yet.
      if (!(typeof error === "object" && error !== null && (error as { code?: unknown }).code === 26)) {
        throw error;
      }
    }
    for (const [keys, options] of model.schema.indexes() as [IndexKeys, { unique?: boolean }][]) {
      const unique = options.unique === true;
      const present = existing.some(
        (index) => sameKeys(index.key, keys) && (index.unique === true) === unique,
      );
      outcomes.push({
        model: model.modelName,
        collection,
        keys,
        unique,
        critical: isCritical(model.modelName, keys, critical),
        error: present ? null : "missing",
      });
    }
  }
  return outcomes;
}
