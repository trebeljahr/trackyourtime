// Deleting an account removes everything the person owns — and nothing that
// belongs to the people they shared a workspace with.
//
// The cascade runs here against in-memory rows through the same
// `DeletionRowStore` interface the mongoose and better-auth stores implement,
// with Mongo's matching rules for the three filter shapes it uses. What these
// pin is the part with judgement in it: which workspace is deleted and which
// is only left, who inherits ownership, which of the person's rows survive in
// a shared workspace, and that a run which dies half-way is finished by simply
// running it again.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deleteAccountData } from "../services/account-deletion/delete-account.js";
import {
  planWorkspaceExit,
  type DeletionCollection,
  type MemberRow,
} from "../services/account-deletion/plan.js";
import {
  authRowStore,
  mongooseRowStore,
  routedRowStore,
} from "../services/account-deletion/stores.js";
import { memoryRowStore } from "./support/memory-row-store.js";

const ALICE = "user_alice";
const BOB = "user_bob";
const CAROL = "user_carol";
const SOLO = "ws_alice_solo";
const TEAM = "ws_team";
const BOBS = "ws_bob_solo";

const day = (n: number): Date => new Date(Date.UTC(2026, 0, n));

/**
 * Alice is deleting her account. She is alone in SOLO, the owner of TEAM
 * (where Bob is an admin and Carol a member who joined before him), and has
 * been invited to Bob's own workspace.
 */
const seed = (): NonNullable<Parameters<typeof memoryRowStore>[0]> => ({
  workspaceMembers: [
    { workspaceId: SOLO, userId: ALICE, role: "owner", createdAt: day(1) },
    { workspaceId: TEAM, userId: ALICE, role: "owner", createdAt: day(2) },
    {
      workspaceId: TEAM,
      userId: CAROL,
      role: "member",
      createdAt: day(3),
      canViewOthersTime: false,
      canViewOthersMoney: false,
    },
    {
      workspaceId: TEAM,
      userId: BOB,
      role: "admin",
      createdAt: day(4),
      canViewOthersTime: true,
      canViewOthersMoney: false,
    },
    { workspaceId: BOBS, userId: BOB, role: "owner", createdAt: day(1) },
  ],
  authOrganizations: [{ id: SOLO }, { id: TEAM }, { id: BOBS }],
  authMembers: [
    { id: "m1", organizationId: SOLO, userId: ALICE, role: "owner", createdAt: day(1) },
    { id: "m2", organizationId: TEAM, userId: ALICE, role: "owner", createdAt: day(2) },
    { id: "m3", organizationId: TEAM, userId: CAROL, role: "member", createdAt: day(3) },
    { id: "m4", organizationId: TEAM, userId: BOB, role: "admin", createdAt: day(4) },
    { id: "m5", organizationId: BOBS, userId: BOB, role: "owner", createdAt: day(1) },
  ],
  authInvitations: [
    { id: "i1", organizationId: SOLO, inviterId: ALICE, email: "dave@example.com" },
    { id: "i2", organizationId: TEAM, inviterId: ALICE, email: "erin@example.com" },
    { id: "i3", organizationId: TEAM, inviterId: BOB, email: "frank@example.com" },
    { id: "i4", organizationId: BOBS, inviterId: BOB, email: "alice@example.com" },
  ],
  authDeviceCodes: [
    { id: "d1", userId: ALICE },
    { id: "d2", userId: BOB },
  ],
  timeEntries: [
    { id: "e1", workspaceId: SOLO, authorId: ALICE, invoiceId: "inv_solo" },
    { id: "e2", workspaceId: SOLO, authorId: ALICE },
    { id: "e3", workspaceId: TEAM, authorId: ALICE, invoiceId: null },
    // Written before `invoiceId` existed: absent reads as "not invoiced".
    { id: "e4", workspaceId: TEAM, authorId: ALICE },
    { id: "e5", workspaceId: TEAM, authorId: ALICE, invoiceId: "inv_team" },
    { id: "e6", workspaceId: TEAM, authorId: BOB, invoiceId: null },
    { id: "e7", workspaceId: BOBS, authorId: BOB, invoiceId: null },
  ],
  clients: [
    { id: "c1", workspaceId: SOLO, createdBy: ALICE },
    { id: "c2", workspaceId: TEAM, createdBy: ALICE },
  ],
  projects: [
    { id: "p1", workspaceId: SOLO, createdBy: ALICE },
    { id: "p2", workspaceId: TEAM, createdBy: ALICE },
  ],
  tasks: [
    { id: "t1", workspaceId: SOLO, createdBy: ALICE },
    { id: "t2", workspaceId: TEAM, createdBy: ALICE },
  ],
  tags: [
    { id: "g1", workspaceId: SOLO, createdBy: ALICE },
    { id: "g2", workspaceId: TEAM, createdBy: ALICE },
  ],
  favorites: [
    { id: "f1", workspaceId: SOLO, userId: ALICE },
    { id: "f2", workspaceId: TEAM, userId: ALICE },
    { id: "f3", workspaceId: TEAM, userId: BOB },
  ],
  invoices: [
    { id: "inv_solo", workspaceId: SOLO, createdBy: ALICE },
    { id: "inv_team", workspaceId: TEAM, createdBy: ALICE },
  ],
  importBatches: [
    { id: "b1", workspaceId: SOLO, createdBy: ALICE },
    { id: "b2", workspaceId: TEAM, createdBy: ALICE },
    { id: "b3", workspaceId: TEAM, createdBy: BOB },
  ],
  apiTokens: [
    { id: "k1", workspaceId: SOLO, userId: ALICE },
    { id: "k2", workspaceId: TEAM, userId: ALICE },
    { id: "k3", workspaceId: TEAM, userId: BOB },
  ],
  webhookSubscriptions: [
    { id: "wh_solo", workspaceId: SOLO, createdBy: ALICE },
    { id: "wh_alice", workspaceId: TEAM, createdBy: ALICE },
    { id: "wh_bob", workspaceId: TEAM, createdBy: BOB },
  ],
  webhookDeliveries: [
    { id: "wd1", workspaceId: SOLO, subscriptionId: "wh_solo" },
    { id: "wd2", workspaceId: TEAM, subscriptionId: "wh_alice" },
    { id: "wd3", workspaceId: TEAM, subscriptionId: "wh_bob" },
  ],
  workspaceSettings: [
    { workspaceId: SOLO },
    { workspaceId: TEAM },
    { workspaceId: BOBS },
  ],
  businessProfiles: [
    { workspaceId: SOLO, legalName: "Alice Solo" },
    { workspaceId: TEAM, legalName: "Team Ltd" },
  ],
  userPreferences: [{ userId: ALICE }, { userId: BOB }],
  profiles: [{ userId: ALICE }, { userId: BOB }],
});

const ids = (
  store: ReturnType<typeof memoryRowStore>,
  collection: DeletionCollection,
): string[] =>
  (store.rows[collection] ?? [])
    .map((row) => String(row.id ?? `${row.workspaceId ?? ""}/${row.userId ?? ""}`))
    .sort();

const alice = { id: ALICE, email: "Alice@Example.com" };

describe("planWorkspaceExit", () => {
  const member = (
    userId: string,
    role: MemberRow["role"],
    joined: number,
  ): MemberRow => ({ userId, role, createdAt: day(joined) });

  it("deletes a workspace the person is alone in", () => {
    assert.deepEqual(planWorkspaceExit(SOLO, ALICE, [member(ALICE, "owner", 1)]), {
      kind: "delete-workspace",
      workspaceId: SOLO,
    });
  });

  it("deletes a workspace with no members at all (a retry after the last row went)", () => {
    assert.equal(planWorkspaceExit(SOLO, ALICE, []).kind, "delete-workspace");
  });

  it("keeps an owner who is already there rather than promoting anybody", () => {
    assert.deepEqual(
      planWorkspaceExit(TEAM, ALICE, [
        member(ALICE, "owner", 1),
        member(BOB, "owner", 2),
        member(CAROL, "admin", 3),
      ]),
      { kind: "leave-workspace", workspaceId: TEAM, owner: BOB },
    );
  });

  it("hands ownership to an admin before a longer-standing member", () => {
    const exit = planWorkspaceExit(TEAM, ALICE, [
      member(ALICE, "owner", 1),
      member(CAROL, "member", 2),
      member(BOB, "admin", 3),
    ]);
    assert.deepEqual(exit, { kind: "leave-workspace", workspaceId: TEAM, owner: BOB });
  });

  it("among equals, hands ownership to whoever joined first", () => {
    const exit = planWorkspaceExit(TEAM, ALICE, [
      member(BOB, "member", 5),
      member(ALICE, "owner", 1),
      member(CAROL, "member", 2),
    ]);
    assert.equal(exit.kind === "leave-workspace" && exit.owner, CAROL);
  });

  it("promotes even when the departing person was not the owner", () => {
    // A workspace with no owner at all is already broken; leaving it that way
    // after a deletion would make it permanent.
    const exit = planWorkspaceExit(TEAM, ALICE, [
      member(ALICE, "member", 1),
      member(BOB, "member", 2),
    ]);
    assert.equal(exit.kind === "leave-workspace" && exit.owner, BOB);
  });
});

describe("deleteAccountData", () => {
  it("deletes the solo workspace and everything scoped to it", async () => {
    const store = memoryRowStore(seed());
    await deleteAccountData(store, alice);

    for (const [collection, rows] of Object.entries(store.rows)) {
      const left = rows.filter(
        (row) => row.workspaceId === SOLO || row.organizationId === SOLO || row.id === SOLO,
      );
      assert.deepEqual(left, [], `${collection} still holds rows from the solo workspace`);
    }
  });

  it("in a shared workspace, removes only Alice's own rows", async () => {
    const store = memoryRowStore(seed());
    await deleteAccountData(store, alice);

    // Her uninvoiced entries go; the invoiced one is the record behind an
    // invoice already sent, and stays with it. Bob's are untouched.
    assert.deepEqual(ids(store, "timeEntries"), ["e5", "e6", "e7"]);
    // The catalog and the invoices belong to the workspace.
    assert.deepEqual(ids(store, "clients"), ["c2"]);
    assert.deepEqual(ids(store, "projects"), ["p2"]);
    assert.deepEqual(ids(store, "tasks"), ["t2"]);
    assert.deepEqual(ids(store, "tags"), ["g2"]);
    assert.deepEqual(ids(store, "invoices"), ["inv_team"]);
    assert.deepEqual(
      (store.rows.workspaceSettings ?? []).map((row) => row.workspaceId).sort(),
      [BOBS, TEAM],
    );
    // The shared workspace keeps its issuer profile; the solo one's is gone.
    assert.deepEqual(
      (store.rows.businessProfiles ?? []).map((row) => row.workspaceId),
      [TEAM],
    );
    // Her pins, tokens, webhooks (with their deliveries) and imports go.
    assert.deepEqual(ids(store, "favorites"), ["f3"]);
    assert.deepEqual(ids(store, "apiTokens"), ["k3"]);
    assert.deepEqual(ids(store, "webhookSubscriptions"), ["wh_bob"]);
    assert.deepEqual(ids(store, "webhookDeliveries"), ["wd3"]);
    assert.deepEqual(ids(store, "importBatches"), ["b3"]);
    // The workspace itself survives.
    assert.deepEqual(ids(store, "authOrganizations"), [BOBS, TEAM].sort());
  });

  it("hands TEAM to Bob, in both membership records, with full visibility", async () => {
    const store = memoryRowStore(seed());
    const report = await deleteAccountData(store, alice);

    assert.deepEqual(report, {
      workspacesDeleted: [SOLO],
      workspacesLeft: [TEAM],
      promoted: { [TEAM]: BOB },
    });

    const bob = store.rows.workspaceMembers?.find(
      (row) => row.workspaceId === TEAM && row.userId === BOB,
    );
    assert.equal(bob?.role, "owner");
    assert.equal(bob?.canViewOthersTime, true);
    assert.equal(bob?.canViewOthersMoney, true);
    const carol = store.rows.workspaceMembers?.find(
      (row) => row.workspaceId === TEAM && row.userId === CAROL,
    );
    assert.equal(carol?.role, "member");
    assert.equal(ids(store, "authMembers").join(), "m3,m4,m5");
    assert.equal(store.rows.authMembers?.find((row) => row.id === "m4")?.role, "owner");
    assert.equal(
      store.rows.workspaceMembers?.some((row) => row.userId === ALICE),
      false,
    );
  });

  it("removes the invitations Alice sent and any addressed to her, not Bob's", async () => {
    const store = memoryRowStore(seed());
    await deleteAccountData(store, alice);
    // i1 went with SOLO, i2 with her TEAM membership, i4 by her (case-folded)
    // email. i3 is Bob's invite to his own workspace.
    assert.deepEqual(ids(store, "authInvitations"), ["i3"]);
  });

  it("removes her per-person rows and leaves Bob's", async () => {
    const store = memoryRowStore(seed());
    await deleteAccountData(store, alice);
    assert.deepEqual(store.rows.userPreferences, [{ userId: BOB }]);
    assert.deepEqual(store.rows.profiles, [{ userId: BOB }]);
    assert.deepEqual(ids(store, "authDeviceCodes"), ["d2"]);
  });

  it("does not touch Bob's own workspace at all", async () => {
    const store = memoryRowStore(seed());
    await deleteAccountData(store, alice);
    assert.deepEqual(ids(store, "timeEntries").filter((id) => id === "e7"), ["e7"]);
    assert.equal(
      store.rows.workspaceMembers?.filter((row) => row.workspaceId === BOBS).length,
      1,
    );
  });

  it("treats a colleague present in only one membership record as a colleague", async () => {
    // A crash between better-auth's member write and the app mirror leaves
    // Bob in one of them. Reading only the mirror would call TEAM solo and
    // delete Bob's work with it.
    const rows = seed();
    rows.workspaceMembers = rows.workspaceMembers?.filter(
      (row) => row.workspaceId !== TEAM || row.userId === ALICE,
    );
    rows.authMembers = rows.authMembers?.filter(
      (row) => row.organizationId !== TEAM || row.userId !== CAROL,
    );
    const store = memoryRowStore(rows);
    const report = await deleteAccountData(store, alice);

    assert.deepEqual(report.workspacesLeft, [TEAM]);
    assert.ok(ids(store, "timeEntries").includes("e6"));
    assert.equal(report.promoted[TEAM], BOB);
  });

  it("with no memberships left, still sweeps the per-person rows", async () => {
    const store = memoryRowStore({
      apiTokens: [{ id: "k", workspaceId: "gone", userId: ALICE }],
      profiles: [{ userId: ALICE }],
    });
    const report = await deleteAccountData(store, alice);
    assert.deepEqual(report, { workspacesDeleted: [], workspacesLeft: [], promoted: {} });
    assert.deepEqual(store.rows.apiTokens, []);
    assert.deepEqual(store.rows.profiles, []);
  });

  it("is a no-op the second time", async () => {
    const store = memoryRowStore(seed());
    await deleteAccountData(store, alice);
    const after = structuredClone(store.rows);
    const report = await deleteAccountData(store, alice);
    assert.deepEqual(store.rows, after);
    assert.deepEqual(report, { workspacesDeleted: [], workspacesLeft: [], promoted: {} });
  });

  it("finishes from wherever a failed run stopped, and never leaves TEAM ownerless", async () => {
    const clean = memoryRowStore(seed());
    let writes = 0;
    const counting = {
      ...clean,
      updateMany: (...args: Parameters<typeof clean.updateMany>) => {
        writes += 1;
        return clean.updateMany(...args);
      },
      deleteMany: (...args: Parameters<typeof clean.deleteMany>) => {
        writes += 1;
        return clean.deleteMany(...args);
      },
    };
    await deleteAccountData(counting, alice);
    assert.ok(writes > 20, "the fixture should exercise every step");

    for (let failAt = 1; failAt <= writes; failAt += 1) {
      const store = memoryRowStore(seed());
      store.failOnWrite(failAt);
      await assert.rejects(deleteAccountData(store, alice), /simulated failure/);

      const teamMembers = (store.rows.workspaceMembers ?? []).filter(
        (row) => row.workspaceId === TEAM,
      );
      assert.ok(
        teamMembers.some((row) => row.role === "owner"),
        `failing on write ${failAt} left TEAM with no owner`,
      );

      store.failOnWrite(null);
      await deleteAccountData(store, alice);
      assert.deepEqual(store.rows, clean.rows, `retry after write ${failAt} diverged`);
    }
  });
});

describe("the row stores refuse filters that would match everything", () => {
  it("an app collection with an empty filter throws before any query", async () => {
    await assert.rejects(mongooseRowStore.deleteMany("timeEntries", {}), /empty filter/);
  });

  it("an auth table with an empty filter throws before reaching the adapter", async () => {
    const touched: string[] = [];
    const store = authRowStore({
      findMany: async () => {
        touched.push("findMany");
        return [];
      },
      updateMany: async () => {
        touched.push("updateMany");
        return 0;
      },
      deleteMany: async () => {
        touched.push("deleteMany");
        return 0;
      },
    });
    await assert.rejects(store.deleteMany("authMembers", {}), /empty filter/);
    await assert.rejects(store.deleteMany("authMembers", { userId: null }), /null filter/);
    await assert.rejects(store.deleteMany("timeEntries", { workspaceId: "x" }), /not an auth table/);
    assert.deepEqual(touched, []);
  });

  it("routes auth tables to the auth store and the rest to the app store", async () => {
    const app = memoryRowStore({ timeEntries: [{ id: "e", workspaceId: "w" }] });
    const auth = memoryRowStore({ authMembers: [{ id: "m", organizationId: "w" }] });
    const routed = routedRowStore(app, auth);
    assert.equal(await routed.deleteMany("timeEntries", { workspaceId: "w" }), 1);
    assert.equal(await routed.deleteMany("authMembers", { organizationId: "w" }), 1);
    assert.equal(await routed.deleteMany("authMembers", { workspaceId: "w" }), 0);
  });
});
