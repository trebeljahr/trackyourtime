/**
 * Invitations: creating one, the email it sends, and answering it.
 *
 * Driven through `services/membership/invitations.ts` against in-memory rows
 * shaped like better-auth's `invitation` collection, which account deletion
 * also cleans up — so the rows are written with the plugin's field names.
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { TRPCError } from "@trpc/server";
import { inviteMemberSchema } from "@starter/shared";
import {
  INVITATION_TTL_SECONDS,
  MAX_PENDING_INVITATIONS,
  acceptInvitation,
  buildInvitationUrl,
  createInvitation,
  declineInvitation,
  newInvitationId,
  previewInvitation,
} from "../services/membership/invitations.js";
import { createInviteBudget } from "../services/membership/invite-rate-limit.js";
import { buildWorkspaceInvitationEmail, headerSafe } from "../services/email.js";
import {
  NOW,
  PEOPLE,
  actor,
  invitationDepsFor,
  recorder,
  recordsOf,
  seededStore,
  type Recorded,
} from "./support/membership-fixture.js";
import type { MemoryMembershipStore } from "./support/memory-membership-store.js";

let store: MemoryMembershipStore;
let recorded: Recorded;

beforeEach(() => {
  store = seededStore();
  recorded = recorder();
});

const code = async (run: () => Promise<unknown>): Promise<string> => {
  let out = "";
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof TRPCError);
    out = `${error.code}${error.message && error.code === "FORBIDDEN" ? `:${error.message}` : ""}`;
    return true;
  });
  return out;
};

const inviteNina = async (
  options: Parameters<typeof invitationDepsFor>[2] = {},
  role: "admin" | "member" = "member",
) =>
  createInvitation(invitationDepsFor(store, recorded, options), actor(store, "olivia", "ws-a"), {
    email: PEOPLE.newcomer.email,
    role,
  });

describe("invitations.create", () => {
  it("with no mail transport keeps the invitation, logs the link and returns it", async () => {
    const result = await inviteNina();
    assert.equal(result.emailSent, false);
    const id = result.invitation.id;
    assert.equal(result.invitation.inviteUrl, `https://trackyourtime.test/invite/?id=${id}`);
    assert.equal(recorded.emails.length, 0);
    assert.ok(recorded.logs.some((line) => line.includes(result.invitation.inviteUrl)));
    const [row] = store.rows.authInvitations;
    assert.equal(row?.status, "pending");
    assert.equal(row?.organizationId, "ws-a");
    assert.equal(row?.inviterId, PEOPLE.olivia.id);
    assert.equal(
      (row?.expiresAt as Date).getTime() - NOW.getTime(),
      INVITATION_TTL_SECONDS * 1000,
    );
    assert.deepEqual(recorded.workspace[0]?.event, {
      kind: "membership.changed",
      workspaceId: "ws-a",
      reason: "invitation",
    });
  });

  it("sends the email when a transport exists, and falls back to the link when the send throws", async () => {
    const sent = await inviteNina({ emailConfigured: true });
    assert.equal(sent.emailSent, true);
    assert.equal(recorded.emails[0]?.url, sent.invitation.inviteUrl);
    assert.equal(recorded.emails[0]?.workspaceName, "Acme");
    assert.equal(recorded.emails[0]?.inviterName, "Olivia");

    const failed = await createInvitation(
      invitationDepsFor(store, recorded, { emailConfigured: true, sendFails: true }),
      actor(store, "olivia", "ws-a"),
      { email: "other@new.test", role: "member" },
    );
    assert.equal(failed.emailSent, false);
    assert.equal(store.rows.authInvitations.length, 2, "a failed send must keep the invitation");
  });

  it("normalises the address and refuses an existing member", async () => {
    const parsed = inviteMemberSchema.parse({ email: "  Mia@ACME.test ", role: "member" });
    assert.equal(parsed.email, "mia@acme.test");
    assert.equal(
      await code(() =>
        createInvitation(invitationDepsFor(store, recorded), actor(store, "olivia", "ws-a"), parsed),
      ),
      "FORBIDDEN:already-member",
    );
    // A member of ANOTHER workspace is simply invitable.
    await createInvitation(invitationDepsFor(store, recorded), actor(store, "olivia", "ws-a"), {
      email: PEOPLE.ben.email,
      role: "member",
    });
  });

  it("re-inviting a pending address refreshes and re-sends the same invitation", async () => {
    const first = await inviteNina();
    const later = new Date(NOW.getTime() + 60 * 60 * 1000);
    const second = await inviteNina({ now: () => later, emailConfigured: true }, "admin");
    assert.equal(second.invitation.id, first.invitation.id);
    assert.equal(store.rows.authInvitations.length, 1);
    assert.equal(second.invitation.role, "admin");
    assert.equal(second.emailSent, true);
    assert.equal(
      (store.rows.authInvitations[0]?.expiresAt as Date).getTime(),
      later.getTime() + INVITATION_TTL_SECONDS * 1000,
    );
  });

  it("caps pending invitations per workspace", async () => {
    for (let i = 0; i < MAX_PENDING_INVITATIONS; i += 1) {
      await createInvitation(invitationDepsFor(store, recorded), actor(store, "olivia", "ws-a"), {
        email: `p${i}@new.test`,
        role: "member",
      });
    }
    assert.equal(
      await code(() => inviteNina()),
      "FORBIDDEN:invite-limit-reached",
    );
    // Another workspace has its own cap.
    await createInvitation(invitationDepsFor(store, recorded), actor(store, "bob", "ws-b"), {
      email: PEOPLE.newcomer.email,
      role: "member",
    });
  });

  it("refuses once the inviter's budget is spent, re-sends included", async () => {
    assert.equal(
      await code(() => inviteNina({ budget: async () => false })),
      "FORBIDDEN:invite-limit-reached",
    );
    assert.equal(store.rows.authInvitations.length, 0);
  });

  it("ids are 96 CSPRNG bits, never an adapter ObjectId", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newInvitationId()));
    assert.equal(ids.size, 200);
    for (const id of ids) assert.match(id, /^[0-9a-f]{24}$/);
    assert.equal(buildInvitationUrl("abc", "https://x.test//"), "https://x.test/invite/?id=abc");
  });
});

describe("the invite budget", () => {
  it("allows the limit per window in memory, per inviter, and resets next window", async () => {
    const budget = createInviteBudget({ limit: 3, windowMs: 1000, redis: () => null });
    const at = 10_000;
    assert.deepEqual(
      [await budget("a", at), await budget("a", at), await budget("a", at), await budget("a", at)],
      [true, true, true, false],
    );
    assert.equal(await budget("b", at), true);
    assert.equal(await budget("a", at + 1000), true);
  });
});

describe("the invitation email", () => {
  const hostile = "<script>alert(1)</script>\r\nBcc: victim@x.test";

  it("escapes both names in HTML and flattens them in the subject", () => {
    const email = buildWorkspaceInvitationEmail({
      to: "nina@elsewhere.test",
      workspaceName: hostile,
      inviterName: `${hostile} "quoted"`,
      url: "https://trackyourtime.test/invite/?id=abc&x=1",
      expiresInHours: 48,
    });
    assert.equal(email.html?.includes("<script>"), false);
    assert.ok(email.html?.includes("&lt;script&gt;"));
    assert.ok(email.html?.includes('href="https://trackyourtime.test/invite/?id=abc&amp;x=1"'));
    assert.equal(/[\r\n]/.test(email.subject), false, "a header must not carry a line break");
    assert.ok(email.subject.includes("Track Your Time"));
    assert.ok(email.text.includes("https://trackyourtime.test/invite/?id=abc&x=1"));
    assert.ok(email.text.includes("48"));
  });

  it("is translated when the caller knows the recipient's language", () => {
    const email = buildWorkspaceInvitationEmail({
      to: "n@x.test",
      workspaceName: "Acme",
      inviterName: "Olivia",
      url: "https://x.test/invite/?id=1",
      locale: "de",
      expiresInHours: 48,
    });
    assert.match(email.subject, /eingeladen/);
    assert.match(email.html ?? "", /Einladung annehmen/);
  });

  it("headerSafe strips control characters and caps length", () => {
    assert.equal(headerSafe("a\r\nb c"), "a b c");
    assert.equal(headerSafe("x".repeat(300), 10).length, 10);
  });
});

describe("invitations.preview", () => {
  it("answers signed out with names, address, role and status — nothing else", async () => {
    const { invitation } = await inviteNina({}, "admin");
    const preview = await previewInvitation({ store, now: () => NOW }, { id: invitation.id });
    assert.deepEqual(preview, {
      id: invitation.id,
      workspaceName: "Acme",
      inviterName: "Olivia",
      email: PEOPLE.newcomer.email,
      role: "admin",
      status: "pending",
    });
    const expired = await previewInvitation(
      { store, now: () => new Date(NOW.getTime() + (INVITATION_TTL_SECONDS + 1) * 1000) },
      { id: invitation.id },
    );
    assert.equal(expired.status, "expired");
    assert.equal(await code(() => previewInvitation({ store, now: () => NOW }, { id: "nope" })), "NOT_FOUND");
  });
});

describe("invitations.accept", () => {
  const acceptAs = (
    user: { id: string; email: string; name?: string },
    id: string,
    now: Date = NOW,
  ) =>
    acceptInvitation(invitationDepsFor(store, recorded, { now: () => now }), user, {
      id,
      sessionId: user.id === PEOPLE.newcomer.id ? "s-new" : null,
    });

  it("the invited address joins with closed flags, marks it accepted and points the session", async () => {
    const { invitation } = await inviteNina({}, "admin");
    const result = await acceptAs({ ...PEOPLE.newcomer, email: "NINA@Elsewhere.test" }, invitation.id);
    assert.deepEqual(result, { workspaceId: "ws-a" });
    const { mirror, member } = recordsOf(store, "newcomer", "ws-a");
    assert.equal(member?.role, "admin");
    assert.equal(mirror?.role, "admin");
    assert.equal(mirror?.canViewOthersTime, false);
    assert.equal(mirror?.canViewOthersMoney, false, "an invited admin must not see money");
    assert.equal(store.rows.authInvitations[0]?.status, "accepted");
    assert.equal(store.rows.authSessions.find((s) => s.id === "s-new")?.activeOrganizationId, "ws-a");
    assert.ok(
      recorded.user.some(
        (e) => e.userId === PEOPLE.newcomer.id && e.event.kind === "membership.changed",
      ),
      "the accepting user's devices must hear it",
    );
    assert.ok(recorded.workspace.some((e) => e.workspaceId === "ws-a"));

    // Twice: same answer, nothing new.
    assert.deepEqual(await acceptAs(PEOPLE.newcomer, invitation.id), { workspaceId: "ws-a" });
    assert.equal(store.rows.workspaceMembers.filter((r) => r.userId === PEOPLE.newcomer.id).length, 1);
  });

  it("a different signed-in account is refused, before anything about the status is revealed", async () => {
    const { invitation } = await inviteNina();
    assert.equal(await code(() => acceptAs(PEOPLE.ben, invitation.id)), "FORBIDDEN:invitation-email-mismatch");
    store.rows.authInvitations[0]!.status = "canceled";
    assert.equal(await code(() => acceptAs(PEOPLE.ben, invitation.id)), "FORBIDDEN:invitation-email-mismatch");
    assert.equal(recordsOf(store, "ben", "ws-a").mirror, undefined);
    assert.equal(
      await code(() => declineInvitation(invitationDepsFor(store, recorded), PEOPLE.ben, { id: invitation.id })),
      "FORBIDDEN:invitation-email-mismatch",
    );
  });

  it("an unknown id is NOT_FOUND", async () => {
    assert.equal(await code(() => acceptAs(PEOPLE.newcomer, "000000000000000000000000")), "NOT_FOUND");
  });

  it("expired, canceled and declined invitations cannot be accepted", async () => {
    const { invitation } = await inviteNina();
    const late = new Date(NOW.getTime() + (INVITATION_TTL_SECONDS + 60) * 1000);
    assert.equal(await code(() => acceptAs(PEOPLE.newcomer, invitation.id, late)), "FORBIDDEN:invitation-not-pending");

    store.rows.authInvitations[0]!.status = "canceled";
    assert.equal(await code(() => acceptAs(PEOPLE.newcomer, invitation.id)), "FORBIDDEN:invitation-not-pending");

    store.rows.authInvitations[0]!.status = "pending";
    await declineInvitation(invitationDepsFor(store, recorded), PEOPLE.newcomer, { id: invitation.id });
    assert.equal(store.rows.authInvitations[0]?.status, "rejected");
    assert.equal(await code(() => acceptAs(PEOPLE.newcomer, invitation.id)), "FORBIDDEN:invitation-not-pending");
    assert.equal(recordsOf(store, "newcomer", "ws-a").mirror, undefined);
  });

  it("an accepted link does not walk a removed person back in", async () => {
    const { invitation } = await inviteNina();
    await acceptAs(PEOPLE.newcomer, invitation.id);
    store.rows.workspaceMembers = store.rows.workspaceMembers.filter((r) => r.userId !== PEOPLE.newcomer.id);
    store.rows.authMembers = store.rows.authMembers.filter((r) => r.userId !== PEOPLE.newcomer.id);
    assert.equal(await code(() => acceptAs(PEOPLE.newcomer, invitation.id)), "FORBIDDEN:invitation-not-pending");
  });

  it("accepting while already a member leaves the existing role alone", async () => {
    const { invitation } = await createInvitation(
      invitationDepsFor(store, recorded),
      actor(store, "bob", "ws-b"),
      { email: PEOPLE.newcomer.email, role: "member" },
    );
    // Somebody (a retry, an earlier invitation) already added Nina as admin.
    store.rows.workspaceMembers.push({
      workspaceId: "ws-b", userId: PEOPLE.newcomer.id, role: "admin",
      canViewOthersTime: false, canViewOthersMoney: false, createdAt: NOW,
    });
    await acceptAs(PEOPLE.newcomer, invitation.id);
    assert.equal(recordsOf(store, "newcomer", "ws-b").mirror?.role, "admin");
    assert.equal(store.rows.authInvitations[0]?.status, "accepted");
  });

  it("a crash between joining and marking the invitation converges on retry", async () => {
    const { invitation } = await inviteNina();
    // Writes: member insert, mirror insert, invitation mark, session.
    store.failOnWrite(3);
    await assert.rejects(() => acceptAs(PEOPLE.newcomer, invitation.id));
    store.failOnWrite(null);
    assert.ok(recordsOf(store, "newcomer", "ws-a").mirror);
    assert.equal(store.rows.authInvitations[0]?.status, "pending");
    await acceptAs(PEOPLE.newcomer, invitation.id);
    assert.equal(store.rows.authInvitations[0]?.status, "accepted");
    assert.equal(store.rows.workspaceMembers.filter((r) => r.userId === PEOPLE.newcomer.id).length, 1);
  });
});
