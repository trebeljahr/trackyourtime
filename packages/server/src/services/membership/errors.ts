// The two answers a membership action refuses with.
import { TRPCError } from "@trpc/server";
import type { MembershipRefusal } from "@starter/shared";

/**
 * Anything the caller cannot name: a member, invitation or workspace outside
 * their own. Carries no message, so a foreign id and a nonexistent one are
 * byte-identical answers.
 */
export const membershipNotFound = (): TRPCError => new TRPCError({ code: "NOT_FOUND" });

/**
 * A refusal about a row that is genuinely in the caller's own workspace. The
 * message IS the stable code — clients branch on it, so it is never reworded.
 */
export const membershipRefused = (code: MembershipRefusal): TRPCError =>
  new TRPCError({ code: "FORBIDDEN", message: code });

/** Throw when a permission check refused. */
export function assertAllowed(refusal: MembershipRefusal | null): void {
  if (refusal !== null) throw membershipRefused(refusal);
}
