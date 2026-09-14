// Managing the endpoints a workspace pushes events to.
//
// Everything here is `workspaceProcedure`. Three rules this file exists to
// enforce, all of which fail silently if broken:
//
//  - The signing secret is returned exactly ONCE, from `create`. Nothing else
//    can read it back: `toClientWebhookSubscription` builds a fresh object
//    rather than spreading the document, so the field is absent by
//    construction rather than by remembering to delete it.
//  - Every URL goes through `assertDeliverableUrl` — at create AND at update.
//    Validating only on create would let an endpoint be pointed at a loopback
//    address one edit later.
//  - A subscription is managed by the member who created it, and by nobody
//    else in the workspace. Every query here carries `createdBy: ctx.user.id`
//    beside the workspace id; a colleague's subscription answers NOT_FOUND,
//    the same way any id outside a caller's reach does.
//
// That third rule is not tidiness, it is the whole permission model:
// deliveries are projected against `subscription.createdBy`'s LIVE
// visibility (`services/webhooks/delivery.ts`), so an editable url on
// somebody else's subscription is an exfiltration primitive rather than an
// edit. In a workspace where A may see other people's money and B may not, B
// repointing A's subscription at a host B controls receives payloads
// projected against A — money B was refused, delivered to B, signed by us,
// with A's name on the row. `url` is the field that turns the projection into
// a channel, so it is the field this rule exists for; the rest of the update
// is scoped the same way because there is no reason for it not to be.
//
// There is deliberately no admin override and no workspace-wide list. A
// webhook URL frequently IS a credential — the token lives in the path of
// the endpoint it posts to — so listing a colleague's subscription hands over
// their secret in the name of oversight. Nor is one needed for cleanup: when
// a creator leaves the workspace, `ownerVisibility` finds no membership and
// every delivery is skipped, so the subscription stops pushing anything
// without anyone touching it.
import { TRPCError } from "@trpc/server";
import mongoose from "mongoose";
import { randomBytes } from "node:crypto";
import {
  createWebhookSchema,
  idInputSchema,
  updateWebhookSchema,
  webhookDeliveryListSchema,
  type CreatedWebhookSubscription,
  type WebhookDeliveryWire,
  type WebhookSubscriptionWire,
  workspaceScopeSchema,
} from "@starter/shared";
import {
  WebhookDelivery,
  toClientWebhookDelivery,
} from "../../models/WebhookDelivery.js";
import {
  WebhookSubscription,
  toClientWebhookSubscription,
} from "../../models/WebhookSubscription.js";
import { assertDeliverableUrl } from "../../services/webhooks/ssrf.js";
import { decodeCursor, encodeCursor } from "../../services/cursor.js";
import { publishSync } from "../../ws/sync.js";
import { router, workspaceProcedure } from "../trpc.js";

/** 32 bytes of CSPRNG, base64url — the same strength as an API token. */
const SECRET_BYTES = 32;

const DEFAULT_DELIVERY_LIMIT = 25;

const notFound = (): TRPCError =>
  new TRPCError({ code: "NOT_FOUND", message: "Webhook not found" });

/** An id that cannot address a document reads as missing, never as a 500. */
function requireWebhookId(id: string): string {
  if (!mongoose.isValidObjectId(id)) throw notFound();
  return id;
}

/** The workspace-and-creator pair every query in this file is scoped by. */
export type OwnWebhookFilter = {
  workspaceId: string;
  createdBy: string;
};

/** One specific subscription, addressable only by the member who made it. */
export type OwnWebhookByIdFilter = OwnWebhookFilter & { _id: string };

/**
 * "The subscriptions that are mine, here."
 *
 * A named builder rather than an object literal per call site: `{ workspaceId }`
 * alone looks scoped, reviews as scoped, and is scoped — to the workspace,
 * which is not the boundary that matters for a channel projected against one
 * member's visibility.
 */
export function ownWebhookFilter(
  workspaceId: string,
  createdBy: string,
): OwnWebhookFilter {
  return { workspaceId, createdBy };
}

/**
 * The filter every single-subscription operation matches on.
 *
 * Used by `update` in particular, which is why `createdBy` is inside the
 * atomic match rather than checked in a read beforehand: a separate
 * read-then-write could be raced, and more importantly it could be edited
 * later to fetch first and forget to compare. A url change on a subscription
 * the caller did not create must be a miss at the database, not a branch in
 * the resolver.
 */
export function ownWebhookByIdFilter(
  id: string,
  workspaceId: string,
  createdBy: string,
): OwnWebhookByIdFilter {
  return { _id: id, ...ownWebhookFilter(workspaceId, createdBy) };
}

export const webhooksRouter = router({
  list: workspaceProcedure.input(workspaceScopeSchema).query(
    async ({ ctx }): Promise<WebhookSubscriptionWire[]> => {
      const docs = await WebhookSubscription.find(
        ownWebhookFilter(ctx.workspaceId, ctx.user.id),
      )
        .sort({ createdAt: -1 })
        .lean();
      return docs.map(toClientWebhookSubscription);
    },
  ),

  create: workspaceProcedure
    .input(createWebhookSchema)
    .mutation(async ({ ctx, input }): Promise<CreatedWebhookSubscription> => {
      // Throws BAD_REQUEST for a non-http(s) scheme, a plain-http target, or
      // any address behind the host that is internal to this network.
      const url = await assertDeliverableUrl(input.url);

      const secret = randomBytes(SECRET_BYTES).toString("base64url");
      const created = await WebhookSubscription.create({
        workspaceId: ctx.workspaceId,
        // Deliveries are projected against THIS person's live view, so who
        // created a subscription is a permission fact, not an audit note.
        createdBy: ctx.user.id,
        url: url.toString(),
        secret,
        events: input.events,
        enabled: true,
        consecutiveFailures: 0,
        disabledAt: null,
        lastDeliveryAt: null,
      });

      void publishSync(
        ctx.workspaceId,
        { kind: "integrations.changed", scope: "webhook" },
        input.originId,
      );
      return {
        subscription: toClientWebhookSubscription(created),
        secret,
      };
    }),

  update: workspaceProcedure
    .input(updateWebhookSchema)
    .mutation(async ({ ctx, input }): Promise<WebhookSubscriptionWire> => {
      const url =
        input.url === undefined ? null : await assertDeliverableUrl(input.url);

      // Re-enabling clears the failure counter and the disabled stamp
      // together. Leaving the counter behind would auto-disable the endpoint
      // again after a single further failure, which reads to the user as
      // "the toggle does not work".
      const reEnabled = input.enabled === true;

      // `createdBy` is part of the match, so a subscription somebody else
      // created is simply not there to be repointed. See the file header for
      // what an editable url on a colleague's subscription would buy.
      const updated = await WebhookSubscription.findOneAndUpdate(
        ownWebhookByIdFilter(
          requireWebhookId(input.id),
          ctx.workspaceId,
          ctx.user.id,
        ),
        {
          $set: {
            ...(url ? { url: url.toString() } : {}),
            ...(input.events !== undefined ? { events: input.events } : {}),
            ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
            ...(reEnabled ? { consecutiveFailures: 0, disabledAt: null } : {}),
          },
        },
        { returnDocument: "after" },
      ).lean();
      if (!updated) throw notFound();

      void publishSync(
        ctx.workspaceId,
        { kind: "integrations.changed", scope: "webhook" },
        input.originId,
      );
      return toClientWebhookSubscription(updated);
    }),

  /**
   * Delete the subscription and its delivery log together.
   *
   * Unlike an API token, there is nothing to keep: a subscription holds no
   * history worth reading once it is gone, and its pending deliveries would
   * otherwise be dialled at an endpoint nobody is watching any more.
   */
  remove: workspaceProcedure
    .input(idInputSchema)
    .mutation(async ({ ctx, input }): Promise<{ id: string }> => {
      const id = requireWebhookId(input.id);
      const deleted = await WebhookSubscription.findOneAndDelete(
        ownWebhookByIdFilter(id, ctx.workspaceId, ctx.user.id),
      ).lean();
      if (!deleted) throw notFound();

      await WebhookDelivery.deleteMany({
        workspaceId: ctx.workspaceId,
        subscriptionId: id,
      });

      void publishSync(
        ctx.workspaceId,
        { kind: "integrations.changed", scope: "webhook" },
        input.originId,
      );
      return { id };
    }),

  /** The delivery log for one subscription, newest first. */
  deliveries: workspaceProcedure
    .input(webhookDeliveryListSchema)
    .query(
      async ({
        ctx,
        input,
      }): Promise<{
        deliveries: WebhookDeliveryWire[];
        nextCursor: string | null;
      }> => {
        const subscriptionId = requireWebhookId(input.subscriptionId);
        // Prove the subscription is the CALLER'S before reading its log —
        // otherwise the log itself is the read that the ownership rule on
        // `list` and `update` was meant to close: it names the events a
        // colleague's endpoint receives and how it is faring, one id at a
        // time.
        const owns = await WebhookSubscription.exists(
          ownWebhookByIdFilter(subscriptionId, ctx.workspaceId, ctx.user.id),
        );
        if (!owns) throw notFound();

        const limit = input.limit ?? DEFAULT_DELIVERY_LIMIT;
        const decoded = input.cursor ? decodeCursor(input.cursor) : null;
        // A cursor that will not decode — or whose id could not address a
        // document — is a caller mistake, not a reason to silently serve page
        // one again as if it were the next page.
        if (
          input.cursor &&
          (!decoded ||
            !mongoose.isValidObjectId(decoded.id) ||
            Number.isNaN(Date.parse(decoded.sortKey)))
        ) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Invalid cursor",
          });
        }

        const rows = await WebhookDelivery.find({
          workspaceId: ctx.workspaceId,
          subscriptionId,
          ...(decoded
            ? {
                $or: [
                  { createdAt: { $lt: new Date(decoded.sortKey) } },
                  {
                    createdAt: new Date(decoded.sortKey),
                    _id: { $lt: new mongoose.Types.ObjectId(decoded.id) },
                  },
                ],
              }
            : {}),
        })
          .sort({ createdAt: -1, _id: -1 })
          .limit(limit + 1)
          .lean();

        const page = rows.slice(0, limit).map(toClientWebhookDelivery);
        const last = page[page.length - 1];
        return {
          deliveries: page,
          // Always present, `null` on the last page: an absent key would make
          // "no more pages" indistinguishable from a serialization bug.
          nextCursor:
            rows.length > limit && last
              ? encodeCursor(last.createdAt, last.id)
              : null,
        };
      },
    ),
});
