// The summary, the weekly grid and the detailed report's range totals fold
// the matching entries a page at a time rather than as one array of the whole
// range. The promise they make: the same report, to the second and the cent,
// as folding the whole range at once — which is what they did before.
//
// "At once" is spelled out below as `asOnePage`: the very same report with
// every page query's limit removed, so its first page is the whole range in
// the same order — exactly the one array the reports used to fold. The paged
// run must equal it for every grouping and every visibility in the shared
// workspace, on a fixture that crosses several page boundaries with ties on
// `start`, entries crossing midnight, a running entry, entries clipped by both
// ends of the range, tags fanned out, a former member and four spellings of
// three currencies.
import assert from "node:assert/strict";
import { after, beforeEach, describe, it, mock } from "node:test";
import mongoose, { Types } from "mongoose";
import type { ReportGroupBy } from "@starter/shared";
import {
  buildDetailed,
  buildSummary,
  buildWeekly,
  type ReportScope,
} from "../trpc/routers/reports.js";
import { TimeEntry } from "../models/TimeEntry.js";
import type { Row } from "./support/in-memory-models.js";
import {
  ADMIN,
  MEMBER,
  OWNER,
  WORKSPACE,
  freshStore,
  installStore,
  resetStore,
  type Person,
} from "./support/shared-workspace.js";

const store = freshStore();
const restore = installStore(store);

// Live names for the member grouping, as better-auth's `user` collection
// would answer them.
const users: { _id: Types.ObjectId; name?: string }[] = [
  { _id: new Types.ObjectId(OWNER), name: "Olga Owner" },
  { _id: new Types.ObjectId(ADMIN), name: "Arno Admin" },
];
const connection = mongoose.connection as unknown as { db: unknown };
const realDb = connection.db;
connection.db = {
  collection: () => ({
    find: (filter: { _id: { $in: Types.ObjectId[] } }) => ({
      toArray: async () =>
        users.filter((user) => filter._id.$in.some((id) => id.equals(user._id))),
    }),
  }),
};
after(() => {
  restore();
  connection.db = realDb;
});

const FROZEN_NOW = Date.parse("2026-09-20T12:00:00.000Z");
const FILTERS = { from: "2026-09-01", to: "2026-09-19", timeZone: "Europe/Berlin" };
const WEEK_START = "2026-09-14";

/** Somebody who tracked time here and has since left. */
const FORMER = "64b7f9c2e13a4d5f6a7b8e09";

const VISIBILITY: Record<Person, ReportScope["visibility"]> = {
  [OWNER]: { userId: OWNER, canViewOthersTime: true, canViewOthersMoney: true },
  [ADMIN]: { userId: ADMIN, canViewOthersTime: true, canViewOthersMoney: false },
  [MEMBER]: { userId: MEMBER, canViewOthersTime: false, canViewOthersMoney: false },
};
const scopeOf = (person: Person): ReportScope => ({
  workspaceId: WORKSPACE,
  visibility: VISIBILITY[person],
});
const PEOPLE = [
  [OWNER, "owner"],
  [ADMIN, "time-only admin"],
  [MEMBER, "member"],
] as const;

const GROUPINGS: readonly ReportGroupBy[] = [
  "project",
  "client",
  "task",
  "tag",
  "member",
  "day",
  "week",
  "month",
];

/** Deterministic ids, so a tie on `start` always breaks the same way. */
const oid = (prefix: string, n: number): Types.ObjectId =>
  new Types.ObjectId(prefix + n.toString(16).padStart(24 - prefix.length, "0"));

const catalog = (prefix: string, n: number, name: string, extra: Row = {}): Row => ({
  _id: oid(prefix, n),
  workspaceId: WORKSPACE,
  name,
  color: `#00${prefix}${n}0`.slice(0, 7),
  ...extra,
});

const CLIENT_A = catalog("c1", 1, "Acme GmbH");
const CLIENT_B = catalog("c1", 2, "Bergwerk AG");
const FOREIGN_CLIENT = catalog("c1", 3, "Somebody else's client", { workspaceId: "ws_other" });
const PROJECTS: readonly (Row | null)[] = [
  catalog("a1", 1, "Rebrand", { clientId: String(CLIENT_A._id) }),
  catalog("a1", 2, "Website", { clientId: String(CLIENT_B._id) }),
  catalog("a1", 3, "Internal", { clientId: null }),
  null,
  catalog("a1", 4, "Somebody else's project", {
    workspaceId: "ws_other",
    clientId: String(FOREIGN_CLIENT._id),
  }),
];
const TASKS: readonly (Row | null)[] = [
  catalog("b1", 1, "Design review"),
  catalog("b1", 2, "Invoicing"),
  null,
  catalog("b1", 3, "Somebody else's task", { workspaceId: "ws_other" }),
];
const TAG_DEEP = String(oid("d1", 1));
const TAG_ADMIN = String(oid("d1", 2));
const TAG_ARCHIVED = String(oid("d1", 3));
const TAG_UNKNOWN = String(oid("d1", 4));
const TAG_SETS = [
  [],
  [TAG_DEEP],
  [TAG_DEEP, TAG_ADMIN],
  [TAG_ADMIN, TAG_ADMIN],
  [TAG_UNKNOWN],
  [TAG_ARCHIVED, TAG_DEEP],
] as const;

const entry = (row: Row): void => {
  store.entries.rows.push({
    workspaceId: WORKSPACE,
    projectId: null,
    taskId: null,
    tagIds: [],
    billable: true,
    hourlyRate: 120,
    currency: "EUR",
    source: "web",
    timeZone: "UTC",
    runaway: null,
    invoiceId: null,
    importId: null,
    ...row,
    createdAt: row.start,
    updatedAt: row.start,
  });
};

/**
 * `count` entries, newest first, four minutes apart in pairs that share a
 * start (the keyset's `_id` tiebreak), beginning half an hour before
 * midnight in Berlin so the first ones cross into the next day.
 */
const addFoldRows = (count: number, idPrefix = "e1", onlyAuthor?: Person): void => {
  const base = Date.parse("2026-09-18T21:30:00.000Z");
  for (let n = 0; n < count; n += 1) {
    const author = onlyAuthor ?? (n % 13 === 0 ? FORMER : [OWNER, ADMIN, MEMBER][n % 3]!);
    const start = new Date(base - Math.floor(n / 2) * 240_000);
    const seconds = n % 97 === 0 ? 3 * 3600 + 17 : 600 + (n % 11) * 420;
    // Joined by the report from the catalog rows below: a project's client
    // comes from the project, and a row without one may name a client itself.
    const project = PROJECTS[n % PROJECTS.length] ?? null;
    const ownClient = project === null && n % 2 === 1 ? { clientId: String(CLIENT_B._id) } : {};
    const task = TASKS[n % TASKS.length] ?? null;
    entry({
      _id: oid(idPrefix, n),
      authorId: author,
      description: `Row ${n}`,
      projectId: project ? String(project._id) : null,
      taskId: task ? String(task._id) : null,
      tagIds: [...TAG_SETS[n % TAG_SETS.length]!],
      billable: n % 4 !== 0,
      start,
      end: new Date(start.getTime() + seconds * 1000),
      // A stored duration of 0 is measured from the timestamps; one a second
      // off them is kept, and the day slices are reconciled to it.
      durationSec: n % 53 === 0 ? 0 : n % 29 === 0 ? seconds + 1 : seconds,
      hourlyRate: n % 17 === 0 ? null : 80 + (n % 3) * 7.5 + (n % 7) * 0.33,
      currency: n % 41 === 0 ? "usd" : n % 59 === 0 ? "CHF" : n % 2 === 1 ? "EUR" : "eur",
      ...ownClient,
    });
  }
};

const addEdgeRows = (): void => {
  // Still running, inside the range: measured to `now`.
  entry({
    _id: oid("f1", 1),
    authorId: OWNER,
    start: new Date("2026-09-18T20:00:00.000Z"),
    end: null,
    durationSec: 0,
    tagIds: [TAG_DEEP],
  });
  // Straddles the range's start.
  entry({
    _id: oid("f1", 2),
    authorId: ADMIN,
    start: new Date("2026-08-31T20:00:00.000Z"),
    end: new Date("2026-09-01T02:00:00.000Z"),
    durationSec: 21_600,
  });
  // Straddles the range's end, wherever the host's midnight falls.
  entry({
    _id: oid("f1", 3),
    authorId: MEMBER,
    start: new Date("2026-09-19T19:00:00.000Z"),
    end: new Date("2026-09-20T05:00:00.000Z"),
    durationSec: 36_000,
    currency: "usd",
  });
  // Entirely before the range.
  entry({
    _id: oid("f1", 4),
    authorId: OWNER,
    start: new Date("2026-08-10T09:00:00.000Z"),
    end: new Date("2026-08-10T10:00:00.000Z"),
    durationSec: 3600,
  });
};

beforeEach(() => {
  resetStore(store);
  store.clients.rows.push(CLIENT_A, CLIENT_B, FOREIGN_CLIENT);
  store.projects.rows.push(...PROJECTS.filter((project): project is Row => project !== null));
  store.tasks.rows.push(...TASKS.filter((task): task is Row => task !== null));
  store.tags.rows.push(
    { _id: oid("d1", 1), workspaceId: WORKSPACE, name: "deep work", color: "#111111", archived: false },
    { _id: oid("d1", 2), workspaceId: WORKSPACE, name: "admin", color: "#222222", archived: false },
    { _id: oid("d1", 3), workspaceId: WORKSPACE, name: "old label", color: "#333333", archived: true },
  );
  // 3,600 rows: four joined pages for the owner, and more than one even for
  // the member who sees only their own third of them.
  addFoldRows(3_600);
  addEdgeRows();
});

/**
 * Run `body` with every page query's limit removed: the first page is then
 * the whole range, in order, and the fold sees it as the one array it used to.
 */
const asOnePage = async <T>(body: () => Promise<T>): Promise<T> => {
  const model = TimeEntry as unknown as Record<string, unknown>;
  const aggregate = model.aggregate as (pipeline: Row[]) => Promise<Row[]>;
  const find = model.find as (filter?: Row) => { limit: (count: number) => unknown };
  model.aggregate = (pipeline: Row[]) =>
    aggregate(pipeline.filter((stage) => !("$limit" in stage)));
  model.find = (filter?: Row) => {
    const query = find(filter);
    query.limit = () => query;
    return query;
  };
  try {
    return await body();
  } finally {
    model.aggregate = aggregate;
    model.find = find;
  }
};

/** Run `body` with `Date` frozen, so a running entry measures the same twice. */
const frozen = async <T>(body: () => Promise<T>): Promise<T> => {
  mock.timers.enable({ apis: ["Date"], now: FROZEN_NOW });
  try {
    return await body();
  } finally {
    mock.timers.reset();
  }
};

/** How many page queries `body` sent the entries collection. */
const pageQueries = async <T>(body: () => Promise<T>): Promise<[T, number]> => {
  const before = store.entries.queries.length;
  const result = await body();
  return [result, store.entries.queries.length - before];
};

describe("buildSummary — paged equals the whole range at once", () => {
  for (const [person, who] of PEOPLE) {
    for (const groupBy of GROUPINGS) {
      it(`${groupBy}, ${who}`, async () => {
        await frozen(async () => {
          const [paged, pages] = await pageQueries(() =>
            buildSummary(scopeOf(person), FILTERS, groupBy),
          );
          const whole = await asOnePage(() => buildSummary(scopeOf(person), FILTERS, groupBy));
          assert.ok(pages >= 2, `the fixture crossed no page boundary (${pages} page)`);
          assert.ok(paged.totalSec > 0 && paged.groups.length > 0);
          assert.deepEqual(paged, whole);
        });
      });
    }
  }

  it("the owner's report really holds what the fixture is about", async () => {
    await frozen(async () => {
      const tags = await buildSummary(scopeOf(OWNER), FILTERS, "tag");
      const tagSum = tags.groups.reduce((total, group) => total + group.seconds, 0);
      assert.ok(tagSum > tags.totalSec, "the tag fan-out over-sums the groups");
      assert.ok((tags.totalAmounts?.length ?? 0) >= 3, "several currencies");
      const members = await buildSummary(scopeOf(OWNER), FILTERS, "member");
      assert.deepEqual(
        members.groups.map((group) => group.label).sort(),
        ["Arno Admin", "Former member", "Mia Member", "Olga Owner"],
      );
    });
  });
});

describe("buildWeekly — paged equals the whole week at once", () => {
  for (const [person, who] of PEOPLE) {
    it(who, async () => {
      await frozen(async () => {
        const [paged, pages] = await pageQueries(() =>
          buildWeekly(scopeOf(person), FILTERS, WEEK_START),
        );
        const whole = await asOnePage(() => buildWeekly(scopeOf(person), FILTERS, WEEK_START));
        assert.ok(pages >= 2, `the fixture crossed no page boundary (${pages} page)`);
        assert.ok(paged.totalSec > 0 && paged.rows.length > 1);
        assert.deepEqual(paged, whole);
      });
    });
  }
});

describe("buildDetailed — range totals paged equal the whole range at once", () => {
  for (const [person, who] of PEOPLE) {
    it(who, async () => {
      // Totals read six fields, so their pages are larger: enough rows for
      // two of them even for the member, whose own rows are fewer — and
      // more ties on `start`, since these share the first rows' starts.
      addFoldRows(8_000, "e2");
      addFoldRows(3_000, "e3", MEMBER);
      await frozen(async () => {
        const [paged, pages] = await pageQueries(() =>
          buildDetailed(scopeOf(person), FILTERS, { limit: 50 }),
        );
        const whole = await asOnePage(() =>
          buildDetailed(scopeOf(person), FILTERS, { limit: 50 }),
        );
        // One query is the page of rows; the rest are the totals pass.
        assert.ok(pages >= 3, `the totals crossed no page boundary (${pages} queries)`);
        assert.equal(paged.entries.length, 50);
        assert.deepEqual(paged, whole);
        // And they agree with the summary, which folds the same clip rule.
        const summary = await buildSummary(scopeOf(person), FILTERS, "project");
        assert.equal(paged.totalSec, summary.totalSec);
        assert.deepEqual(paged.totalAmounts, summary.totalAmounts);
      });
    });
  }
});

