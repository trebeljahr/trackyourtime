// The live dependencies behind the membership routers.
//
// Everything in this directory takes its effects as arguments so the unit
// suite can drive it against in-memory rows. This file is the one place those
// arguments are the real thing: mongoose and better-auth's adapter, the sync
// fan-out, the timer service, the mail transport and Redis.
import {
  isLocale,
  type Locale,
  type SyncEvent,
} from "@starter/shared";
import { env } from "../../config/env.js";
import { getRedis } from "../../db/redis.js";
import { ensurePersonalWorkspace } from "../../auth/workspace.js";
import { UserPreferencesModel } from "../../models/Settings.js";
import { publishSync, publishToUser } from "../../ws/sync.js";
import {
  isEmailDeliveryConfigured,
  sendWorkspaceInvitationEmail,
} from "../email.js";
import { stopRunningEntry, workspaceReach } from "../entries/timer.js";
import {
  INVITATION_TTL_SECONDS,
  INVITES_PER_HOUR,
  buildInvitationUrl,
  newInvitationId,
  type InvitationDeps,
  type InvitationEmail,
} from "./invitations.js";
import { createInviteBudget } from "./invite-rate-limit.js";
import type { MembershipDeps } from "./members.js";
import { productionMembershipStore } from "./stores.js";

/**
 * The link an invitee opens, against this deployment's web app. The only
 * builder of it — the email, the inviter's copyable link and the pending list
 * all go through here, so they cannot drift apart.
 */
export function invitationUrl(id: string): string {
  return buildInvitationUrl(id, env.FRONTEND_URL);
}

/** One budget per process: the in-memory window must survive between calls. */
const inviteBudget = createInviteBudget({
  limit: INVITES_PER_HOUR,
  windowMs: 60 * 60 * 1000,
  redis: getRedis,
});

const publishWorkspace = (workspaceId: string, event: SyncEvent): void => {
  void publishSync(workspaceId, event);
};

const publishUser = (userId: string, event: SyncEvent): void => {
  publishToUser(userId, event);
};

/**
 * Stop the person's running entry in ONE workspace — `workspaceReach`, so a
 * timer they are running in another workspace is left exactly as it is. Runs
 * after their mirror row is gone, so `timer.stopped` reaches the colleagues
 * still in the workspace and not the person just removed from it.
 */
export const stopRunningEntryIn = async (userId: string, workspaceId: string): Promise<void> => {
  await stopRunningEntry(userId, new Date(), workspaceReach(workspaceId));
};

export async function membershipDeps(): Promise<MembershipDeps> {
  return {
    store: await productionMembershipStore(),
    now: () => new Date(),
    stopRunningEntry: stopRunningEntryIn,
    publishWorkspace,
    publishUser,
    defaultWorkspaceFor: ensurePersonalWorkspace,
  };
}

/** A stored language preference, if it is a language rather than "system". */
async function storedLocale(userId: string): Promise<Locale | null> {
  try {
    const prefs = await UserPreferencesModel.findOne({ userId }).select({ locale: 1 }).lean();
    const locale: unknown = prefs?.locale;
    return isLocale(locale) ? locale : null;
  } catch {
    return null;
  }
}

/**
 * Send one invitation in the RECIPIENT's language when they already have an
 * account that says which. An address with no account has no preference to
 * read, so the inviter's is the best available guess — people usually invite
 * colleagues who share a working language — and English after that.
 */
async function sendInvitation(
  store: InvitationDeps["store"],
  email: InvitationEmail,
): Promise<void> {
  const [recipient] = await store.find("authUsers", { email: email.to });
  const recipientId = typeof recipient?.id === "string" ? recipient.id : null;
  const locale =
    (recipientId ? await storedLocale(recipientId) : null) ??
    (await storedLocale(email.inviterId));
  await sendWorkspaceInvitationEmail({
    to: email.to,
    workspaceName: email.workspaceName,
    inviterName: email.inviterName,
    url: email.url,
    locale,
    expiresInHours: Math.round(INVITATION_TTL_SECONDS / 3600),
  });
}

export async function invitationDeps(): Promise<InvitationDeps> {
  const store = await productionMembershipStore();
  return {
    store,
    now: () => new Date(),
    newId: newInvitationId,
    frontendUrl: env.FRONTEND_URL,
    emailConfigured: isEmailDeliveryConfigured,
    sendInvitationEmail: (email) => sendInvitation(store, email),
    log: (message) => console.log(message),
    consumeInviteBudget: (inviterId) => inviteBudget(inviterId),
    publishWorkspace,
    publishUser,
  };
}
