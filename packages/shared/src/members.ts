// Workspace membership on the wire: who is in a workspace, what each person
// may do there, and the invitations that bring somebody in.
//
// Every rule here is ENFORCED on the server (services/membership/). The
// client reads `WorkspacePermissions` to decide which buttons to draw, never
// to decide what is allowed — a hidden button is a courtesy, a refused
// mutation is the rule.
import { z } from "zod";
import type { WorkspaceRole } from "./types.js";

/**
 * The only role strings a membership may hold, in rank order.
 *
 * better-auth's plugin accepts comma-joined roles ("admin,owner") and grants
 * the union. trackyourtime never writes one and treats any string not in this
 * list as the lowest role, so a stray value can never widen access.
 * `WorkspaceRole` itself is exported from ./types.ts.
 */
export const WORKSPACE_ROLES = ["owner", "admin", "member"] as const satisfies readonly WorkspaceRole[];

/** True only for one of the exact strings in {@link WORKSPACE_ROLES}. */
export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return (
    typeof value === "string" &&
    (WORKSPACE_ROLES as readonly string[]).includes(value)
  );
}

/** Roles an invitation may carry. Ownership only ever moves by transfer. */
export const INVITABLE_ROLES = ["admin", "member"] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

/**
 * Where a client remembers which workspace it is pointed at. Per device, not
 * per session: the extension and Raycast have no say over the web app's
 * session, which is why every request carries an explicit `workspaceId`.
 */
export const ACTIVE_WORKSPACE_STORAGE_KEY = "trackyourtime.active-workspace";

export type WorkspacePermissions = {
  inviteMembers: boolean;
  inviteAdmins: boolean;
  changeRoles: boolean;
  editTimeVisibility: boolean;
  editMoneyVisibility: boolean;
  removeMembers: boolean;
  transferOwnership: boolean;
  invoices: boolean;
  viewOthersTime: boolean;
  viewOthersMoney: boolean;
};

export type WorkspaceSummary = {
  id: string;
  name: string;
  role: WorkspaceRole;
  memberCount: number;
  /** The workspace a request that names none resolves to. */
  isDefault: boolean;
  permissions: WorkspacePermissions;
};

export type WorkspaceMemberRow = {
  memberId: string;
  userId: string;
  name: string;
  email: string;
  role: WorkspaceRole;
  canViewOthersTime: boolean;
  canViewOthersMoney: boolean;
  joinedAt: string;
  isSelf: boolean;
};

export type PendingInvitation = {
  id: string;
  email: string;
  role: InvitableRole;
  inviterName: string;
  expiresAt: string;
  inviteUrl: string;
};

export type InviteResult = { invitation: PendingInvitation; emailSent: boolean };

export type InvitationStatus =
  | "pending"
  | "accepted"
  | "rejected"
  | "canceled"
  | "expired";

export type InvitationPreview = {
  id: string;
  workspaceName: string;
  inviterName: string;
  email: string;
  role: InvitableRole;
  status: InvitationStatus;
};

/**
 * A running entry in ANOTHER workspace that starting a timer stopped.
 *
 * One running timer per person, across every workspace, is the invariant
 * (teams design decision 2) — so starting in B ends A's timer. The client
 * must say so; this is what it says it with.
 */
export type StartTimerReplaced = {
  entryId: string;
  workspaceId: string;
  workspaceName: string;
  end: string;
};

/**
 * The FORBIDDEN message codes a membership action answers with, for a refusal
 * on a row that genuinely belongs to the caller's own workspace. Anything the
 * caller cannot name — another workspace's member, invitation or the
 * workspace itself — is NOT_FOUND instead, so it cannot be probed.
 */
export const MEMBERSHIP_REFUSALS = [
  "owner-required",
  "admin-required",
  "cannot-modify-self",
  "cannot-modify-owner",
  "transfer-ownership-first",
  "workspace-has-no-other-members",
  "already-member",
  "invitation-email-mismatch",
  "invitation-not-pending",
  "invite-limit-reached",
  "invoice-permission-required",
] as const;
export type MembershipRefusal = (typeof MEMBERSHIP_REFUSALS)[number];

/** True when a server error message is one of the stable refusal codes. */
export function isMembershipRefusal(value: unknown): value is MembershipRefusal {
  return (
    typeof value === "string" &&
    (MEMBERSHIP_REFUSALS as readonly string[]).includes(value)
  );
}

/**
 * What a role with these flags may do, as the server decides it.
 *
 * Owners always see everything: the flags are forced on for them, so they
 * are read from the role rather than trusted from the row.
 */
export function permissionsFor(
  role: WorkspaceRole,
  flags: { canViewOthersTime: boolean; canViewOthersMoney: boolean },
): WorkspacePermissions {
  const owner = role === "owner";
  const manager = owner || role === "admin";
  const viewOthersTime = owner || flags.canViewOthersTime;
  const viewOthersMoney = owner || flags.canViewOthersMoney;
  return {
    inviteMembers: manager,
    inviteAdmins: owner,
    changeRoles: owner,
    editTimeVisibility: manager,
    editMoneyVisibility: owner,
    removeMembers: manager,
    transferOwnership: owner,
    // Invoices total everybody's billable time, so they need both flags as
    // well as a managing role.
    invoices: manager && viewOthersTime && viewOthersMoney,
    viewOthersTime,
    viewOthersMoney,
  };
}

const workspaceId = z.string().min(1).max(64).optional();
const recordId = z.string().min(1).max(64);

/**
 * `z.string().email()` alone accepts surrounding whitespace in some inputs
 * and never case-folds, so the address is trimmed before validation and
 * lower-cased after it: one person must not be invitable twice as
 * "Bob@x.com" and "bob@x.com".
 */
const invitedEmail = z.preprocess(
  (value) => (typeof value === "string" ? value.trim() : value),
  z.string().email().max(320).transform((value) => value.toLowerCase()),
);

export const inviteMemberSchema = z.object({
  workspaceId,
  email: invitedEmail,
  role: z.enum(INVITABLE_ROLES),
});
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;

export const memberIdSchema = z.object({ workspaceId, memberId: recordId });
export type MemberIdInput = z.infer<typeof memberIdSchema>;

export const updateRoleSchema = z.object({
  workspaceId,
  memberId: recordId,
  role: z.enum(INVITABLE_ROLES),
});
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;

export const updateVisibilitySchema = z.object({
  workspaceId,
  memberId: recordId,
  canViewOthersTime: z.boolean().optional(),
  canViewOthersMoney: z.boolean().optional(),
});
export type UpdateVisibilityInput = z.infer<typeof updateVisibilitySchema>;

export const invitationIdSchema = z.object({ id: recordId });
export type InvitationIdInput = z.infer<typeof invitationIdSchema>;

export const cancelInvitationSchema = z.object({
  workspaceId,
  invitationId: recordId,
});
export type CancelInvitationInput = z.infer<typeof cancelInvitationSchema>;

export const workspaceScopeSchema = z
  .object({ workspaceId })
  .optional();

export const setActiveWorkspaceSchema = z.object({ workspaceId: recordId });
export type SetActiveWorkspaceInput = z.infer<typeof setActiveWorkspaceSchema>;
