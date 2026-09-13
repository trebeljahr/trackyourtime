// An in-memory `DeletionRowStore`, for driving the account-deletion cascade
// without a database.
import assert from "node:assert/strict";
import type {
  DeletionRowStore,
  StoredRow,
} from "../../services/account-deletion/delete-account.js";
import type {
  DeletionCollection,
  DeletionFilter,
} from "../../services/account-deletion/plan.js";

type Row = Record<string, unknown>;

/**
 * Mongo's matching rules, for exactly the shapes the cascade builds: scalar
 * equality, `null` (which also matches an absent field — an entry written
 * before `invoiceId` existed is not invoiced) and `$in` over strings.
 * Anything richer fails the test rather than being quietly approximated.
 */
export function matches(filter: DeletionFilter, row: Readonly<Row>): boolean {
  assert.ok(Object.keys(filter).length > 0, "an empty filter matches everything");
  return Object.entries(filter).every(([key, expected]) => {
    const actual = row[key];
    if (expected === null) return actual === null || actual === undefined;
    if (typeof expected === "string") return actual === expected;
    assert.ok(Array.isArray(expected.$in), `unsupported operator on ${key}`);
    return typeof actual === "string" && expected.$in.includes(actual);
  });
}

export type MemoryRowStore = DeletionRowStore & {
  rows: Partial<Record<DeletionCollection, Row[]>>;
  /** Make the n-th write (1-based, updates and deletes counted together) throw. */
  failOnWrite: (n: number | null) => void;
};

export function memoryRowStore(
  seed: Partial<Record<DeletionCollection, Row[]>> = {},
): MemoryRowStore {
  const rows: Partial<Record<DeletionCollection, Row[]>> = {};
  for (const [name, list] of Object.entries(seed)) {
    rows[name as DeletionCollection] = list.map((row) => ({ ...row }));
  }
  let writes = 0;
  let failAt: number | null = null;

  const tick = (): void => {
    writes += 1;
    if (failAt !== null && writes === failAt) {
      throw new Error(`simulated failure on write ${writes}`);
    }
  };

  return {
    rows,
    failOnWrite(n) {
      failAt = n;
      writes = 0;
    },
    async find(collection, filter) {
      return (rows[collection] ?? [])
        .filter((row) => matches(filter, row))
        .map((row) => ({ ...row }) as StoredRow);
    },
    async updateMany(collection, filter, set) {
      tick();
      let count = 0;
      for (const row of rows[collection] ?? []) {
        if (!matches(filter, row)) continue;
        Object.assign(row, set);
        count += 1;
      }
      return count;
    },
    async deleteMany(collection, filter) {
      tick();
      const before = rows[collection] ?? [];
      const kept = before.filter((row) => !matches(filter, row));
      rows[collection] = kept;
      return before.length - kept.length;
    },
  };
}
