import assert from "node:assert/strict";
import test from "node:test";
// Subpath import: a bare named import from "@starter/shared" throws under tsx.
// See the note in duration.test.ts.
import {
  createEntrySchema,
  createTagSchema,
  entryListSchema,
  reportFiltersSchema,
  reportGroupBySchema,
  startTimerSchema,
  tagListSchema,
  updateEntrySchema,
  updateTagSchema,
} from "@starter/shared/schemas";
import { normalizeTagIds } from "../trpc/routers/entries.js";
import {
  NO_TAG,
  accumulateGroups,
  sortGroups,
  tagGroupIdentities,
  type GroupAccumulator,
  type TagLabel,
} from "../trpc/routers/reports.js";

/** `true` when the value passes the schema. */
const accepts = (
  schema: { safeParse: (value: unknown) => { success: boolean } },
  value: unknown,
): boolean => schema.safeParse(value).success;

/** 24 hex characters — the only shape an id may have. */
const oid = (suffix: string): string =>
  `507f1f77bcf86cd7994${suffix.padStart(5, "0")}`;

const DEEP_WORK = oid("1");
const ADMIN = oid("2");
const RESEARCH = oid("3");

// ── tag schemas ──────────────────────────────────────────────────────

test("createTagSchema takes a name, and a color only when it is real hex", () => {
  assert.ok(accepts(createTagSchema, { name: "deep work" }));
  assert.ok(accepts(createTagSchema, { name: "deep work", color: "#8b5cf6" }));
  assert.ok(
    accepts(createTagSchema, { name: "deep work", originId: "tab-1" }),
    "originId rides along so the originating tab can skip its own echo",
  );

  assert.ok(!accepts(createTagSchema, {}), "a nameless tag labels nothing");
  assert.ok(!accepts(createTagSchema, { name: "" }));
  assert.ok(!accepts(createTagSchema, { name: "x".repeat(61) }));
  assert.ok(!accepts(createTagSchema, { name: "ok", color: "8b5cf6" }));
  assert.ok(!accepts(createTagSchema, { name: "ok", color: "violet" }));
});

test("updateTagSchema is a patch — id required, everything else optional", () => {
  assert.ok(accepts(updateTagSchema, { id: DEEP_WORK }));
  assert.ok(accepts(updateTagSchema, { id: DEEP_WORK, name: "focus" }));
  assert.ok(accepts(updateTagSchema, { id: DEEP_WORK, archived: true }));
  assert.ok(accepts(updateTagSchema, { id: DEEP_WORK, color: "#ef4444" }));

  assert.ok(!accepts(updateTagSchema, { name: "focus" }), "id is required");
  assert.ok(!accepts(updateTagSchema, { id: "" }));
  assert.ok(!accepts(updateTagSchema, { id: DEEP_WORK, name: "" }));
  assert.ok(!accepts(updateTagSchema, { id: DEEP_WORK, archived: "yes" }));
});

test("tagListSchema only ever asks about archived tags", () => {
  assert.ok(accepts(tagListSchema, {}));
  assert.ok(accepts(tagListSchema, { includeArchived: true }));
  assert.ok(!accepts(tagListSchema, { includeArchived: "true" }));
});

test("reportGroupBySchema accepts tag alongside the partitioning groupings", () => {
  assert.ok(accepts(reportGroupBySchema, "tag"));
  assert.ok(accepts(reportGroupBySchema, "project"));
  assert.ok(!accepts(reportGroupBySchema, "tags"));
});

// ── tagIds on the entry schemas ──────────────────────────────────────

test("the entry schemas accept tagIds and cap the array at 20", () => {
  const twenty = Array.from({ length: 20 }, (_, index) => oid(String(index)));
  const twentyOne = [...twenty, oid("99")];

  assert.ok(accepts(startTimerSchema, { tagIds: [DEEP_WORK] }));
  assert.ok(accepts(startTimerSchema, { tagIds: twenty }));
  assert.ok(!accepts(startTimerSchema, { tagIds: twentyOne }));
  assert.ok(!accepts(startTimerSchema, { tagIds: [""] }));
  assert.ok(!accepts(startTimerSchema, { tagIds: "deep-work" }));

  const window = {
    start: "2026-08-21T09:00:00Z",
    end: "2026-08-21T10:00:00Z",
  };
  assert.ok(accepts(createEntrySchema, { ...window, tagIds: [DEEP_WORK] }));
  assert.ok(!accepts(createEntrySchema, { ...window, tagIds: twentyOne }));

  assert.ok(accepts(updateEntrySchema, { id: DEEP_WORK, tagIds: [] }));
  assert.ok(!accepts(updateEntrySchema, { id: DEEP_WORK, tagIds: twentyOne }));
});

test("tagIds is a filter on the list and report inputs, capped the same way", () => {
  const range = { from: "2026-08-01", to: "2026-08-31" };
  const twentyOne = Array.from({ length: 21 }, (_, index) =>
    oid(String(index)),
  );

  assert.ok(accepts(entryListSchema, range), "absent means no tag filter");
  assert.ok(accepts(entryListSchema, { ...range, tagIds: [] }));
  assert.ok(accepts(entryListSchema, { ...range, tagIds: [DEEP_WORK, ADMIN] }));
  assert.ok(!accepts(entryListSchema, { ...range, tagIds: twentyOne }));

  assert.ok(accepts(reportFiltersSchema, { ...range, tagIds: [DEEP_WORK] }));
  assert.ok(!accepts(reportFiltersSchema, { ...range, tagIds: twentyOne }));
});

// ── normalizeTagIds ──────────────────────────────────────────────────

test("normalizeTagIds keeps undefined and [] apart", () => {
  assert.equal(
    normalizeTagIds(undefined),
    undefined,
    "undefined means 'leave the entry's tags alone'",
  );
  assert.deepEqual(
    normalizeTagIds([]),
    [],
    "[] means 'this entry now has no tags'",
  );
});

test("normalizeTagIds dedupes and keeps the order the user picked", () => {
  assert.deepEqual(normalizeTagIds([DEEP_WORK, ADMIN, DEEP_WORK]), [
    DEEP_WORK,
    ADMIN,
  ]);
  assert.deepEqual(
    normalizeTagIds([RESEARCH, ADMIN, DEEP_WORK]),
    [RESEARCH, ADMIN, DEEP_WORK],
    "first occurrence wins, so the picked order survives",
  );
});

test("normalizeTagIds counts the cap AFTER deduping", () => {
  const twentyOne = Array.from({ length: 21 }, (_, index) => oid(String(index)));
  assert.throws(() => normalizeTagIds(twentyOne), /at most 20 tags/);

  // Thirty ids, three distinct: the write is small, so it is allowed.
  const repeated = Array.from({ length: 30 }, (_, index) =>
    [DEEP_WORK, ADMIN, RESEARCH][index % 3] ?? DEEP_WORK,
  );
  assert.deepEqual(normalizeTagIds(repeated), [DEEP_WORK, ADMIN, RESEARCH]);
});

test("normalizeTagIds rejects anything that cannot address a tag", () => {
  assert.throws(() => normalizeTagIds(["not-an-id"]), /Unknown tag/);
  assert.throws(() => normalizeTagIds([DEEP_WORK, "../etc/passwd"]), /Unknown tag/);
  assert.throws(
    () => normalizeTagIds(["507f1f77bcf86cd79943901"]),
    /Unknown tag/,
    "23 hex characters is not an ObjectId",
  );
});

// ── tag grouping fan-out ─────────────────────────────────────────────

const TAGS: ReadonlyMap<string, TagLabel> = new Map<string, TagLabel>([
  [DEEP_WORK, { name: "deep work", color: "#8b5cf6" }],
  [ADMIN, { name: "admin", color: "#64748b" }],
  [RESEARCH, { name: "research", color: "#0ea5e9" }],
]);

test("an untagged entry lands in the single No tag bucket", () => {
  assert.deepEqual(tagGroupIdentities([], TAGS), [NO_TAG]);
  assert.deepEqual(tagGroupIdentities(undefined, TAGS), [NO_TAG]);
  assert.equal(NO_TAG.key, "none", "same key the other groupings use");
});

test("a tagged entry produces one identity per tag it carries", () => {
  assert.deepEqual(tagGroupIdentities([DEEP_WORK, ADMIN], TAGS), [
    { key: DEEP_WORK, label: "deep work", color: "#8b5cf6" },
    { key: ADMIN, label: "admin", color: "#64748b" },
  ]);
});

test("a dangling tag id is dropped, never rendered as a blank group", () => {
  assert.deepEqual(tagGroupIdentities([DEEP_WORK, oid("99")], TAGS), [
    { key: DEEP_WORK, label: "deep work", color: "#8b5cf6" },
  ]);
  assert.deepEqual(
    tagGroupIdentities([oid("99")], TAGS),
    [NO_TAG],
    "an entry whose only tag is gone reads as untagged",
  );
  assert.deepEqual(
    tagGroupIdentities([DEEP_WORK, DEEP_WORK], TAGS),
    [{ key: DEEP_WORK, label: "deep work", color: "#8b5cf6" }],
    "a duplicated id must not count the entry twice in one group",
  );
});

test("the tag fan-out over-sums the groups on purpose, never the total", () => {
  // Two entries: one carrying two tags, one untagged.
  const entries = [
    { tagIds: [DEEP_WORK, ADMIN], seconds: 7200, billableSec: 7200, amount: 180, currency: "EUR" },
    { tagIds: [], seconds: 1800, billableSec: 0, amount: 0, currency: "EUR" },
  ];

  const groups = new Map<string, GroupAccumulator>();
  let totalSec = 0;
  let billableSec = 0;

  for (const entry of entries) {
    // The totals are accumulated ONCE per entry, outside the fan-out.
    totalSec += entry.seconds;
    billableSec += entry.billableSec;
    accumulateGroups(groups, tagGroupIdentities(entry.tagIds, TAGS), entry);
  }

  assert.equal(totalSec, 9000, "the report total is the real, once-counted sum");
  assert.equal(billableSec, 7200);

  const sorted = sortGroups(groups.values());
  assert.deepEqual(
    sorted.map((group) => [group.label, group.seconds]),
    [
      ["deep work", 7200],
      ["admin", 7200],
      ["No tag", 1800],
    ],
    "the two-hour entry contributes its FULL two hours to both of its tags",
  );

  const summed = sorted.reduce((total, group) => total + group.seconds, 0);
  assert.equal(summed, 16200);
  assert.ok(
    summed > totalSec,
    "group seconds exceeding the total is the documented tag semantics",
  );

  // Money fans out the same way, from the per-entry snapshot.
  assert.deepEqual(
    sorted.map((group) => group.amount),
    [180, 180, 0],
  );
});

test("sortGroups puts the biggest group first and breaks ties by key", () => {
  const groups = new Map<string, GroupAccumulator>();
  accumulateGroups(groups, tagGroupIdentities([ADMIN], TAGS), {
    seconds: 600,
    billableSec: 0,
    amount: 0,
    currency: "EUR",
  });
  accumulateGroups(groups, tagGroupIdentities([RESEARCH], TAGS), {
    seconds: 600,
    billableSec: 0,
    amount: 0,
    currency: "EUR",
  });
  accumulateGroups(groups, tagGroupIdentities([DEEP_WORK], TAGS), {
    seconds: 3600,
    billableSec: 0,
    amount: 0,
    currency: "EUR",
  });

  assert.deepEqual(
    sortGroups(groups.values()).map((group) => group.key),
    [DEEP_WORK, ADMIN, RESEARCH],
    "3600 first; the two 600s tie and fall back to the id order",
  );
});

test("accumulateGroups is a plain accumulate for the partitioning groupings", () => {
  const groups = new Map<string, GroupAccumulator>();
  const project = { key: "p1", label: "Website", color: "#4f46e5" };

  accumulateGroups(groups, [project], {
    seconds: 1200,
    billableSec: 1200,
    amount: 40,
    currency: "EUR",
  });
  accumulateGroups(groups, [project], {
    seconds: 600,
    billableSec: 0,
    amount: 0,
    currency: "EUR",
  });

  assert.deepEqual(sortGroups(groups.values()), [
    {
      key: "p1",
      label: "Website",
      color: "#4f46e5",
      seconds: 1800,
      billableSec: 1200,
      amount: 40,
      amounts: [{ amount: 40, currency: "EUR" }],
      currency: "EUR",
    },
  ]);
});
