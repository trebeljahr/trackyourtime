// Inviting somebody into a workspace, and them answering.
//
// Invitation rows live in better-auth's own `invitation` collection with the
// plugin's field names and statuses, so the account-deletion cascade (which
// removes invitations a person sent and invitations addressed to them) keeps
// working without knowing trackyourtime ever wrote one. Everything else about
// them is decided here, not by the plugin: its endpoints answer 404 over HTTP.
//
// ── What proves the invitee is the invitee ──────────────────────────────
//
// `accept` requires the signed-in account's email to equal the invited address
// (case-insensitively), and it does NOT require that email to be verified.
// The proof is possession of the invitation id: 96 bits from a CSPRNG
// (`newInvitationId`), delivered to that inbox — or, with no mail transport
// configured, handed over by the inviter from the link the UI shows them.
// Requiring verification would make invitations unusable on exactly the
// self-hosted instances that have no mail transport to verify with, and would
// add nothing on the ones that do, where the link itself only ever reached
// that inbox. The email match is what stops a link forwarded to, or
// intercepted by, somebody else from being accepted under their account.
//
// This is also why the id is not the adapter's own ObjectId: an ObjectId is a
// timestamp, a per-process constant and a counter, so anybody who has seen one
// id this process minted could enumerate its neighbours.
import { randomBytes } from "node:crypto";
import type {
  InvitableRole,
  InvitationPreview,
  InvitationStatus,
  InviteResult,
  PendingInvitation,
  SyncEvent,
  WorkspaceRole,
} from "@starter/shared";
import { assertAllowed, membershipNotFound, membershipRefused } from "./errors.js";
import { addMember } from "./lifecycle.js";
import {
  refuseInvitationManagement,
  refuseInvite,
  type MembershipActor,
} from "./permissions.js";
import { asDate, asId, type MembershipRowStore, type StoredRow } from "./store.js";

/**
 * How long an invitation stays acceptable. The same number is handed to the
 * organization plugin in `auth/auth.ts` (`invitationExpiresIn`), so the two
 * can never describe different lifetimes for one row.
 */
export const INVITATION_TTL_SECONDS = 48 * 60 * 60;

/** Pending, unexpired invitations one workspace may hold at once. */
export const MAX_PENDING_INVITATIONS = 50;

/** Invitations one person may send (or re-send) per hour, across workspaces. */
export const INVITES_PER_HOUR = 20;

/** 24 hex characters — the shape of an ObjectId, the entropy of a CSPRNG. */
export function newInvitationId(): string {
  return randomBytes(12).toString("hex");
}

/**
 * The link an invitee opens. A query parameter rather than a path segment:
 * the web app is a static export, which cannot serve `/invite/<id>` for ids
 * that did not exist at build time.
 */
export function buildInvitationUrl(id: string, frontendUrl: string): string {
  return `${frontendUrl.replace(/\/+$/, "")}/invite/?id=${encodeURIComponent(id)}`;
}

export type InvitationEmail = {
  to: string;
  /** Who sent it — the production sender reads their language as a fallback. */
  inviterId: string;
  workspaceName: string;
  inviterName: string;
  url: string;
};

export type InvitationDeps = {
  store: MembershipRowStore;
  now: () => Date;
  newId: () => string;
  frontendUrl: string;
  /** True when a send would really be delivered rather than logged. */
  emailConfigured: () => boolean;
  sendInvitationEmail: (email: InvitationEmail) => Promise<void>;
  log: (message: string) => void;
  /** Charge one invite to this person's hourly budget; false when spent. */
  consumeInviteBudget: (inviterId: string) => Promise<boolean>;
  publishWorkspace: (workspaceId: string, event: SyncEvent) => void;
  publishUser: (userId: string, event: SyncEvent) => void;
};

export type InvitationActor = MembershipActor & { workspaceId: string };

export type SignedInUser = { id: string; email: string; name?: string | null };

const invitationChanged = (workspaceId: string): SyncEvent => ({
  kind: "membership.changed",
  workspaceId,
  reason: "invitation",
});

/**
 * An invitation's role, read defensively. A row written by anything but this
 * module (the plugin before its endpoints were closed, say) might say "owner"
 * or "admin,owner"; neither can be accepted into anything above a member.
 */
const invitableRole = (value: unknown): InvitableRole =>
  value === "admin" ? "admin" : "member";

const normalizeEmail = (value: unknown): string =>
  typeof value === "string" ? value.trim().toLowerCase() : "";

function statusOf(row: StoredRow, now: Date): InvitationStatus {
  switch (row.status) {
    case "pending":
      return asDate(row.expiresAt).getTime() <= now.getTime() ? "expired" : "pending";
    case "accepted":
    case "rejected":
    case "canceled":
      return row.status;
    default:
      return "canceled";
  }
}

async function nameOfUser(store: MembershipRowStore, userId: unknown): Promise<string> {
  const id = asId(userId);
  if (!id) return "";
  const [user] = await store.find("authUsers", { id });
  if (!user) return "";
  const name = typeof user.name === "string" ? user.name.trim() : "";
  return name || (typeof user.email === "string" ? user.email : "");
}

async function nameOfWorkspace(store: MembershipRowStore, workspaceId: string): Promise<string> {
  const [org] = await store.find("authOrganizations", { id: workspaceId });
  return typeof org?.name === "string" ? org.name : "";
}

function toPending(
  row: StoredRow,
  inviterName: string,
  frontendUrl: string,
): PendingInvitation {
  const id = asId(row.id) ?? "";
  return {
    id,
    email: normalizeEmail(row.email),
    role: invitableRole(row.role),
    inviterName,
    expiresAt: asDate(row.expiresAt).toISOString(),
    inviteUrl: buildInvitationUrl(id, frontendUrl),
  };
}

/**
 * Invite `email` into the caller's workspace.
 *
 * An existing pending invitation for the same address is refreshed — new
 * expiry, the new role, this inviter — and sent again, rather than refused:
 * "send it again" is what a person pressing invite twice means.
 *
 * With no mail transport, or a send that fails, the invitation is kept, the
 * link goes to the server log, and `emailSent: false` tells the inviter to
 * hand the link over themselves. The link is only ever returned to an owner
 * or admin of this workspace — the only callers who get this far.
 */
export async function createInvitation(
  deps: InvitationDeps,
  actor: InvitationActor,
  input: { email: string; role: WorkspaceRole },
): Promise<InviteResult> {
  assertAllowed(refuseInvite(actor, input.role));
  const role = invitableRole(input.role);
  const email = normalizeEmail(input.email);
  const { workspaceId } = actor;
  const now = deps.now();

  const users = await deps.store.find("authUsers", { email });
  for (const user of users) {
    const userId = asId(user.id);
    if (!userId) continue;
    const mirror = await deps.store.find("workspaceMembers", { workspaceId, userId });
    if (mirror.length > 0) throw membershipRefused("already-member");
  }

  // Charged before any row is written, re-sends included: re-sending is the
  // cheap way to mail somebody forty times.
  if (!(await deps.consumeInviteBudget(actor.userId))) {
    throw membershipRefused("invite-limit-reached");
  }

  const expiresAt = new Date(now.getTime() + INVITATION_TTL_SECONDS * 1000);
  const pending = await deps.store.find("authInvitations", {
    organizationId: workspaceId,
    status: "pending",
  });
  const existing = pending.find((row) => normalizeEmail(row.email) === email);

  let stored: StoredRow;
  if (existing) {
    const id = asId(existing.id) ?? "";
    await deps.store.updateMany(
      "authInvitations",
      { id, organizationId: workspaceId },
      { role, inviterId: actor.userId, expiresAt },
    );
    stored = { ...existing, role, inviterId: actor.userId, expiresAt };
  } else {
    const live = pending.filter((row) => statusOf(row, now) === "pending").length;
    if (live >= MAX_PENDING_INVITATIONS) throw membershipRefused("invite-limit-reached");
    stored = await deps.store.insertOne("authInvitations", {
      id: deps.newId(),
      organizationId: workspaceId,
      email,
      role,
      status: "pending",
      expiresAt,
      createdAt: now,
      inviterId: actor.userId,
    });
  }

  const inviterName = await nameOfUser(deps.store, actor.userId);
  const invitation = toPending(stored, inviterName, deps.frontendUrl);
  const emailSent = await deliver(deps, {
    to: email,
    inviterId: actor.userId,
    workspaceName: await nameOfWorkspace(deps.store, workspaceId),
    inviterName,
    url: invitation.inviteUrl,
  });

  deps.publishWorkspace(workspaceId, invitationChanged(workspaceId));
  return { invitation, emailSent };
}

async function deliver(deps: InvitationDeps, email: InvitationEmail): Promise<boolean> {
  if (!deps.emailConfigured()) {
    deps.log(`[invite] No mail transport — invitation URL for ${email.to}: ${email.url}`);
    return false;
  }
  try {
    await deps.sendInvitationEmail(email);
    return true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    deps.log(`[invite] Send failed (${reason}) — invitation URL for ${email.to}: ${email.url}`);
    return false;
  }
}

/** The workspace's pending invitations. Owners and admins only. */
export async function listInvitations(
  deps: InvitationDeps,
  actor: InvitationActor,
): Promise<PendingInvitation[]> {
  assertAllowed(refuseInvitationManagement(actor));
  const rows = await deps.store.find("authInvitations", {
    organizationId: actor.workspaceId,
    status: "pending",
  });
  const names = new Map<string, string>();
  const result: PendingInvitation[] = [];
  for (const row of rows) {
    const inviterId = asId(row.inviterId) ?? "";
    if (!names.has(inviterId)) names.set(inviterId, await nameOfUser(deps.store, inviterId));
    result.push(toPending(row, names.get(inviterId) ?? "", deps.frontendUrl));
  }
  return result.sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));
}

export async function cancelInvitation(
  deps: InvitationDeps,
  actor: InvitationActor,
  input: { invitationId: string },
): Promise<{ ok: true }> {
  const [row] = await deps.store.find("authInvitations", {
    id: input.invitationId,
    organizationId: actor.workspaceId,
  });
  if (!row) throw membershipNotFound();
  assertAllowed(refuseInvitationManagement(actor));

  if (row.status === "canceled") return { ok: true };
  if (row.status !== "pending") throw membershipRefused("invitation-not-pending");
  await deps.store.updateMany(
    "authInvitations",
    { id: input.invitationId, organizationId: actor.workspaceId },
    { status: "canceled" },
  );
  deps.publishWorkspace(actor.workspaceId, invitationChanged(actor.workspaceId));
  return { ok: true };
}

async function findInvitation(store: MembershipRowStore, id: string): Promise<StoredRow> {
  const [row] = await store.find("authInvitations", { id });
  if (!row) throw membershipNotFound();
  return row;
}

/**
 * What the invite page shows before anybody signs in: whose workspace, who
 * sent it, which address, which role, and whether it can still be accepted.
 * Never who else is in the workspace.
 */
export async function previewInvitation(
  deps: Pick<InvitationDeps, "store" | "now">,
  input: { id: string },
): Promise<InvitationPreview> {
  const row = await findInvitation(deps.store, input.id);
  const workspaceId = asId(row.organizationId) ?? "";
  return {
    id: asId(row.id) ?? input.id,
    workspaceName: await nameOfWorkspace(deps.store, workspaceId),
    inviterName: await nameOfUser(deps.store, row.inviterId),
    email: normalizeEmail(row.email),
    role: invitableRole(row.role),
    status: statusOf(row, deps.now()),
  };
}

/** The invitation, refused unless it was addressed to this account. */
async function invitationFor(
  store: MembershipRowStore,
  user: SignedInUser,
  id: string,
): Promise<{ row: StoredRow; workspaceId: string }> {
  const row = await findInvitation(store, id);
  const workspaceId = asId(row.organizationId);
  if (!workspaceId) throw membershipNotFound();
  // Checked BEFORE the status, so somebody holding a link that was not meant
  // for them learns nothing about whether it is still live.
  if (normalizeEmail(row.email) !== normalizeEmail(user.email)) {
    throw membershipRefused("invitation-email-mismatch");
  }
  return { row, workspaceId };
}

/**
 * Accept: join the workspace with the invited role and closed visibility, mark
 * the invitation accepted, and point the accepting session at the workspace.
 *
 * Idempotent. Accepting again, or accepting while already a member, answers
 * the workspace id and changes nothing about the existing membership. The
 * membership is written before the invitation is marked, so a crash between
 * the two leaves a pending invitation that a retry simply finishes.
 */
export async function acceptInvitation(
  deps: InvitationDeps,
  user: SignedInUser,
  input: { id: string; sessionId: string | null },
): Promise<{ workspaceId: string }> {
  const { row, workspaceId } = await invitationFor(deps.store, user, input.id);
  const now = deps.now();
  const status = statusOf(row, now);
  const alreadyIn =
    (await deps.store.find("workspaceMembers", { workspaceId, userId: user.id })).length > 0;

  if (alreadyIn && (status === "accepted" || status === "pending")) {
    if (status === "pending") await markInvitation(deps.store, input.id, "accepted");
    await pointSessionAt(deps.store, input.sessionId, user.id, workspaceId);
    return { workspaceId };
  }
  // Accepted but no longer a member means they were removed (or left) since:
  // the old link must not walk them back in.
  if (status !== "pending") throw membershipRefused("invitation-not-pending");

  await addMember(deps.store, {
    workspaceId,
    userId: user.id,
    name: (user.name ?? "").trim() || user.email,
    role: invitableRole(row.role),
    now,
  });
  await markInvitation(deps.store, input.id, "accepted");
  await pointSessionAt(deps.store, input.sessionId, user.id, workspaceId);

  const event: SyncEvent = { kind: "membership.changed", workspaceId, reason: "joined" };
  deps.publishWorkspace(workspaceId, event);
  deps.publishUser(user.id, event);
  return { workspaceId };
}

export async function declineInvitation(
  deps: InvitationDeps,
  user: SignedInUser,
  input: { id: string },
): Promise<{ ok: true }> {
  const { row, workspaceId } = await invitationFor(deps.store, user, input.id);
  if (row.status === "rejected") return { ok: true };
  if (row.status !== "pending") throw membershipRefused("invitation-not-pending");
  await markInvitation(deps.store, input.id, "rejected");
  deps.publishWorkspace(workspaceId, invitationChanged(workspaceId));
  return { ok: true };
}

async function markInvitation(
  store: MembershipRowStore,
  id: string,
  status: "accepted" | "rejected",
): Promise<void> {
  await store.updateMany("authInvitations", { id }, { status });
}

async function pointSessionAt(
  store: MembershipRowStore,
  sessionId: string | null,
  userId: string,
  workspaceId: string,
): Promise<void> {
  if (!sessionId) return;
  await store.updateMany(
    "authSessions",
    { id: sessionId, userId },
    { activeOrganizationId: workspaceId },
  );
}
