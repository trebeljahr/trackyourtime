// A token must never widen what its owner can see.
//
// There are two ways to break that, and each is invisible from the other
// side. A pure snapshot keeps serving rates after its owner is demoted; a
// pure live read starts serving them the day somebody grants a flag the token
// was never minted under. `narrowVisibility` is the intersection that closes
// both, and this file is the proof that it is an intersection and not, say, a
// union somebody "simplified" it into.
import assert from "node:assert/strict";
import { WorkspaceMember } from "../models/WorkspaceMember.js";
import { describe, it } from "node:test";
// Subpath import: a bare named import from "@starter/shared" throws under
// tsx. See the note in duration.test.ts.
import {
  canSeeEntry,
  canSeeMoneyFor,
  narrowVisibility,
  type VisibilityGrant,
} from "@starter/shared/visibility";
import type { Visibility } from "@starter/shared/types";

const live = (
  canViewOthersTime: boolean,
  canViewOthersMoney: boolean,
): Visibility => ({ userId: "member-1", canViewOthersTime, canViewOthersMoney });

const grant = (
  canViewOthersTime: boolean,
  canViewOthersMoney: boolean,
): VisibilityGrant => ({ canViewOthersTime, canViewOthersMoney });

const BOOLS = [false, true] as const;

describe("narrowVisibility", () => {
  it("never grants a flag that either side lacks", () => {
    for (const liveTime of BOOLS)
      for (const liveMoney of BOOLS)
        for (const ceilTime of BOOLS)
          for (const ceilMoney of BOOLS) {
            const result = narrowVisibility(
              live(liveTime, liveMoney),
              grant(ceilTime, ceilMoney),
            );
            assert.equal(
              result.canViewOthersTime,
              liveTime && ceilTime,
              `time: live=${liveTime} ceiling=${ceilTime}`,
            );
            assert.equal(
              result.canViewOthersMoney,
              liveMoney && ceilMoney,
              `money: live=${liveMoney} ceiling=${ceilMoney}`,
            );
          }
  });

  it("narrows when the member is DEMOTED after the token was minted", () => {
    // Minted while they could see everything; the flags have since been
    // taken away. The token must lose them on its very next request.
    const result = narrowVisibility(live(false, false), grant(true, true));
    assert.equal(result.canViewOthersTime, false);
    assert.equal(result.canViewOthersMoney, false);
  });

  it("does NOT widen when the member is GRANTED more afterwards", () => {
    // Minted under a narrow view; somebody has since ticked both flags. The
    // token was never re-authorised, so it stays where it was.
    const result = narrowVisibility(live(true, true), grant(false, false));
    assert.equal(result.canViewOthersTime, false);
    assert.equal(result.canViewOthersMoney, false);
  });

  it("keeps the identity from the LIVE side", () => {
    const result = narrowVisibility(live(true, true), grant(true, true));
    assert.equal(result.userId, "member-1");
  });

  it("is idempotent — narrowing an already-narrowed view changes nothing", () => {
    const once = narrowVisibility(live(true, true), grant(true, false));
    const twice = narrowVisibility(once, grant(true, false));
    assert.deepEqual(twice, once);
  });
});

describe("what a narrowed visibility then permits", () => {
  it("always shows the caller their own work, both flags off", () => {
    const narrowed = narrowVisibility(live(false, false), grant(false, false));
    assert.equal(canSeeEntry(narrowed, "member-1"), true);
    assert.equal(canSeeMoneyFor(narrowed, "member-1"), true);
  });

  it("hides a colleague entirely without the time flag", () => {
    const narrowed = narrowVisibility(live(true, true), grant(false, true));
    assert.equal(canSeeEntry(narrowed, "member-2"), false);
    // The money flag survives the intersection, but it is unreachable: the
    // projection asks about time FIRST and returns null, so the money answer
    // is never consulted. Asserted so a future reordering of the two checks
    // shows up here rather than as a leak.
    assert.equal(canSeeMoneyFor(narrowed, "member-2"), true);
  });

  it("shows a colleague's time but not their money with only the time flag", () => {
    const narrowed = narrowVisibility(live(true, true), grant(true, false));
    assert.equal(canSeeEntry(narrowed, "member-2"), true);
    assert.equal(canSeeMoneyFor(narrowed, "member-2"), false);
  });
});

// ── which running timer a token may reach ────────────────────────────
//
// The second way a token widens what its owner can see, and the one no
// visibility flag covers: REACH. A token is bound to ONE workspace — the
// OpenAPI document says so, and `requireApiToken` answers 400
// workspace-not-addressable to a request that so much as names another — but
// the running-timer helpers are author-scoped, because for a SESSION the
// principal is the person and "stop whatever I have running" means wherever it
// runs. Handed to a token, that same query reads and stops a timer in a
// workspace the token was never issued for: another client's description and
// hourly rate out of `GET /entries/current`, their billable time ended and
// `entry.stopped` webhooks fired into their workspace out of `POST
// /entries/stop`.
//
// `TimerReach` is the distinction between the two principals, and these tests
// are the proof that the confined one cannot reach across.
import mongoose from "mongoose";
import { TimeEntry, type TimeEntryDocLike } from "../models/TimeEntry.js";
import {
  DEFAULT_USER_PREFERENCES,
  DEFAULT_WORKSPACE_SETTINGS,
  UserPreferencesModel,
  WorkspaceSettingsModel,
} from "../models/Settings.js";
import {
  currentEntry,
  personReach,
  reachFilter,
  reachWorkspaceId,
  startTimer,
  stopRunningEntry,
  stopTimer,
  withinReach,
  workspaceReach,
} from "../services/entries/timer.js";
import { enforceMaxEntryDuration } from "../services/runaway.js";
import type { WorkspaceScope } from "../services/scope.js";

// No database in the unit suite. Buffering off makes the one query most of
// these tests do NOT stub — the runaway guard's preferences read — fail at
// once instead of parking for the default ten seconds. The guard is documented
// never to throw, so a failed read is simply "no runaway", which is what the
// reach tests want. The guard's OWN tests stub it (`withCappingGuard`), because
// an inert guard cannot prove where a live one may write.
mongoose.set("bufferCommands", false);

/** The consultant: a member of workspace A (Acme) and workspace B (Zeta). */
const CONSULTANT = "member-1";

/** A workspace-A token, minted for an Acme contractor's integration. */
const tokenScopeInA: WorkspaceScope = {
  workspaceId: "ws-a",
  userId: CONSULTANT,
  visibility: {
    userId: CONSULTANT,
    canViewOthersTime: false,
    canViewOthersMoney: false,
  },
};

const entryDoc = (
  id: string,
  workspaceId: string,
  end: Date | null,
): TimeEntryDocLike => ({
  _id: id,
  workspaceId,
  authorId: CONSULTANT,
  description: "Zeta merger due diligence",
  projectId: null,
  taskId: null,
  billable: true,
  start: new Date("2026-09-07T09:00:00.000Z"),
  end,
  durationSec: end ? 3600 : 0,
  hourlyRate: 250,
  currency: "EUR",
  source: "web",
  timeZone: null,
  runaway: null,
  tagIds: [],
  invoiceId: null,
  importId: null,
  createdAt: new Date("2026-09-07T09:00:00.000Z"),
  updatedAt: new Date("2026-09-07T09:00:00.000Z"),
});

const RUNNING_IN_B_ID = "64b7f9c2e13a4d5f6a7b8c9d";
const STOPPED_IN_B_ID = "64b7f9c2e13a4d5f6a7b8c9e";
const RUNNING_IN_A_ID = "64b7f9c2e13a4d5f6a7b8c9f";

/** The consultant's Zeta work: one running, one already ended. Both in B. */
const WORKSPACE_B_ENTRIES = [
  entryDoc(RUNNING_IN_B_ID, "ws-b", null),
  entryDoc(STOPPED_IN_B_ID, "ws-b", new Date("2026-09-07T10:00:00.000Z")),
];

/** The same person, tracking in the token's OWN workspace for once. */
const WORKSPACE_A_ENTRIES = [entryDoc(RUNNING_IN_A_ID, "ws-a", null)];

/** Every `find` criterion the services build is a flat equality match. */
const matchesFilter = (
  doc: TimeEntryDocLike,
  filter: Record<string, unknown>,
): boolean => {
  const fields: Record<string, unknown> = { ...doc, _id: String(doc._id) };
  return Object.entries(filter).every(([key, value]) => fields[key] === value);
};

type LeanQuery = { lean: () => Promise<TimeEntryDocLike | null> };
type StubbedFindOne = (filter: Record<string, unknown>) => LeanQuery;
type StubbedFindOneAndUpdate = (
  filter: Record<string, unknown>,
  update: unknown,
  options?: unknown,
) => LeanQuery;
type StubbedCreate = (doc: Record<string, unknown>) => Promise<never>;

// mongoose's `findOne` is overloaded a dozen ways and not one of those
// overloads describes a stub, so the model is reached through `unknown`.
// Nothing about the production types is relaxed — this is only the handle the
// test holds them by.
const stubbable = TimeEntry as unknown as {
  findOne: StubbedFindOne;
  findOneAndUpdate: StubbedFindOneAndUpdate;
  create: StubbedCreate;
};
const realFindOne = stubbable.findOne;
const realFindOneAndUpdate = stubbable.findOneAndUpdate;
const realCreate = stubbable.create;

/** What `finalizeStop` reads to snapshot the rate. Same handle trick. */
type SettingsRow = { workspaceId: string } & typeof DEFAULT_WORKSPACE_SETTINGS;
const stubbableSettings = WorkspaceSettingsModel as unknown as {
  findOne: (filter: {
    workspaceId: string;
  }) => { lean: () => Promise<SettingsRow> };
};
const realSettingsFindOne = stubbableSettings.findOne;
const stubMember = WorkspaceMember as unknown as { findOne: () => { lean: () => Promise<{ hourlyRate: null }> } };
const realMemberFindOne = stubMember.findOne;

/** Filters the services actually queried with, newest last. */
let queried: Record<string, unknown>[] = [];

/**
 * Filters the services tried to WRITE through, newest last.
 *
 * The stop path's only write is `finalizeStop`'s `findOneAndUpdate`, so an
 * empty list is the proof that nothing was ended — and since the stub answers
 * null ("somebody else closed it first", a documented no-op), no `timer.stopped`
 * is published and no `entry.stopped` webhook is enqueued either. The test
 * asserts on reach, not on the delivery machinery.
 */
let updated: Record<string, unknown>[] = [];

/** Documents the services tried to INSERT, newest last. */
let inserted: Record<string, unknown>[] = [];

/** Mongo's duplicate-key error, as the running-entry unique index raises it. */
const duplicateKeyError = (): Error =>
  Object.assign(new Error("E11000 duplicate key error"), { code: 11000 });

const withStubbedEntries = async (
  run: () => Promise<void>,
  docs: readonly TimeEntryDocLike[] = WORKSPACE_B_ENTRIES,
): Promise<void> => {
  queried = [];
  updated = [];
  inserted = [];
  stubbable.findOne = (filter) => ({
    lean: async () => {
      queried.push(filter);
      return docs.find((doc) => matchesFilter(doc, filter)) ?? null;
    },
  });
  stubbable.findOneAndUpdate = (filter) => ({
    lean: async () => {
      updated.push(filter);
      return null;
    },
  });
  // Every insert loses to the unique index, so no test here can reach the
  // publish/webhook tail of a successful start. What a start DID try to close
  // on its way there is in `updated`, which is what these tests are about.
  stubbable.create = async (doc) => {
    inserted.push(doc);
    throw duplicateKeyError();
  };
  stubMember.findOne = () => ({ lean: async () => ({ hourlyRate: null }) });
  stubbableSettings.findOne = ({ workspaceId }) => ({
    lean: async () => ({ workspaceId, ...DEFAULT_WORKSPACE_SETTINGS }),
  });
  try {
    await run();
  } finally {
    stubbable.findOne = realFindOne;
    stubbable.findOneAndUpdate = realFindOneAndUpdate;
    stubbable.create = realCreate;
    stubbableSettings.findOne = realSettingsFindOne;
    stubMember.findOne = realMemberFindOne;
  }
};

/**
 * The preferences the runaway guard reads, with the guard turned up.
 *
 * Everywhere else in this file the guard is deliberately inert (its
 * preferences read fails, and a guard that cannot read is documented to do
 * nothing). The guard's own tests need it awake, so they stub that read with a
 * one-hour limit that CAPS — the acting behaviour, the one that writes.
 */
type PreferencesRow = { userId: string } & typeof DEFAULT_USER_PREFERENCES;
const stubbablePreferences = UserPreferencesModel as unknown as {
  findOne: (filter: {
    userId: string;
  }) => { lean: () => Promise<PreferencesRow> };
};
const realPreferencesFindOne = stubbablePreferences.findOne;

const withCappingGuard = async (run: () => Promise<void>): Promise<void> => {
  stubbablePreferences.findOne = ({ userId }) => ({
    lean: async () => ({
      userId,
      ...DEFAULT_USER_PREFERENCES,
      maxDuration: { maxHours: 1, behavior: "cap" },
    }),
  });
  try {
    await run();
  } finally {
    stubbablePreferences.findOne = realPreferencesFindOne;
  }
};

/** The message off a thrown TRPCError, without widening anything to `any`. */
const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

describe("TimerReach — the workspace a running-timer lookup may reach", () => {
  it("confines every query it is given a workspace for", () => {
    assert.deepEqual(reachFilter(workspaceReach("ws-a")), {
      workspaceId: "ws-a",
    });
    // The person principal adds nothing, which is what keeps one running timer
    // per human visible from whichever workspace they are pointed at.
    assert.deepEqual(reachFilter(personReach), {});
  });

  it("withholds an entry that turned out to live in another workspace", () => {
    const running = { workspaceId: "ws-b" };
    assert.equal(withinReach(running, workspaceReach("ws-a")), null);
    assert.equal(withinReach(running, workspaceReach("ws-b")), running);
    assert.equal(withinReach(running, personReach), running);
  });
});

describe("currentEntry under a workspace-bound token", () => {
  it("does NOT report the person's timer running in another workspace", async () => {
    await withStubbedEntries(async () => {
      const entry = await currentEntry(
        tokenScopeInA,
        workspaceReach("ws-a"),
      );
      // Not the Zeta description, not the 250/h rate, not even the fact that
      // something is running somewhere: null, exactly as if the timer were off.
      assert.equal(entry, null);
      assert.ok(queried.length > 0, "the lookup must actually have run");
      for (const filter of queried) {
        assert.equal(
          filter.workspaceId,
          "ws-a",
          "a confined lookup must never query without the workspace",
        );
      }
    });
  });

  it("still answers with it on the unconfined tRPC path", async () => {
    await withStubbedEntries(async () => {
      const entry = await currentEntry(tokenScopeInA, personReach);
      assert.ok(entry, "the person must still see their own running timer");
      // The point of the person reach: the entry is in ws-b while the request
      // came in for ws-a, and it comes back naming its own workspace.
      assert.equal(entry.workspaceId, "ws-b");
      assert.equal(entry.id, RUNNING_IN_B_ID);
      for (const filter of queried) {
        assert.equal(
          "workspaceId" in filter,
          false,
          "the person path must stay workspace-agnostic",
        );
      }
    });
  });
});

describe("stopTimer under a workspace-bound token", () => {
  it("refuses to stop the timer running in another workspace", async () => {
    await withStubbedEntries(async () => {
      await assert.rejects(
        () => stopTimer(tokenScopeInA, {}, workspaceReach("ws-a")),
        (error: unknown) => {
          // NOT_FOUND rather than FORBIDDEN: a 403 here would confirm that a
          // timer is running in a workspace this token may not address.
          assert.equal(
            (error as { code?: unknown }).code,
            "NOT_FOUND",
            messageOf(error),
          );
          assert.match(messageOf(error), /No running timer/);
          return true;
        },
      );
      // Refused at the lookup — nothing was ended and no `entry.stopped`
      // webhook could have been enqueued into workspace B.
      assert.ok(queried.length > 0);
      assert.equal(queried[queried.length - 1]?.workspaceId, "ws-a");
    });
  });

  it("will not address a foreign entry by id either", async () => {
    await withStubbedEntries(async () => {
      await assert.rejects(
        () =>
          stopTimer(
            tokenScopeInA,
            { id: STOPPED_IN_B_ID },
            workspaceReach("ws-a"),
          ),
        (error: unknown) => {
          assert.equal((error as { code?: unknown }).code, "NOT_FOUND");
          return true;
        },
      );
    });
  });

  it("still finds that same entry on the unconfined tRPC path", async () => {
    await withStubbedEntries(async () => {
      await assert.rejects(
        () => stopTimer(tokenScopeInA, { id: STOPPED_IN_B_ID }, personReach),
        (error: unknown) => {
          // A DIFFERENT refusal, and that is the assertion: the lookup reached
          // the ws-b entry and only then objected that it is already stopped.
          // The confined case above never got that far.
          assert.equal((error as { code?: unknown }).code, "BAD_REQUEST");
          assert.match(messageOf(error), /not running/);
          return true;
        },
      );
    });
  });
});

// ── the stop a START performs, which is a WRITE ──────────────────────
//
// `current` and `stop` were the reads and the explicit stop. A start is the
// third reach, and the one that crosses without ever being asked to: opening a
// timer closes whatever was running, and for a token bound to workspace A that
// entry may be the person's billable work in workspace B. Confined, the start
// is refused instead — chosen over starting anyway, which would leave the
// person with two running timers.

describe("startTimer under a workspace-bound token", () => {
  it("refuses rather than closing the timer running in another workspace", async () => {
    await withStubbedEntries(async () => {
      await assert.rejects(
        () => startTimer(tokenScopeInA, {}, workspaceReach("ws-a")),
        (error: unknown) => {
          assert.equal(
            (error as { code?: unknown }).code,
            "CONFLICT",
            messageOf(error),
          );
          assert.match(messageOf(error), /another workspace/);
          // The refusal says THAT one is running, never where or on what.
          assert.doesNotMatch(messageOf(error), /ws-b|Zeta|250/);
          return true;
        },
      );
      // The whole finding, in two assertions: workspace B's entry was not
      // ended (no rate snapshot, no closed billable period, so no
      // `entry.stopped` into a workspace this token cannot address), and no
      // second running entry was opened here either.
      assert.deepEqual(updated, []);
      assert.deepEqual(inserted, []);
    });
  });

  it("still closes the running timer when it is in the token's OWN workspace", async () => {
    await withStubbedEntries(
      async () => {
        await assert.rejects(
          () => startTimer(tokenScopeInA, {}, workspaceReach("ws-a")),
          (error: unknown) => {
            // The insert loses to the unique index in this harness, so the
            // start ends in the ordinary concurrent-start CONFLICT. The
            // assertion is that it is THAT one and not the cross-workspace
            // refusal: a confined start is confined, not blanket-refused.
            assert.equal((error as { code?: unknown }).code, "CONFLICT");
            assert.match(messageOf(error), /Another timer is already running/);
            return true;
          },
        );
        assert.ok(updated.length > 0, "its own workspace's timer must stop");
        for (const filter of updated) {
          assert.equal(filter._id, RUNNING_IN_A_ID);
        }
        assert.ok(inserted.length > 0, "the new entry must have been attempted");
      },
      WORKSPACE_A_ENTRIES,
    );
  });
});

describe("stopRunningEntry — the implicit stop underneath a start", () => {
  const at = new Date("2026-09-07T11:00:00.000Z");

  it("leaves a foreign running entry alone under a workspace reach", async () => {
    await withStubbedEntries(async () => {
      await stopRunningEntry(CONSULTANT, at, workspaceReach("ws-a"));
      assert.deepEqual(updated, [], "nothing in workspace B may be ended");
      assert.equal(
        queried[queried.length - 1]?.workspaceId,
        "ws-a",
        "the lookup itself must carry the confinement",
      );
    });
  });

  it("still stops it on the unconfined tRPC path", async () => {
    await withStubbedEntries(async () => {
      await stopRunningEntry(CONSULTANT, at, personReach);
      // One running timer per human: a session client starting a timer here
      // must still close the one running in ws-b, or the person ends up with
      // two. The write targeted that very entry.
      assert.equal(updated.length, 1);
      assert.equal(updated[0]?._id, RUNNING_IN_B_ID);
      for (const filter of queried) {
        assert.equal(
          "workspaceId" in filter,
          false,
          "the person path must stay workspace-agnostic",
        );
      }
    });
  });
});

// The runaway guard is the fourth reach, and the only one that is purely a
// MUTATION: nothing asks for it, it fires off whichever read resolves "what is
// running", and it caps or flags that entry and publishes into the entry's own
// workspace. Author-scoped, a workspace-A token could drive it onto a
// workspace-B entry and end that client's billable period through the back
// door. It takes the confinement itself now, so the guarantee is a filter on
// its own query rather than a promise kept by each of its call sites.

describe("enforceMaxEntryDuration under a confined principal", () => {
  /** Four hours into an entry the stubbed preferences cap at one. */
  const NOW = new Date("2026-09-07T13:00:00.000Z");

  it("maps a reach onto the confinement the guard takes", () => {
    assert.equal(reachWorkspaceId(workspaceReach("ws-a")), "ws-a");
    // `null` is the person, and the only value that reaches every workspace.
    assert.equal(reachWorkspaceId(personReach), null);
  });

  it("never caps an entry outside the workspace it was given", async () => {
    await withCappingGuard(async () => {
      await withStubbedEntries(async () => {
        const outcome = await enforceMaxEntryDuration(CONSULTANT, "ws-a", NOW);
        assert.deepEqual(outcome, { kind: "none" });
        assert.deepEqual(
          updated,
          [],
          "workspace B's billable period must not be ended by an A-bound token",
        );
        assert.equal(
          queried[queried.length - 1]?.workspaceId,
          "ws-a",
          "the guard's own lookup must carry the confinement, not just its callers'",
        );
      });
    });
  });

  it("still caps the person's runaway wherever it is running", async () => {
    await withCappingGuard(async () => {
      await withStubbedEntries(async () => {
        await enforceMaxEntryDuration(CONSULTANT, null, NOW);
        // The positive twin: confinement must not be a way of switching the
        // guard off. A session client reaches the ws-b runaway and caps it.
        assert.equal(updated.length, 1);
        assert.equal(updated[0]?._id, RUNNING_IN_B_ID);
      });
    });
  });
});
