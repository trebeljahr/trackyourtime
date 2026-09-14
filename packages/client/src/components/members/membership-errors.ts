import { isMembershipRefusal, type MembershipRefusal } from "@starter/shared";

import { translate } from "@/i18n/translate";

/**
 * The stable FORBIDDEN codes from `@starter/shared` as the sentence a person
 * reads. A `switch` over the union with a `never` default, so a code added on
 * the server fails `tsc` here until it has copy.
 */
const refusalCopy = (refusal: MembershipRefusal): string => {
  const t = translate("members");
  switch (refusal) {
    case "owner-required":
      return t("errors.ownerRequired");
    case "admin-required":
      return t("errors.adminRequired");
    case "cannot-modify-self":
      return t("errors.cannotModifySelf");
    case "cannot-modify-owner":
      return t("errors.cannotModifyOwner");
    case "transfer-ownership-first":
      return t("errors.transferOwnershipFirst");
    case "workspace-has-no-other-members":
      return t("errors.workspaceHasNoOtherMembers");
    case "already-member":
      return t("errors.alreadyMember");
    case "invitation-email-mismatch":
      return t("errors.invitationEmailMismatch");
    case "invitation-not-pending":
      return t("errors.invitationNotPending");
    case "invite-limit-reached":
      return t("errors.inviteLimitReached");
    case "invoice-permission-required":
      return t("errors.invoicePermissionRequired");
    default: {
      const unhandled: never = refusal;
      return String(unhandled);
    }
  }
};

type ErrorShape = { message?: unknown; data?: { code?: unknown } | null };

const shapeOf = (error: unknown): ErrorShape =>
  typeof error === "object" && error !== null ? (error as ErrorShape) : {};

/** The tRPC error code (`"NOT_FOUND"`, `"FORBIDDEN"`, …), if there is one. */
export const trpcErrorCode = (error: unknown): string | null => {
  const code = shapeOf(error).data?.code;
  return typeof code === "string" ? code : null;
};

/** The refusal code a membership mutation answered with, if it was one. */
export const membershipRefusalOf = (error: unknown): MembershipRefusal | null => {
  const message = shapeOf(error).message;
  return isMembershipRefusal(message) ? message : null;
};

/**
 * A membership failure as human copy. Never the raw server message: the codes
 * are identifiers, and anything else could be a stack-trace-shaped string.
 */
export const membershipErrorMessage = (error: unknown): string => {
  const refusal = membershipRefusalOf(error);
  if (refusal !== null) return refusalCopy(refusal);
  // A row outside the caller's workspace answers NOT_FOUND by design — which,
  // from a screen that just listed it, means somebody else removed it first.
  if (trpcErrorCode(error) === "NOT_FOUND") return translate("members")("errors.notFound");
  return translate("common")("errors.generic");
};
