// Who may do what to whom, as pure functions.
//
// Every membership mutation asks one of these before it writes, and each
// answers `null` (allowed) or the stable refusal code the router turns into a
// FORBIDDEN. They run only AFTER the target has been found inside the caller's
// own workspace — an id from anywhere else has already answered NOT_FOUND by
// then, so nothing here can be used to learn that a foreign row exists.
//
// The matrix (teams slice S2):
//
//   owner   invite admin|member · cancel invitations · change admin<->member
//           of anybody but themselves · edit both flags of non-owners · remove
//           anybody but themselves · transfer ownership · leave only when
//           another owner remains
//   admin   invite member · cancel invitations · edit canViewOthersTime of
//           role=member rows · remove role=member rows
//   member  list members · leave
//
// And for everyone: nobody edits their own role or flags, nobody removes
// themselves through `remove` (that is `leave`), an owner is only ever touched
// by another owner, and ownership is only ever GIVEN by transfer.
import type { MembershipRefusal, WorkspaceRole } from "@starter/shared";

export type MembershipActor = { userId: string; role: WorkspaceRole };
export type MembershipTarget = { userId: string; role: WorkspaceRole };

const isManager = (role: WorkspaceRole): boolean =>
  role === "owner" || role === "admin";

/** May `actor` invite somebody with `role`? */
export function refuseInvite(
  actor: MembershipActor,
  role: WorkspaceRole,
): MembershipRefusal | null {
  if (!isManager(actor.role)) return "admin-required";
  // Ownership moves by transfer and nothing else, so an invitation can never
  // create an owner — not even when an owner sends it.
  if (role === "owner") return "owner-required";
  if (role === "admin" && actor.role !== "owner") return "owner-required";
  return null;
}

/** May `actor` see or cancel this workspace's pending invitations? */
export function refuseInvitationManagement(
  actor: MembershipActor,
): MembershipRefusal | null {
  return isManager(actor.role) ? null : "admin-required";
}

/**
 * May `actor` set `target`'s role to `role` (admin or member)?
 *
 * `ownerCount` is the number of owners in the workspace now. An owner
 * demoting another owner always leaves at least themselves, but the check is
 * stated rather than implied, so a future caller cannot make it false.
 */
export function refuseRoleChange(
  actor: MembershipActor,
  target: MembershipTarget,
  role: WorkspaceRole,
  ownerCount: number,
): MembershipRefusal | null {
  if (actor.userId === target.userId) return "cannot-modify-self";
  if (actor.role !== "owner") return "owner-required";
  if (role === "owner") return "owner-required";
  if (target.role === "owner" && ownerCount <= 1) return "transfer-ownership-first";
  return null;
}

/** May `actor` change the flags named in `patch` on `target`? */
export function refuseVisibilityChange(
  actor: MembershipActor,
  target: MembershipTarget,
  patch: { canViewOthersTime?: boolean; canViewOthersMoney?: boolean },
): MembershipRefusal | null {
  if (actor.userId === target.userId) return "cannot-modify-self";
  if (!isManager(actor.role)) return "admin-required";
  // Owner flags are forced on; there is nothing to edit.
  if (target.role === "owner") return "cannot-modify-owner";
  if (actor.role === "owner") return null;
  // An admin: time visibility of plain members, and nothing else. Money is
  // the owner's call even when the value sent matches the current one — the
  // question is who may make it, not whether it changes anything.
  if (patch.canViewOthersMoney !== undefined) return "owner-required";
  if (target.role !== "member") return "owner-required";
  return null;
}

/** May `actor` remove `target` from the workspace? */
export function refuseRemoval(
  actor: MembershipActor,
  target: MembershipTarget,
  ownerCount: number,
): MembershipRefusal | null {
  if (actor.userId === target.userId) return "cannot-modify-self";
  if (!isManager(actor.role)) return "admin-required";
  if (target.role === "owner") {
    if (actor.role !== "owner") return "cannot-modify-owner";
    if (ownerCount <= 1) return "transfer-ownership-first";
    return null;
  }
  if (actor.role === "admin" && target.role !== "member") return "owner-required";
  return null;
}

/**
 * May `actor` leave?
 *
 * `otherMembers` excludes the actor. The only member cannot leave — the
 * workspace would be left with nobody, which is account deletion's decision
 * to make, not a button's. The last owner cannot leave while anybody else
 * remains; they hand the workspace over first.
 */
export function refuseLeave(
  actor: MembershipActor,
  otherMembers: number,
  ownerCount: number,
): MembershipRefusal | null {
  if (otherMembers === 0) return "workspace-has-no-other-members";
  if (actor.role === "owner" && ownerCount <= 1) return "transfer-ownership-first";
  return null;
}

/** May `actor` hand ownership to `target`? */
export function refuseTransfer(
  actor: MembershipActor,
  target: MembershipTarget,
): MembershipRefusal | null {
  if (actor.role !== "owner") return "owner-required";
  if (actor.userId === target.userId) return "cannot-modify-self";
  return null;
}
