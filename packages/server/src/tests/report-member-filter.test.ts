// Filtering and grouping reports by member.
//
// A member filter is a request, and the author scope is a permission. The
// only safe relationship between the two is intersection: `memberIds` may
// narrow what a report covers and must never widen it. A member restricted to
// their own time who names a colleague has to get an empty report — not an
// error, which would confirm the colleague tracks time here, and certainly not
// the colleague's rows.
//
// Grouping by member has the same shape of risk one level up: a group label is
// a colleague's NAME. The labels come from the authors of rows the caller may
// already see, so a restricted member learns exactly one name — their own.
import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import mongoose, { Types } from "mongoose";
import type { Visibility } from "@starter/shared";
import {
  FORMER_MEMBER_LABEL,
  pushAuthorConditions,
  reportsRouter,
  resolveMemberLabels,
} from "../trpc/routers/reports.js";
import { matchesFilter, type Row } from "./support/in-memory-models.js";
import {
  ADMIN,
  MEMBER,
  OWNER,
  SECRET_RATE,
  contextFor,
  freshStore,
  installStore,
  resetStore,
} from "./support/shared-workspace.js";

const store = freshStore();
const restore = installStore(store);

// better-auth's `user` collection, read through the raw driver for live
// names. OLGA has renamed herself since joining; MIA's user record carries no
// name, so her membership mirror has to label her.
const users: { _id: Types.ObjectId; name?: string }[] = [
  { _id: new Types.ObjectId(OWNER), name: "Olga Renamed" },
  { _id: new Types.ObjectId(ADMIN), name: "Arno Admin" },
  { _id: new Types.ObjectId(MEMBER) },
];
const connection = mongoose.connection as unknown as { db: unknown };
const realDb = connection.db;
connection.db = {
  collection: (name: string) => {
    assert.equal(name, "user");
    return {
      find: (filter: { _id: { $in: Types.ObjectId[] } }) => ({
        toArray: async () =>
          users.filter((user) =>
            filter._id.$in.some((id) => id.equals(user._id)),
          ),
      }),
    };
  },
};

after(() => {
  restore();
  connection.db = realDb;
});
beforeEach(() => resetStore(store));

const RANGE = { from: "2026-09-01", to: "2026-09-30" };

/** An author who tracked time here and has since left the workspace. */
const FORMER = "64b7f9c2e13a4d5f6a7b8e99";

const addFormerMembersEntry = (): void => {
  const template = store.entries.rows[0];
  assert.ok(template);
  store.entries.rows.push({
    ...template,
    _id: new Types.ObjectId(),
    authorId: FORMER,
    description: "Work by a former member",
    start: new Date("2026-09-08T09:00:00.000Z"),
    end: new Date("2026-09-08T10:00:00.000Z"),
  });
};

const visibility = (
  userId: string,
  canViewOthersTime: boolean,
  canViewOthersMoney: boolean,
): Visibility => ({ userId, canViewOthersTime, canViewOthersMoney });

// ── the intersection, as a pure rule ─────────────────────────────────

describe("pushAuthorConditions — narrows, never widens", () => {
  const rows: Row[] = [OWNER, ADMIN, MEMBER].map((authorId) => ({ authorId }));
  const authorsMatched = (
    who: Visibility,
    memberIds: string[] | undefined,
  ): string[] => {
    const conditions: Row[] = [];
    pushAuthorConditions(conditions, who, memberIds);
    return rows
      .filter((row) => matchesFilter(row, { $and: [{}, ...conditions] }))
      .map((row) => String(row.authorId));
  };

  it("a closed member naming a colleague matches nothing", () => {
    assert.deepEqual(authorsMatched(visibility(MEMBER, false, false), [OWNER]), []);
  });

  it("a closed member naming everybody still matches only themselves", () => {
    assert.deepEqual(
      authorsMatched(visibility(MEMBER, false, false), [OWNER, ADMIN, MEMBER]),
      [MEMBER],
    );
  });

  it("a time-visible caller is narrowed to the named members", () => {
    assert.deepEqual(
      authorsMatched(visibility(ADMIN, true, false), [OWNER, MEMBER]),
      [OWNER, MEMBER],
    );
  });

  it("an empty or absent filter is no filter, not an empty report", () => {
    assert.deepEqual(authorsMatched(visibility(OWNER, true, true), []), [OWNER, ADMIN, MEMBER]);
    assert.deepEqual(authorsMatched(visibility(OWNER, true, true), undefined), [
      OWNER,
      ADMIN,
      MEMBER,
    ]);
    assert.deepEqual(authorsMatched(visibility(MEMBER, false, false), []), [MEMBER]);
  });

  it("keeps the scope and the request as two separate conditions", () => {
    // Folding both into one `$in` is how a filter comes to replace a scope.
    const conditions: Row[] = [];
    pushAuthorConditions(conditions, visibility(MEMBER, false, false), [OWNER]);
    assert.deepEqual(conditions, [
      { authorId: MEMBER },
      { authorId: { $in: [OWNER] } },
    ]);
  });
});

// ── through the router ───────────────────────────────────────────────

describe("reports with memberIds", () => {
  it("closed member filtering on the owner: every report is empty, no error", async () => {
    const caller = reportsRouter.createCaller(contextFor(MEMBER));
    const filter = { ...RANGE, memberIds: [OWNER] };

    const summary = await caller.summary({ ...filter, groupBy: "member" });
    assert.equal(summary.totalSec, 0);
    assert.deepEqual(summary.groups, []);
    assert.ok(summary.timeline.every((point) => point.seconds === 0));

    const detailed = await caller.detailed(filter);
    assert.deepEqual(detailed.entries, []);
    assert.equal(detailed.totalSec, 0);

    const weekly = await caller.weekly({ ...filter, weekStart: "2026-09-07" });
    assert.deepEqual(weekly.rows, []);
    assert.equal(weekly.totalSec, 0);

    const csv = await caller.exportCsv({ ...filter, report: "detailed" });
    assert.ok(!csv.csv.includes(`Work by ${OWNER}`));

    const span = await caller.trackedSpan({ memberIds: [OWNER] });
    assert.deepEqual(span, { from: null, to: null });
  });

  it("owner filtering on the admin sees only the admin's hour", async () => {
    const caller = reportsRouter.createCaller(contextFor(OWNER));
    const summary = await caller.summary({
      ...RANGE,
      groupBy: "project",
      memberIds: [ADMIN],
    });
    assert.equal(summary.totalSec, 3600);
    assert.equal(summary.totalAmount, SECRET_RATE);

    const detailed = await caller.detailed({ ...RANGE, memberIds: [ADMIN] });
    assert.deepEqual(
      detailed.entries.map((entry) => entry.authorId),
      [ADMIN],
    );
  });

  it("time-only admin filtering on two colleagues gets their time and no money", async () => {
    const summary = await reportsRouter
      .createCaller(contextFor(ADMIN))
      .summary({ ...RANGE, groupBy: "project", memberIds: [OWNER, MEMBER] });
    assert.equal(summary.totalSec, 7200);
    assert.equal(summary.totalAmount, null);
    assert.equal(summary.moneyVisible, false);
  });

  it("closed member's trackedSpan with no filter spans only their own history", async () => {
    await reportsRouter.createCaller(contextFor(MEMBER)).trackedSpan({});
    const [match] = store.entries.queries;
    assert.ok(match);
    const visible = store.entries.rows.filter((row) => matchesFilter(row, match));
    assert.deepEqual(
      visible.map((row) => row.authorId),
      [MEMBER],
    );
  });
});

describe("summary grouped by member", () => {
  it("owner: one group per author, labelled with live names, former members anonymised", async () => {
    addFormerMembersEntry();
    const summary = await reportsRouter
      .createCaller(contextFor(OWNER))
      .summary({ ...RANGE, groupBy: "member" });

    const labels = new Map(summary.groups.map((group) => [group.key, group.label]));
    assert.equal(summary.groups.length, 4);
    // The LIVE user record wins over the name mirrored at join time.
    assert.equal(labels.get(OWNER), "Olga Renamed");
    assert.equal(labels.get(ADMIN), "Arno Admin");
    // No live name: the membership mirror.
    assert.equal(labels.get(MEMBER), "Mia Member");
    assert.equal(labels.get(FORMER), FORMER_MEMBER_LABEL);
    for (const group of summary.groups) {
      assert.equal(group.seconds, 3600);
      assert.equal(group.amount, SECRET_RATE);
    }
    assert.equal(summary.totalSec, 14_400);
  });

  it("closed member: exactly one group — their own — and no colleague's name anywhere", async () => {
    const summary = await reportsRouter
      .createCaller(contextFor(MEMBER))
      .summary({ ...RANGE, groupBy: "member" });

    assert.deepEqual(
      summary.groups.map((group) => group.key),
      [MEMBER],
    );
    const serialized = JSON.stringify(summary);
    for (const name of ["Olga", "Arno"]) {
      assert.ok(!serialized.includes(name), `${name} leaked into a closed member's report`);
    }
    assert.ok(
      store.members.queries.every(
        (filter) =>
          // The label read is scoped to the matched authors (the membership
          // lookup for the caller's own context aside).
          filter.userId === MEMBER ||
          JSON.stringify(filter.userId) === JSON.stringify({ $in: [MEMBER] }),
      ),
      JSON.stringify(store.members.queries),
    );
  });

  it("time-only admin: every author's group, every amount withheld", async () => {
    const summary = await reportsRouter
      .createCaller(contextFor(ADMIN))
      .summary({ ...RANGE, groupBy: "member" });
    assert.equal(summary.groups.length, 3);
    assert.equal(summary.moneyVisible, false);
    assert.equal(summary.totalAmount, null);
    // Including the admin's own group: which groups are "safe" is itself a
    // statement about colleagues' work.
    for (const group of summary.groups) assert.equal(group.amount, null);
  });
});

describe("resolveMemberLabels — the fallback chain", () => {
  const memberships = new Map([
    ["a", { name: "Mirror A" }],
    ["b", { name: "Mirror B" }],
    ["c", { name: "  " }],
  ]);
  const live = new Map([
    ["a", "Live A"],
    ["b", "   "],
  ]);

  it("live name, then membership mirror, then a neutral label; no membership is a former member", () => {
    const labels = resolveMemberLabels(["a", "b", "c", "gone"], memberships, live);
    assert.equal(labels.get("a"), "Live A");
    assert.equal(labels.get("b"), "Mirror B");
    assert.equal(labels.get("c"), "Unnamed member");
    assert.equal(labels.get("gone"), FORMER_MEMBER_LABEL);
  });

  it("never publishes a departed person's live name", () => {
    const labels = resolveMemberLabels(["gone"], new Map(), new Map([["gone", "Real Name"]]));
    assert.equal(labels.get("gone"), FORMER_MEMBER_LABEL);
  });
});
