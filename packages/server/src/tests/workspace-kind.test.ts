/**
 * Personal and team workspaces, against in-memory rows.
 *
 * A personal workspace is its owner's alone: leaving it, handing it over and
 * inviting anybody into it — including through an invitation sent before it
 * was marked — are refused with stable codes. `workspaces.create` makes a team
 * workspace, writing the organization, `member`, the settings and the mirror
 * LAST, the order every membership write follows.
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { TRPCError } from "@trpc/server";
import {
  asWorkspaceKind,
  createWorkspaceSchema,
  type MembershipRefusal,
} from "@starter/shared";
import {
  leaveWorkspace,
  transferOwnership,
} from "../services/membership/members.js";
import {
  acceptInvitation,
  createInvitation,
} from "../services/membership/invitations.js";
import {
  MAX_OWNED_WORKSPACES,
  createTeamWorkspace,
  listWorkspaces,
  teamWorkspaceSlug,
  workspaceKind,
  type WorkspaceCreationDeps,
} from "../services/membership/workspaces.js";
import type { MembershipCollection } from "../services/membership/store.js";
import { choosePersonalWorkspace, SIGNUP_WINDOW_MS } from "../services/migrations/002-personal-workspaces.js";
import {
  NOW,
  PEOPLE,
  actor,
  invitationDepsFor,
  memberId,
  membershipDepsFor,
  recorder,
  seededStore,
  type Recorded,
} from "./support/membership-fixture.js";
import type { MemoryMembershipStore } from "./support/memory-membership-store.js";

let store: MemoryMembershipStore;
let recorded: Recorded;

/** Olivia's personal workspace, beside the fixture's two team workspaces. */
function addPersonalWorkspace(target: MemoryMembershipStore): void {
  target.rows.authOrganizations.push({ id: "ws-p", name: "Olivia's workspace", slug: "olivia-p", kind: "personal" });
  target.rows.authMembers.push({
    id: memberId("olivia", "ws-p"),
    organizationId: "ws-p",
    userId: PEOPLE.olivia.id,
    role: "owner",
    createdAt: new Date(Date.UTC(2025, 11, 1)),
  });
  target.rows.workspaceMembers.push({
    id: "wm-olivia-ws-p",
    workspaceId: "ws-p",
    userId: PEOPLE.olivia.id,
    role: "owner",
    name: "Olivia",
    hourlyRate: null,
    canViewOthersTime: true,
    canViewOthersMoney: true,
    createdAt: new Date(Date.UTC(2025, 11, 1)),
  });
}

/** Mia in Olivia's personal workspace: a state only older data can hold. */
function addLegacyGuest(target: MemoryMembershipStore): void {
  target.rows.authMembers.push({
    id: memberId("mia", "ws-p"),
    organizationId: "ws-p",
    userId: PEOPLE.mia.id,
    role: "member",
    createdAt: new Date(Date.UTC(2026, 0, 2)),
  });
  target.rows.workspaceMembers.push({
    id: "wm-mia-ws-p",
    workspaceId: "ws-p",
    userId: PEOPLE.mia.id,
    role: "member",
    name: "Mia",
    hourlyRate: null,
    canViewOthersTime: false,
    canViewOthersMoney: false,
    createdAt: new Date(Date.UTC(2026, 0, 2)),
  });
}

beforeEach(() => {
  store = seededStore();
  addPersonalWorkspace(store);
  recorded = recorder();
});

async function refused(run: () => Promise<unknown>, code: MembershipRefusal): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof TRPCError, `expected a TRPCError, got ${String(error)}`);
    assert.equal(error.code, "FORBIDDEN");
    assert.equal(error.message, code);
    return true;
  });
}

describe("workspace kind", () => {
  it("reads only the exact string 'personal' as personal", () => {
    assert.equal(asWorkspaceKind("personal"), "personal");
    assert.equal(asWorkspaceKind("team"), "team");
    assert.equal(asWorkspaceKind(undefined), "team");
    assert.equal(asWorkspaceKind("Personal"), "team");
  });

  it("is on every workspaces.list row", async () => {
    const rows = await listWorkspaces(store, { userId: PEOPLE.olivia.id, activeWorkspaceId: "ws-a" });
    const kinds = Object.fromEntries(rows.map((row) => [row.id, row.kind]));
    assert.deepEqual(kinds, { "ws-p": "personal", "ws-a": "team" });
  });

  it("answers team for an organization written before kinds existed", async () => {
    assert.equal(await workspaceKind(store, "ws-a"), "team");
    assert.equal(await workspaceKind(store, "ws-p"), "personal");
  });
});

describe("a personal workspace cannot be shared or lost", () => {
  it("refuses leave, with the personal code even though Olivia is alone", async () => {
    await refused(
      () =>
        leaveWorkspace(membershipDepsFor(store, recorded), {
          ...actor(store, "olivia", "ws-p"),
          user: PEOPLE.olivia,
          sessionId: "s-olivia",
          activeWorkspaceId: "ws-p",
        }),
      "personal-workspace-cannot-leave",
    );
    assert.equal(store.rows.workspaceMembers.filter((r) => r.workspaceId === "ws-p").length, 1);
  });

  it("refuses leave to a guest of a personal workspace too", async () => {
    addLegacyGuest(store);
    await refused(
      () =>
        leaveWorkspace(membershipDepsFor(store, recorded), {
          ...actor(store, "mia", "ws-p"),
          user: PEOPLE.mia,
          sessionId: "s-mia",
          activeWorkspaceId: "ws-a",
        }),
      "personal-workspace-cannot-leave",
    );
  });

  it("refuses transfer, and leaves both records as they were", async () => {
    addLegacyGuest(store);
    await refused(
      () =>
        transferOwnership(membershipDepsFor(store, recorded), actor(store, "olivia", "ws-p"), {
          memberId: memberId("mia", "ws-p"),
        }),
      "personal-workspace-cannot-transfer",
    );
    const mia = store.rows.workspaceMembers.find((r) => r.workspaceId === "ws-p" && r.userId === PEOPLE.mia.id);
    assert.equal(mia?.role, "member");
    assert.deepEqual(recorded.workspace, []);
  });

  it("still answers NOT_FOUND for a member id outside the workspace", async () => {
    await assert.rejects(
      () =>
        transferOwnership(membershipDepsFor(store, recorded), actor(store, "olivia", "ws-p"), {
          memberId: memberId("bob", "ws-b"),
        }),
      (error: unknown) => error instanceof TRPCError && error.code === "NOT_FOUND",
    );
  });

  it("refuses an invitation, before any row is written or budget spent", async () => {
    let charged = 0;
    await refused(
      () =>
        createInvitation(
          invitationDepsFor(store, recorded, {
            budget: async () => {
              charged += 1;
              return true;
            },
          }),
          actor(store, "olivia", "ws-p"),
          { email: "friend@example.test", role: "member" },
        ),
      "personal-workspace-cannot-invite",
    );
    assert.equal(charged, 0);
    assert.equal(store.rows.authInvitations.length, 0);
  });

  it("refuses to accept an invitation sent before the workspace was marked personal", async () => {
    store.rows.authInvitations.push({
      id: "inv-old",
      organizationId: "ws-p",
      email: PEOPLE.mia.email,
      role: "member",
      status: "pending",
      inviterId: PEOPLE.olivia.id,
      expiresAt: new Date(NOW.getTime() + 3_600_000),
      createdAt: new Date(NOW.getTime() - 3_600_000),
    });
    await refused(
      () =>
        acceptInvitation(
          invitationDepsFor(store, recorded),
          { id: PEOPLE.mia.id, email: PEOPLE.mia.email, name: PEOPLE.mia.name },
          { id: "inv-old", sessionId: "s-mia" },
        ),
      "personal-workspace-cannot-invite",
    );
    assert.equal(
      store.rows.workspaceMembers.some((r) => r.workspaceId === "ws-p" && r.userId === PEOPLE.mia.id),
      false,
    );
  });

  it("leaves team workspaces exactly as they were", async () => {
    const result = await createInvitation(invitationDepsFor(store, recorded), actor(store, "olivia", "ws-a"), {
      email: "friend@example.test",
      role: "member",
    });
    assert.equal(result.invitation.email, "friend@example.test");
  });
});

describe("workspaces.create", () => {
  const writes: string[] = [];
  const settings: Array<{ workspaceId: string; currency: string; weekStartsOn: 0 | 1 }> = [];

  const creationDeps = (): WorkspaceCreationDeps => {
    const logged: MemoryMembershipStore = {
      ...store,
      insertOne: async (collection: MembershipCollection, row) => {
        writes.push(collection);
        return store.insertOne(collection, row);
      },
    };
    return {
      store: logged,
      now: () => NOW,
      slugTail: () => "abcd1234",
      seedSettings: async (workspaceId, value) => {
        writes.push("settings");
        settings.push({ workspaceId, ...value });
      },
      publishUser: (userId, event) => recorded.user.push({ userId, event }),
    };
  };

  beforeEach(() => {
    writes.length = 0;
    settings.length = 0;
  });

  it("writes a team organization, member, settings and the owner mirror last", async () => {
    const input = createWorkspaceSchema.parse({ name: "  Ole & Rico  ", currency: "usd", weekStartsOn: 0 });
    const { workspaceId } = await createTeamWorkspace(creationDeps(), PEOPLE.mia, input);

    assert.deepEqual(writes, ["authOrganizations", "authMembers", "settings", "workspaceMembers"]);
    const org = store.rows.authOrganizations.find((r) => r.id === workspaceId);
    assert.equal(org?.name, "Ole & Rico");
    assert.equal(org?.kind, "team");
    assert.equal(org?.slug, "ole-rico-abcd1234");
    assert.equal(
      store.rows.authMembers.find((r) => r.organizationId === workspaceId)?.role,
      "owner",
    );
    const mirror = store.rows.workspaceMembers.find((r) => r.workspaceId === workspaceId);
    assert.equal(mirror?.userId, PEOPLE.mia.id);
    assert.equal(mirror?.role, "owner");
    assert.equal(mirror?.canViewOthersTime, true);
    assert.equal(mirror?.canViewOthersMoney, true);
    assert.deepEqual(settings, [{ workspaceId, currency: "USD", weekStartsOn: 0 }]);
    assert.deepEqual(recorded.user, [
      { userId: PEOPLE.mia.id, event: { kind: "membership.changed", workspaceId, reason: "joined" } },
    ]);

    const listed = await listWorkspaces(store, { userId: PEOPLE.mia.id, activeWorkspaceId: "ws-a" });
    const created = listed.find((row) => row.id === workspaceId);
    assert.equal(created?.kind, "team");
    assert.equal(created?.role, "owner");
    assert.equal(created?.isDefault, false, "creating does not move the session");
  });

  it("refuses a person who already owns the maximum", async () => {
    for (let i = 0; i < MAX_OWNED_WORKSPACES; i += 1) {
      store.rows.workspaceMembers.push({ id: `wm-x${i}`, workspaceId: `ws-x${i}`, userId: PEOPLE.ben.id, role: "owner" });
    }
    await refused(
      () => createTeamWorkspace(creationDeps(), PEOPLE.ben, { name: "One more", currency: "EUR", weekStartsOn: 1 }),
      "workspace-limit-reached",
    );
    assert.deepEqual(writes, []);
  });

  it("validates its input", () => {
    assert.equal(createWorkspaceSchema.safeParse({ name: "   ", currency: "EUR", weekStartsOn: 1 }).success, false);
    assert.equal(createWorkspaceSchema.safeParse({ name: "x", currency: "EURO", weekStartsOn: 1 }).success, false);
    assert.equal(createWorkspaceSchema.safeParse({ name: "x", currency: "EUR", weekStartsOn: 3 }).success, false);
  });

  it("slugs any name into something short and safe", () => {
    assert.equal(teamWorkspaceSlug("Ünïcode & Co", "00ff00ff"), "unicode-co-00ff00ff");
    assert.equal(teamWorkspaceSlug("!!!", "00ff00ff"), "workspace-00ff00ff");
    assert.ok(teamWorkspaceSlug("x".repeat(200), "00ff00ff").length <= 48);
  });
});

describe("choosing a person's personal workspace (migration 2)", () => {
  const signup = Date.UTC(2026, 0, 1, 9);

  it("prefers the workspace made with the account", () => {
    assert.equal(
      choosePersonalWorkspace(signup, [
        { id: "older", createdAt: signup - 10 * SIGNUP_WINDOW_MS },
        { id: "hook", createdAt: signup + 200 },
        { id: "later", createdAt: signup + 5 * SIGNUP_WINDOW_MS },
      ]),
      "hook",
    );
  });

  it("falls back to the oldest when the hook made none", () => {
    assert.equal(
      choosePersonalWorkspace(signup, [
        { id: "later", createdAt: signup + 5 * SIGNUP_WINDOW_MS },
        { id: "repair", createdAt: signup + 2 * SIGNUP_WINDOW_MS },
      ]),
      "repair",
    );
    assert.equal(choosePersonalWorkspace(signup, []), null);
  });
});
