import type { SyncEvent, Visibility, WorkspaceRole } from "@starter/shared";
import {
  canSeeEntry,
  canUseInvoices,
  projectEntryForVisibility,
  userRoomId,
} from "@starter/shared";
import { WorkspaceMember } from "../models/WorkspaceMember.js";
import { roomManager } from "./handler.js";

/** Re-exported so mutations never hand-roll the room name. */
export { userRoomId };

/**
 * Broadcast to one person's devices.
 *
 * For events that are about the human rather than the workspace: their own
 * preference changes, a device being signed out. `publishSync` also delivers
 * through here, once per recipient, and passes the workspace the event
 * happened in so the envelope says which of the person's workspaces it
 * belongs to.
 */
export function publishToUser(
  userId: string,
  event: SyncEvent,
  originId?: string,
  workspaceId?: string,
): void {
  if (!userId) return;
  try {
    roomManager.broadcast(userRoomId(userId), {
      type: "tt:sync",
      event,
      ...(originId ? { originId } : {}),
      ...(workspaceId ? { workspaceId } : {}),
    });
  } catch {
    // Realtime delivery is best-effort — never fail the mutation.
  }
}

/** The membership fields the fan-out decides on — nothing else is read. */
export type SyncRecipient = {
  userId: string;
  role: WorkspaceRole;
  canViewOthersTime: boolean;
  canViewOthersMoney: boolean;
};

/**
 * Who an event is about, for the kinds whose payload cannot say.
 *
 * `entry.deleted` carries only an id — the row is gone, so there is nothing
 * left to read an author off — and `data.imported` only a batch id. Without
 * this the fan-out has no way to tell the author's own devices from a
 * colleague who may not know the entry ever existed.
 */
export type SyncAudience = { authorId: string };

const visibilityOfRecipient = (recipient: SyncRecipient): Visibility => ({
  userId: recipient.userId,
  canViewOthersTime: recipient.canViewOthersTime,
  canViewOthersMoney: recipient.canViewOthersMoney,
});

/**
 * The event as one recipient may receive it, or `null` when they may not
 * receive it at all.
 *
 * THE RULE, per kind, and the reason each is shaped the way it is:
 *
 * - `entry.upserted`, `timer.started`, `timer.stopped` carry a whole entry —
 *   description, project, task, tags and `hourlyRate`. The author always gets
 *   it unchanged. Anybody without `canViewOthersTime` gets NOTHING: not a
 *   redacted shell, because the event's mere arrival says "a colleague just
 *   started something". Anybody with time but not money gets it through
 *   `projectEntryForVisibility`, the same function the REST responses and the
 *   webhook deliveries use, so the socket cannot come to disagree with them.
 * - `entry.deleted` names only an id. With an `audience` it reaches the author
 *   and whoever may see the author's time; without one (a caller that has not
 *   been taught to pass it) it reaches only members who may see everybody's
 *   time — which fails CLOSED for a restricted author's other devices rather
 *   than open for their colleagues.
 * - `data.imported` is the bulk twin of `entry.upserted`: the same audience
 *   rule, for the same reason.
 * - `invoice.changed` reaches only somebody who may use invoices at all
 *   (`canUseInvoices`). An invoice id is a pointer to money.
 * - Everything else — catalog, favorites, settings, integrations, membership
 *   — describes shared configuration every member already reads, and passes
 *   through. An UNKNOWN kind passes through too: a new kind that carries an
 *   entry must be added above, and the matrix test is where that is caught.
 *
 * Pure, so every cell of the recipient x kind matrix is testable without a
 * socket or a database.
 */
export function projectSyncEventFor(
  event: SyncEvent,
  recipient: SyncRecipient,
  audience?: SyncAudience,
): SyncEvent | null {
  const visibility = visibilityOfRecipient(recipient);

  switch (event.kind) {
    case "entry.upserted":
    case "timer.started":
    case "timer.stopped": {
      const entry = projectEntryForVisibility(event.entry, visibility);
      if (entry === null) return null;
      return entry === event.entry ? event : { ...event, entry };
    }

    case "entry.deleted":
    case "data.imported":
      if (audience) return canSeeEntry(visibility, audience.authorId) ? event : null;
      return visibility.canViewOthersTime ? event : null;

    case "invoice.changed":
      return canUseInvoices(recipient.role, visibility) ? event : null;

    default:
      return event;
  }
}

/**
 * Broadcast a mutation's {@link SyncEvent} to every member of a workspace,
 * projected per recipient.
 *
 * Room topology stays one room per PERSON (`user:<userId>`); the fan-out is
 * resolved here instead. That is deliberate: a room broadcasts one serialized
 * blob to everyone in it, and entries carry work and money that a given member
 * may or may not see, so the payload differs per recipient. Keeping the
 * fan-out in code means the visibility rule lives in one testable function
 * ({@link projectSyncEventFor}) rather than in the room graph.
 *
 * Memberships are read fresh on every publish rather than cached: a flag
 * revoked a second ago must stop the next event, and a stale cache is exactly
 * the window in which a demoted member keeps receiving rates.
 *
 * `originId` is the per-tab uuid carried on the mutation input; it is echoed
 * on the envelope so the originating client can ignore its own echo.
 * `audience` names the author for the id-only kinds — see
 * {@link SyncAudience}.
 */
export async function publishSync(
  workspaceId: string,
  event: SyncEvent,
  originId?: string,
  audience?: SyncAudience,
): Promise<void> {
  if (!workspaceId) return;
  try {
    const members = await WorkspaceMember.find({ workspaceId })
      .select({
        userId: 1,
        role: 1,
        canViewOthersTime: 1,
        canViewOthersMoney: 1,
      })
      .lean<SyncRecipient[]>();
    for (const member of members) {
      const projected = projectSyncEventFor(event, member, audience);
      if (projected === null) continue;
      publishToUser(member.userId, projected, originId, workspaceId);
    }
  } catch {
    // Realtime delivery is best-effort — never fail the mutation.
  }
}
