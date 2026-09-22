// An in-memory stand-in for the handful of Mongoose model methods the
// visibility tests drive routers and services through.
//
// The unit suite has no database, and the leaks these tests guard against live
// in the FILTERS a resolver builds — which author scope it pushes, whether a
// gate runs before the query. Stubbing a model with canned answers would test
// the stub; evaluating the resolver's real filter against real-shaped rows
// tests the resolver. So this implements the subset of the query language the
// routers under test actually use — `$and`, `$or`, `$in`, `$nin`, `$ne`,
// `$lt(e)`, `$gt(e)`, `$exists`, RegExp and equality, with Mongo's "a scalar
// condition matches any element of an array field" rule — and nothing more.
// An operator it does not know FAILS the test rather than matching silently.
//
// Aggregations run `$match`, `$sort`, `$limit`, `$skip` and a whole-set
// `$group` (`_id: null` with `$min`/`$max`/`$sum`); every other stage
// (lookups, projections) is ignored, so fixture rows carry whatever joined
// fields the code under test reads.
import { Types } from "mongoose";

export type Row = Record<string, unknown>;

const isObjectIdLike = (value: unknown): value is { toHexString: () => string } =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { toHexString?: unknown }).toHexString === "function";

/** A value reduced to something `===` and `<` can compare. */
const normalize = (value: unknown): unknown => {
  if (value instanceof Date) return value.getTime();
  if (isObjectIdLike(value)) return value.toHexString();
  return value === undefined ? null : value;
};

const readPath = (row: Row, path: string): unknown => {
  let current: unknown = row;
  for (const key of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Row)[key];
  }
  return current;
};

const scalarEquals = (actual: unknown, expected: unknown): boolean =>
  normalize(actual) === normalize(expected);

/** Mongo equality: an array field matches when any element does. */
const fieldEquals = (actual: unknown, expected: unknown): boolean =>
  Array.isArray(actual) && !Array.isArray(expected)
    ? actual.some((item) => scalarEquals(item, expected))
    : scalarEquals(actual, expected);

const compare = (
  actual: unknown,
  expected: unknown,
  test: (a: number | string, b: number | string) => boolean,
): boolean => {
  const a = normalize(actual);
  const b = normalize(expected);
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  return test(a as number | string, b as number | string);
};

const isOperatorObject = (value: unknown): value is Row =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof Date) &&
  !(value instanceof RegExp) &&
  !isObjectIdLike(value) &&
  Object.keys(value).length > 0 &&
  Object.keys(value).every((key) => key.startsWith("$"));

const matchesCondition = (actual: unknown, condition: unknown): boolean => {
  if (condition instanceof RegExp) {
    return typeof actual === "string" && condition.test(actual);
  }
  if (!isOperatorObject(condition)) return fieldEquals(actual, condition);

  return Object.entries(condition).every(([operator, operand]) => {
    switch (operator) {
      case "$in":
        return (operand as unknown[]).some((item) => fieldEquals(actual, item));
      case "$nin":
        return !(operand as unknown[]).some((item) => fieldEquals(actual, item));
      case "$ne":
        return !fieldEquals(actual, operand);
      case "$lt":
        return compare(actual, operand, (a, b) => a < b);
      case "$lte":
        return compare(actual, operand, (a, b) => a <= b);
      case "$gt":
        return compare(actual, operand, (a, b) => a > b);
      case "$gte":
        return compare(actual, operand, (a, b) => a >= b);
      case "$exists":
        return (actual !== undefined) === Boolean(operand);
      default:
        throw new Error(`in-memory-models: unsupported operator ${operator}`);
    }
  });
};

/** Whether `row` satisfies a Mongo filter (the subset described above). */
export const matchesFilter = (row: Row, filter: Row): boolean =>
  Object.entries(filter).every(([key, condition]) => {
    if (key === "$and") {
      return (condition as Row[]).every((part) => matchesFilter(row, part));
    }
    if (key === "$or") {
      return (condition as Row[]).some((part) => matchesFilter(row, part));
    }
    if (key.startsWith("$")) {
      throw new Error(`in-memory-models: unsupported top-level ${key}`);
    }
    return matchesCondition(readPath(row, key), condition);
  });

const sortRows = (rows: Row[], spec: unknown): Row[] => {
  if (typeof spec !== "object" || spec === null) return rows;
  const keys = Object.entries(spec as Record<string, number>);
  return [...rows].sort((left, right) => {
    for (const [key, direction] of keys) {
      const a = normalize(readPath(left, key));
      const b = normalize(readPath(right, key));
      if (a === b) continue;
      if (a === null) return -direction;
      if (b === null) return direction;
      return (a as number) < (b as number) ? -direction : direction;
    }
    return 0;
  });
};

/** A chainable query that resolves on `lean()`, `exec()` or `await`. */
class MemoryQuery<T> implements PromiseLike<T> {
  private sortSpec: unknown = null;
  private limitCount: number | null = null;
  private skipCount = 0;

  constructor(
    private readonly rows: () => Row[],
    private readonly shape: (rows: Row[]) => T,
  ) {}

  sort(spec: unknown): this {
    this.sortSpec = spec;
    return this;
  }
  limit(count: number): this {
    this.limitCount = count;
    return this;
  }
  skip(count: number): this {
    this.skipCount = count;
    return this;
  }
  select(): this {
    return this;
  }
  populate(): this {
    return this;
  }
  session(): this {
    return this;
  }
  lean(): Promise<T> {
    return this.exec();
  }
  async exec(): Promise<T> {
    let rows = sortRows(this.rows(), this.sortSpec);
    rows = rows.slice(this.skipCount);
    if (this.limitCount !== null) rows = rows.slice(0, this.limitCount);
    return this.shape(rows);
  }
  then<R1 = T, R2 = never>(
    onFulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return this.exec().then(onFulfilled, onRejected);
  }
}

/** `$group` with `_id: null` — one output row, or none for no input. */
const groupWholeSet = (rows: Row[], spec: Row): Row[] => {
  if (spec._id !== null) {
    throw new Error("in-memory-models: only `$group` with `_id: null` is supported");
  }
  if (rows.length === 0) return [];
  const result: Row = { _id: null };
  for (const [key, accumulator] of Object.entries(spec)) {
    if (key === "_id") continue;
    const [[operator, operand]] = Object.entries(accumulator as Row) as [
      [string, unknown],
    ];
    const values = rows
      .map((row) =>
        typeof operand === "string" && operand.startsWith("$")
          ? readPath(row, operand.slice(1))
          : operand,
      )
      .filter((value) => value !== null && value !== undefined);
    const pick = (better: (a: unknown, b: unknown) => boolean): unknown =>
      values.reduce<unknown>(
        (best, value) => (best === null || better(value, best) ? value : best),
        null,
      );
    switch (operator) {
      case "$min":
        result[key] = pick((a, b) => (normalize(a) as number) < (normalize(b) as number));
        break;
      case "$max":
        result[key] = pick((a, b) => (normalize(a) as number) > (normalize(b) as number));
        break;
      case "$sum":
        result[key] = values.reduce<number>((sum, value) => sum + Number(value), 0);
        break;
      default:
        throw new Error(`in-memory-models: unsupported accumulator ${operator}`);
    }
  }
  return [result];
};

const applySet = (row: Row, update: Row): void => {
  const set = update.$set;
  if (typeof set === "object" && set !== null) Object.assign(row, set);
  const unset = update.$unset;
  if (typeof unset === "object" && unset !== null) {
    for (const key of Object.keys(unset)) delete row[key];
  }
};

/** One collection's rows, plus a record of every filter it was queried with. */
export type MemoryCollection = {
  rows: Row[];
  queries: Row[];
};

export const memoryCollection = (rows: Row[] = []): MemoryCollection => ({
  rows,
  queries: [],
});

type AnyModel = object;

/**
 * Point a model's read and write methods at an in-memory collection.
 * Returns the function that puts the real methods back.
 */
export const stubModel = (
  model: AnyModel,
  collection: MemoryCollection,
): (() => void) => {
  const handle = model as Record<string, unknown>;
  const names = [
    "find",
    "findOne",
    "countDocuments",
    "aggregate",
    "updateMany",
    "updateOne",
    "deleteOne",
    "deleteMany",
    "findOneAndUpdate",
    "create",
  ] as const;
  const originals = new Map(names.map((name) => [name, handle[name]]));

  const matching = (filter: Row = {}): Row[] => {
    collection.queries.push(filter);
    return collection.rows.filter((row) => matchesFilter(row, filter));
  };

  handle.find = (filter?: Row) =>
    new MemoryQuery(() => matching(filter), (rows) => rows);
  handle.findOne = (filter?: Row) =>
    new MemoryQuery(() => matching(filter), (rows) => rows[0] ?? null);
  handle.countDocuments = (filter?: Row) =>
    new MemoryQuery(() => matching(filter), (rows) => rows.length);
  handle.aggregate = async (pipeline: Row[]) => {
    let rows = collection.rows;
    for (const stage of pipeline) {
      if ("$match" in stage) {
        const filter = stage.$match as Row;
        collection.queries.push(filter);
        rows = rows.filter((row) => matchesFilter(row, filter));
      } else if ("$sort" in stage) {
        rows = sortRows(rows, stage.$sort);
      } else if ("$limit" in stage) {
        rows = rows.slice(0, stage.$limit as number);
      } else if ("$skip" in stage) {
        rows = rows.slice(stage.$skip as number);
      } else if ("$group" in stage) {
        rows = groupWholeSet(rows, stage.$group as Row);
      }
    }
    return rows.map((row) => ({ ...row }));
  };
  handle.updateMany = async (filter: Row, update: Row) => {
    const rows = matching(filter);
    for (const row of rows) applySet(row, update);
    return { matchedCount: rows.length, modifiedCount: rows.length };
  };
  handle.updateOne = async (filter: Row, update: Row) => {
    const [row] = matching(filter);
    if (row) applySet(row, update);
    return { matchedCount: row ? 1 : 0, modifiedCount: row ? 1 : 0 };
  };
  handle.findOneAndUpdate = (filter: Row, update: Row) =>
    new MemoryQuery(
      () => matching(filter),
      (rows) => {
        const [row] = rows;
        if (row) applySet(row, update);
        return row ?? null;
      },
    );
  const remove = async (filter: Row, many: boolean) => {
    const rows = matching(filter);
    const doomed = new Set(many ? rows : rows.slice(0, 1));
    collection.rows.splice(
      0,
      collection.rows.length,
      ...collection.rows.filter((row) => !doomed.has(row)),
    );
    return { deletedCount: doomed.size };
  };
  handle.deleteOne = (filter: Row) => remove(filter, false);
  handle.deleteMany = (filter: Row) => remove(filter, true);
  handle.create = async (doc: Row) => {
    const now = new Date();
    const row: Row = {
      _id: new Types.ObjectId(),
      createdAt: now,
      updatedAt: now,
      ...doc,
    };
    collection.rows.push(row);
    return row;
  };

  return () => {
    for (const [name, original] of originals) handle[name] = original;
  };
};
