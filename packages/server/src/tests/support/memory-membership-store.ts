// An in-memory `MembershipRowStore`, for driving membership operations without
// a database — the membership counterpart of `memory-row-store.ts`.
import assert from "node:assert/strict";
import type {
  MembershipCollection,
  MembershipRowStore,
  RowFilter,
  StoredRow,
} from "../../services/membership/store.js";
import { DuplicateRowError } from "../../services/membership/store.js";

type Row = Record<string, unknown>;

/** Equality, `null` (null or absent) and `$in` over strings — nothing else. */
function matches(filter: RowFilter, row: Readonly<Row>): boolean {
  assert.ok(Object.keys(filter).length > 0, "an empty filter matches everything");
  return Object.entries(filter).every(([key, expected]) => {
    const actual = row[key];
    if (expected === null) return actual === null || actual === undefined;
    if (typeof expected === "string") return actual === expected;
    assert.ok(Array.isArray(expected.$in), `unsupported operator on ${key}`);
    return typeof actual === "string" && expected.$in.includes(actual);
  });
}

export type MemoryMembershipStore = MembershipRowStore & {
  rows: Record<MembershipCollection, Row[]>;
  /** Make the n-th write (1-based; inserts, updates, deletes) throw. */
  failOnWrite: (n: number | null) => void;
  /** Writes made since the last `failOnWrite` call. */
  writes: () => number;
};

/**
 * `(workspaceId, userId)` is unique in the mirror and `(organizationId,
 * userId)` in `member`, as the real indexes make them — a racing second add
 * must fail the way Mongo fails it.
 */
const UNIQUE: Partial<Record<MembershipCollection, readonly string[]>> = {
  workspaceMembers: ["workspaceId", "userId"],
};

export function memoryMembershipStore(
  seed: Partial<Record<MembershipCollection, Row[]>> = {},
): MemoryMembershipStore {
  const rows: Record<MembershipCollection, Row[]> = {
    workspaceMembers: [],
    authMembers: [],
    authInvitations: [],
    authOrganizations: [],
    authUsers: [],
    authSessions: [],
  };
  for (const [name, list] of Object.entries(seed)) {
    rows[name as MembershipCollection] = list.map((row) => ({ ...row }));
  }
  let writes = 0;
  let failAt: number | null = null;
  let nextId = 1;

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
    writes: () => writes,
    async find(collection, filter) {
      return rows[collection]
        .filter((row) => matches(filter, row))
        .map((row) => ({ ...row }) as StoredRow);
    },
    async insertOne(collection, row) {
      tick();
      const keys = UNIQUE[collection];
      if (
        keys &&
        rows[collection].some((existing) => keys.every((key) => existing[key] === row[key]))
      ) {
        throw new DuplicateRowError(collection);
      }
      const stored = {
        ...row,
        id: typeof row.id === "string" ? row.id : `${collection}-${nextId++}`,
      };
      rows[collection].push(stored);
      return { ...stored };
    },
    async updateMany(collection, filter, set) {
      tick();
      let count = 0;
      for (const row of rows[collection]) {
        if (!matches(filter, row)) continue;
        Object.assign(row, set);
        count += 1;
      }
      return count;
    },
    async deleteMany(collection, filter) {
      tick();
      const before = rows[collection];
      const kept = before.filter((row) => !matches(filter, row));
      rows[collection] = kept;
      return before.length - kept.length;
    },
  };
}
