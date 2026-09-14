/**
 * The membership permission matrix, role × action, against in-memory rows.
 *
 * Every case runs the real service (`services/membership/members.ts` and
 * `invitations.ts`) — the same functions the tRPC routers are one line over —
 * so a refusal here is the refusal a client gets. Two kinds of answer:
 *
 *  - FORBIDDEN with a stable code, for a real row in the caller's OWN
 *    workspace that they may not touch;
 *  - NOT_FOUND with no message, for any id outside it — identical for a
 *    foreign id and a made-up one, so neither can be probed.
 *
 * A non-member of the workspace never reaches these functions: the workspace
 * middleware answers NOT_FOUND first (see workspace-resolution.test.ts).
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { TRPCError } from "@trpc/server";
import {
  updateRoleSchema,
  inviteMemberSchema,
  permissionsFor,
  type MembershipRefusal,
} from "@starter/shared";
import {
  leaveWorkspace,
  listMembers,
  removeMember,
  transferOwnership,
  updateMemberRole,
  updateMemberVisibility,
} from "../services/membership/members.js";
import {
  cancelInvitation,
  createInvitation,
  listInvitations,
} from "../services/membership/invitations.js";
import { assertRole, InvalidRoleError } from "../services/membership/lifecycle.js";
import { asRole } from "../services/membership/records.js";
import {
  PEOPLE,
  actor,
  invitationDepsFor,
  memberId,
  membershipDepsFor,
  recorder,
  recordsOf,
  seededStore,
  type PersonKey,
  type Recorded,
} from "./support/membership-fixture.js";
import type { MemoryMembershipStore } from "./support/memory-membership-store.js";

let store: MemoryMembershipStore;
let recorded: Recorded;

beforeEach(() => {
  store = seededStore();
  recorded = recorder();
});

const deps = () => membershipDepsFor(store, recorded);
const inviteDeps = () => invitationDepsFor(store, recorded);
const as = (person: PersonKey, workspaceId = "ws-a") => actor(store, person, workspaceId);

async function refused(
  run: () => Promise<unknown>,
  code: MembershipRefusal,
): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof TRPCError, `expected a TRPCError, got ${String(error)}`);
    assert.equal(error.code, "FORBIDDEN");
    assert.equal(error.message, code);
    return true;
  });
}

async function notFound(run: () => Promise<unknown>): Promise<string> {
  let message = "";
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof TRPCError, `expected a TRPCError, got ${String(error)}`);
    assert.equal(error.code, "NOT_FOUND");
    message = error.message;
    return true;
  });
  return message;
}

describe("members.updateRole", () => {
  it("owner changes admin <-> member of other people", async () => {
    const row = await updateMemberRole(deps(), as("olivia"), {
      memberId: memberId("mia", "ws-a"),
      role: "admin",
    });
    assert.equal(row.role, "admin");
    const { mirror, member } = recordsOf(store, "mia", "ws-a");
    assert.equal(mirror?.role, "admin");
    assert.equal(member?.role, "admin");
    // Promotion to admin grants no flag.
    assert.equal(mirror?.canViewOthersTime, false);
    assert.equal(mirror?.canViewOthersMoney, false);

    await updateMemberRole(deps(), as("olivia"), { memberId: memberId("adam", "ws-a"), role: "member" });
    assert.equal(recordsOf(store, "adam", "ws-a").member?.role, "member");
    assert.deepEqual(
      recorded.workspace.map((e) => e.event),
      [
        { kind: "membership.changed", workspaceId: "ws-a", reason: "role" },
        { kind: "membership.changed", workspaceId: "ws-a", reason: "role" },
      ],
    );
  });

  it("admin and member cannot change roles at all", async () => {
    await refused(
      () => updateMemberRole(deps(), as("adam"), { memberId: memberId("mia", "ws-a"), role: "admin" }),
      "owner-required",
    );
    await refused(
      () => updateMemberRole(deps(), as("mia"), { memberId: memberId("max", "ws-a"), role: "admin" }),
      "owner-required",
    );
    assert.equal(recordsOf(store, "mia", "ws-a").mirror?.role, "member");
  });

  it("nobody changes their own role — a member promoting themselves, an owner demoting themselves", async () => {
    await refused(
      () => updateMemberRole(deps(), as("mia"), { memberId: memberId("mia", "ws-a"), role: "admin" }),
      "cannot-modify-self",
    );
    await refused(
      () => updateMemberRole(deps(), as("adam"), { memberId: memberId("adam", "ws-a"), role: "admin" }),
      "cannot-modify-self",
    );
    await refused(
      () => updateMemberRole(deps(), as("olivia"), { memberId: memberId("olivia", "ws-a"), role: "admin" }),
      "cannot-modify-self",
    );
  });

  it("an admin cannot demote the owner, and the last owner cannot be demoted", async () => {
    await refused(
      () => updateMemberRole(deps(), as("adam"), { memberId: memberId("olivia", "ws-a"), role: "member" }),
      "owner-required",
    );
    // A second owner (a half-finished transfer, say) may demote the first,
    // but never down to zero owners.
    store.rows.workspaceMembers.find((r) => r.userId === PEOPLE.adam.id)!.role = "owner";
    await updateMemberRole(deps(), as("adam"), { memberId: memberId("olivia", "ws-a"), role: "admin" });
    assert.equal(recordsOf(store, "olivia", "ws-a").mirror?.role, "admin");
    const owners = store.rows.workspaceMembers.filter((r) => r.workspaceId === "ws-a" && r.role === "owner");
    assert.equal(owners.length, 1);
  });

  it("the owner role is never reachable through updateRole", async () => {
    // The schema refuses it, and so do the service and the lifecycle.
    assert.equal(updateRoleSchema.safeParse({ memberId: "x", role: "owner" }).success, false);
    assert.equal(updateRoleSchema.safeParse({ memberId: "x", role: "admin,owner" }).success, false);
    assert.equal(updateRoleSchema.safeParse({ memberId: "x", role: "superadmin" }).success, false);
    await refused(
      () => updateMemberRole(deps(), as("olivia"), { memberId: memberId("mia", "ws-a"), role: "owner" }),
      "owner-required",
    );
    assert.throws(() => assertRole("admin,owner"), InvalidRoleError);
    assert.throws(() => assertRole("Owner"), InvalidRoleError);
    assert.throws(() => assertRole(""), InvalidRoleError);
    assert.equal(assertRole("admin"), "admin");
    // A stray stored value reads as the LOWEST role, never the union.
    assert.equal(asRole("admin,owner"), "member");
  });

  it("a member id from another workspace answers NOT_FOUND, exactly like a made-up one", async () => {
    const foreign = await notFound(() =>
      updateMemberRole(deps(), as("olivia"), { memberId: memberId("ben", "ws-b"), role: "admin" }),
    );
    const madeUp = await notFound(() =>
      updateMemberRole(deps(), as("olivia"), { memberId: "m-nobody", role: "admin" }),
    );
    assert.equal(foreign, madeUp);
    // Even for a caller who would be refused on a real row: no oracle.
    const asMember = await notFound(() =>
      updateMemberRole(deps(), as("mia"), { memberId: memberId("bob", "ws-b"), role: "admin" }),
    );
    assert.equal(asMember, madeUp);
    // The mirror's own row id cannot cross workspaces either.
    await notFound(() =>
      updateMemberRole(deps(), as("olivia"), { memberId: "wm-ben-ws-b", role: "admin" }),
    );
    assert.equal(recordsOf(store, "ben", "ws-b").mirror?.role, "member");
  });
});

describe("members.updateVisibility", () => {
  it("owner edits both flags of non-owners", async () => {
    const row = await updateMemberVisibility(deps(), as("olivia"), {
      memberId: memberId("adam", "ws-a"),
      canViewOthersTime: true,
      canViewOthersMoney: true,
    });
    assert.equal(row.canViewOthersTime, true);
    assert.equal(row.canViewOthersMoney, true);
  });

  it("admin edits time visibility of role=member rows only", async () => {
    const row = await updateMemberVisibility(deps(), as("adam"), {
      memberId: memberId("mia", "ws-a"),
      canViewOthersTime: true,
    });
    assert.equal(row.canViewOthersTime, true);
    assert.equal(row.canViewOthersMoney, false);
  });

  it("admin never grants money — to a member, or to anybody", async () => {
    await refused(
      () =>
        updateMemberVisibility(deps(), as("adam"), {
          memberId: memberId("mia", "ws-a"),
          canViewOthersMoney: true,
        }),
      "owner-required",
    );
    // Not even a no-op value: who may decide is the question, not the diff.
    await refused(
      () =>
        updateMemberVisibility(deps(), as("adam"), {
          memberId: memberId("mia", "ws-a"),
          canViewOthersTime: true,
          canViewOthersMoney: false,
        }),
      "owner-required",
    );
    assert.equal(recordsOf(store, "mia", "ws-a").mirror?.canViewOthersMoney, false);
    assert.equal(recordsOf(store, "mia", "ws-a").mirror?.canViewOthersTime, false);
  });

  it("admin cannot edit another admin, and nobody edits the owner", async () => {
    store.rows.workspaceMembers.find((r) => r.userId === PEOPLE.max.id)!.role = "admin";
    store.rows.authMembers.find((r) => r.userId === PEOPLE.max.id)!.role = "admin";
    await refused(
      () => updateMemberVisibility(deps(), as("adam"), { memberId: memberId("max", "ws-a"), canViewOthersTime: true }),
      "owner-required",
    );
    await refused(
      () => updateMemberVisibility(deps(), as("adam"), { memberId: memberId("olivia", "ws-a"), canViewOthersTime: false }),
      "cannot-modify-owner",
    );
  });

  it("nobody edits their own flags — an admin granting themselves money included", async () => {
    await refused(
      () => updateMemberVisibility(deps(), as("adam"), { memberId: memberId("adam", "ws-a"), canViewOthersMoney: true }),
      "cannot-modify-self",
    );
    await refused(
      () => updateMemberVisibility(deps(), as("mia"), { memberId: memberId("mia", "ws-a"), canViewOthersTime: true }),
      "cannot-modify-self",
    );
    assert.equal(recordsOf(store, "adam", "ws-a").mirror?.canViewOthersMoney, false);
  });

  it("a plain member edits nothing", async () => {
    await refused(
      () => updateMemberVisibility(deps(), as("mia"), { memberId: memberId("max", "ws-a"), canViewOthersTime: true }),
      "admin-required",
    );
  });

  it("cross-workspace ids answer NOT_FOUND", async () => {
    await notFound(() =>
      updateMemberVisibility(deps(), as("olivia"), { memberId: memberId("ben", "ws-b"), canViewOthersMoney: true }),
    );
    assert.equal(recordsOf(store, "ben", "ws-b").mirror?.canViewOthersMoney, false);
  });
});

describe("members.remove", () => {
  it("owner removes admins and members", async () => {
    await removeMember(deps(), as("olivia"), { memberId: memberId("adam", "ws-a") });
    assert.deepEqual(recordsOf(store, "adam", "ws-a"), { mirror: undefined, member: undefined });
    assert.deepEqual(recorded.stopped, [{ userId: PEOPLE.adam.id, workspaceId: "ws-a" }]);
    // The workspace hears it, and so does the removed person, who is no longer
    // in the workspace fan-out.
    assert.deepEqual(recorded.user, [
      { userId: PEOPLE.adam.id, event: { kind: "membership.changed", workspaceId: "ws-a", reason: "removed" } },
    ]);
    assert.equal(recorded.workspace[0]?.workspaceId, "ws-a");
  });

  it("admin removes role=member rows only", async () => {
    await removeMember(deps(), as("adam"), { memberId: memberId("mia", "ws-a") });
    assert.equal(recordsOf(store, "mia", "ws-a").mirror, undefined);

    store.rows.workspaceMembers.find((r) => r.userId === PEOPLE.max.id)!.role = "admin";
    await refused(() => removeMember(deps(), as("adam"), { memberId: memberId("max", "ws-a") }), "owner-required");
    await refused(
      () => removeMember(deps(), as("adam"), { memberId: memberId("olivia", "ws-a") }),
      "cannot-modify-owner",
    );
  });

  it("a member removes nobody; nobody removes themselves through remove", async () => {
    await refused(() => removeMember(deps(), as("mia"), { memberId: memberId("max", "ws-a") }), "admin-required");
    await refused(() => removeMember(deps(), as("mia"), { memberId: memberId("mia", "ws-a") }), "cannot-modify-self");
    await refused(() => removeMember(deps(), as("adam"), { memberId: memberId("adam", "ws-a") }), "cannot-modify-self");
    await refused(
      () => removeMember(deps(), as("olivia"), { memberId: memberId("olivia", "ws-a") }),
      "cannot-modify-self",
    );
  });

  it("the last owner cannot be removed, even by another owner-in-waiting", async () => {
    store.rows.workspaceMembers.find((r) => r.userId === PEOPLE.adam.id)!.role = "owner";
    // Two owners: one may remove the other…
    await removeMember(deps(), as("adam"), { memberId: memberId("olivia", "ws-a") });
    assert.equal(recordsOf(store, "olivia", "ws-a").mirror, undefined);
    // …and the survivor is now the last owner.
    const owners = store.rows.workspaceMembers.filter((r) => r.workspaceId === "ws-a" && r.role === "owner");
    assert.equal(owners.length, 1);
  });

  it("an existing and a non-existing foreign member give the same answer (no ordering oracle)", async () => {
    for (const person of ["mia", "adam", "olivia"] as const) {
      const real = await notFound(() => removeMember(deps(), as(person), { memberId: memberId("ben", "ws-b") }));
      const fake = await notFound(() => removeMember(deps(), as(person), { memberId: "m-ghost-ws-b" }));
      assert.equal(real, fake, `${person} can tell a real foreign member from a fake one`);
    }
    assert.ok(recordsOf(store, "ben", "ws-b").mirror);
    assert.deepEqual(recorded.stopped, []);
  });
});

describe("members.leave", () => {
  it("members and admins leave, landing in their next workspace", async () => {
    const result = await leaveWorkspace(deps(), {
      ...as("mia"),
      user: PEOPLE.mia,
      sessionId: "s-mia",
      activeWorkspaceId: "ws-a",
    });
    assert.equal(result.nextWorkspaceId, `personal-${PEOPLE.mia.id}`);
    assert.deepEqual(recordsOf(store, "mia", "ws-a"), { mirror: undefined, member: undefined });
    assert.deepEqual(recorded.stopped, [{ userId: PEOPLE.mia.id, workspaceId: "ws-a" }]);
    assert.equal(store.rows.authSessions.find((s) => s.id === "s-mia")?.activeOrganizationId, result.nextWorkspaceId);
    assert.equal(recorded.user[0]?.userId, PEOPLE.mia.id);

    await leaveWorkspace(deps(), { ...as("adam"), user: PEOPLE.adam, sessionId: null, activeWorkspaceId: null });
    assert.equal(recordsOf(store, "adam", "ws-a").mirror, undefined);
  });

  it("the last owner cannot leave while others remain", async () => {
    await refused(
      () => leaveWorkspace(deps(), { ...as("olivia"), user: PEOPLE.olivia, sessionId: null, activeWorkspaceId: null }),
      "transfer-ownership-first",
    );
    assert.ok(recordsOf(store, "olivia", "ws-a").mirror);
  });

  it("an owner may leave when another owner remains", async () => {
    store.rows.workspaceMembers.find((r) => r.userId === PEOPLE.adam.id)!.role = "owner";
    await leaveWorkspace(deps(), { ...as("olivia"), user: PEOPLE.olivia, sessionId: null, activeWorkspaceId: null });
    assert.equal(recordsOf(store, "olivia", "ws-a").mirror, undefined);
  });

  it("the only member cannot leave", async () => {
    store.rows.workspaceMembers = store.rows.workspaceMembers.filter(
      (r) => r.workspaceId !== "ws-b" || r.userId === PEOPLE.bob.id,
    );
    await refused(
      () => leaveWorkspace(deps(), { ...as("bob", "ws-b"), user: PEOPLE.bob, sessionId: null, activeWorkspaceId: null }),
      "workspace-has-no-other-members",
    );
  });
});

describe("members.transferOwnership", () => {
  it("leaves exactly the target as owner (flags forced on) and the previous owner an admin with flags unchanged", async () => {
    await transferOwnership(deps(), as("olivia"), { memberId: memberId("mia", "ws-a") });
    const mia = recordsOf(store, "mia", "ws-a");
    const olivia = recordsOf(store, "olivia", "ws-a");
    assert.equal(mia.mirror?.role, "owner");
    assert.equal(mia.member?.role, "owner");
    assert.equal(mia.mirror?.canViewOthersTime, true);
    assert.equal(mia.mirror?.canViewOthersMoney, true);
    assert.equal(olivia.mirror?.role, "admin");
    assert.equal(olivia.member?.role, "admin");
    assert.equal(olivia.mirror?.canViewOthersTime, true);
    assert.equal(olivia.mirror?.canViewOthersMoney, true);
    const owners = store.rows.workspaceMembers.filter((r) => r.workspaceId === "ws-a" && r.role === "owner");
    assert.equal(owners.length, 1);
    assert.equal(recorded.workspace[0]?.event.kind, "membership.changed");
  });

  it("only an owner transfers, never to themselves, never across workspaces", async () => {
    await refused(() => transferOwnership(deps(), as("adam"), { memberId: memberId("mia", "ws-a") }), "owner-required");
    await refused(() => transferOwnership(deps(), as("mia"), { memberId: memberId("mia", "ws-a") }), "owner-required");
    await refused(
      () => transferOwnership(deps(), as("olivia"), { memberId: memberId("olivia", "ws-a") }),
      "cannot-modify-self",
    );
    await notFound(() => transferOwnership(deps(), as("olivia"), { memberId: memberId("ben", "ws-b") }));
    assert.equal(recordsOf(store, "ben", "ws-b").mirror?.role, "member");
  });

  it("never goes to a half-removed person — that would leave the workspace with no owner", async () => {
    // A removal a crash cut in half: the mirror is gone, the `member` row stays.
    store.rows.workspaceMembers = store.rows.workspaceMembers.filter(
      (r) => !(r.workspaceId === "ws-a" && r.userId === PEOPLE.mia.id),
    );
    await notFound(() => transferOwnership(deps(), as("olivia"), { memberId: memberId("mia", "ws-a") }));
    await notFound(() =>
      updateMemberRole(deps(), as("olivia"), { memberId: memberId("mia", "ws-a"), role: "admin" }),
    );
    await notFound(() =>
      updateMemberVisibility(deps(), as("olivia"), {
        memberId: memberId("mia", "ws-a"),
        canViewOthersMoney: true,
      }),
    );
    const owners = store.rows.workspaceMembers.filter((r) => r.workspaceId === "ws-a" && r.role === "owner");
    assert.deepEqual(owners.map((r) => r.userId), [PEOPLE.olivia.id]);
    assert.equal(recordsOf(store, "olivia", "ws-a").member?.role, "owner");
    assert.equal(recordsOf(store, "mia", "ws-a").member?.role, "member");
    // Finishing the removal is still possible.
    await removeMember(deps(), as("olivia"), { memberId: memberId("mia", "ws-a") });
    assert.equal(recordsOf(store, "mia", "ws-a").member, undefined);
  });
});

describe("members.list", () => {
  it("every member may read it; it names only people in the caller's workspace", async () => {
    const rows = await listMembers(deps(), as("mia"));
    assert.deepEqual(
      rows.map((r) => [r.name, r.role, r.isSelf]),
      [
        ["Olivia", "owner", false],
        ["Adam", "admin", false],
        ["Mia", "member", true],
        ["Max", "member", false],
      ],
    );
    assert.equal(rows[0]?.memberId, memberId("olivia", "ws-a"));
    assert.equal(rows.some((r) => r.userId === PEOPLE.ben.id), false);
  });
});

describe("invitations: create, list, cancel", () => {
  it("owner invites admin or member; admin invites member only; member invites nobody", async () => {
    const admin = await createInvitation(inviteDeps(), as("olivia"), { email: "a@new.test", role: "admin" });
    assert.equal(admin.invitation.role, "admin");
    await createInvitation(inviteDeps(), as("adam"), { email: "m@new.test", role: "member" });
    await refused(
      () => createInvitation(inviteDeps(), as("adam"), { email: "x@new.test", role: "admin" }),
      "owner-required",
    );
    await refused(
      () => createInvitation(inviteDeps(), as("mia"), { email: "x@new.test", role: "member" }),
      "admin-required",
    );
  });

  it("nobody invites an owner — not even an owner", async () => {
    assert.equal(inviteMemberSchema.safeParse({ email: "o@new.test", role: "owner" }).success, false);
    await refused(
      () => createInvitation(inviteDeps(), as("olivia"), { email: "o@new.test", role: "owner" }),
      "owner-required",
    );
    assert.equal(store.rows.authInvitations.length, 0);
  });

  it("list and invite links are for owners and admins only", async () => {
    await createInvitation(inviteDeps(), as("olivia"), { email: "a@new.test", role: "member" });
    assert.equal((await listInvitations(inviteDeps(), as("olivia"))).length, 1);
    assert.equal((await listInvitations(inviteDeps(), as("adam"))).length, 1);
    await refused(() => listInvitations(inviteDeps(), as("mia")), "admin-required");
    // Another workspace's owner sees none of them.
    assert.deepEqual(await listInvitations(inviteDeps(), as("bob", "ws-b")), []);
  });

  it("owner and admin cancel; member and other workspaces cannot", async () => {
    const one = await createInvitation(inviteDeps(), as("olivia"), { email: "a@new.test", role: "member" });
    const two = await createInvitation(inviteDeps(), as("olivia"), { email: "b@new.test", role: "member" });
    await notFound(() => cancelInvitation(inviteDeps(), as("bob", "ws-b"), { invitationId: one.invitation.id }));
    await refused(() => cancelInvitation(inviteDeps(), as("mia"), { invitationId: one.invitation.id }), "admin-required");
    await cancelInvitation(inviteDeps(), as("adam"), { invitationId: one.invitation.id });
    await cancelInvitation(inviteDeps(), as("olivia"), { invitationId: two.invitation.id });
    assert.deepEqual(
      store.rows.authInvitations.map((r) => r.status),
      ["canceled", "canceled"],
    );
    // Cancelling again is a no-op, not an error.
    await cancelInvitation(inviteDeps(), as("olivia"), { invitationId: two.invitation.id });
  });
});

describe("permissionsFor — what clients draw buttons from", () => {
  it("matches the server matrix", () => {
    const closed = { canViewOthersTime: false, canViewOthersMoney: false };
    assert.deepEqual(permissionsFor("member", closed), {
      inviteMembers: false,
      inviteAdmins: false,
      changeRoles: false,
      editTimeVisibility: false,
      editMoneyVisibility: false,
      removeMembers: false,
      transferOwnership: false,
      invoices: false,
      viewOthersTime: false,
      viewOthersMoney: false,
    });
    const admin = permissionsFor("admin", closed);
    assert.equal(admin.inviteMembers, true);
    assert.equal(admin.inviteAdmins, false);
    assert.equal(admin.changeRoles, false);
    assert.equal(admin.editMoneyVisibility, false);
    assert.equal(admin.invoices, false);
    const owner = permissionsFor("owner", closed);
    assert.equal(owner.viewOthersMoney, true, "owner flags are read from the role");
    assert.equal(owner.invoices, true);
  });
});
