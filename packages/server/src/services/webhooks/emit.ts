// Where a mutation says "this happened"; nothing here talks to the network.
//
// Emission ENQUEUES: it writes one pending `WebhookDelivery` per interested
// subscription and returns. The actual POST is the sweeper's job, on its own
// retry schedule. Splitting the two is what keeps a slow or dead customer
// endpoint from becoming latency on the request that stopped a timer.
import mongoose from "mongoose";
import type { WebhookEnvelope, WebhookEvent, WebhookEventData } from "@starter/shared";
import { WebhookDelivery } from "../../models/WebhookDelivery.js";
import { WebhookSubscription } from "../../models/WebhookSubscription.js";

/**
 * Fan an event out to every enabled subscription that asked for it.
 *
 * Fire-and-forget with a swallowed catch, exactly like `publishSync`, and for
 * the same reason: an integration is a side effect of a mutation, never a
 * precondition of it. A webhook table that is down must not make stopping a
 * timer fail. NEVER await this into a mutation's failure path.
 *
 * The FULL, unprojected envelope is stored. The visibility projection happens
 * at SEND time against the subscription owner's live view, so a permission
 * change between enqueue and send is honoured rather than frozen in here.
 */
export function emitWebhookEvent(
  workspaceId: string,
  event: WebhookEvent,
  data: WebhookEventData,
): void {
  if (!workspaceId) return;

  void (async () => {
    const subscriptions = await WebhookSubscription.find({
      workspaceId,
      enabled: true,
      events: event,
    })
      .select({ _id: 1 })
      .lean();
    if (subscriptions.length === 0) return;

    const now = new Date();
    const rows = subscriptions.map((subscription) => {
      // The row's `_id` is minted HERE rather than by the insert, so the
      // envelope can carry it. There is exactly one delivery id in the
      // product: this value is the envelope's `id`, the `X-TrackYourTime-Delivery`
      // header, and the id of the row the settings delivery log lists. A
      // separate random id for the wire would give an integrator a dedup key
      // that matches nothing they can look up when a delivery fails.
      const id = new mongoose.Types.ObjectId();
      const envelope: WebhookEnvelope = {
        // Also the receiver's dedup key: every attempt of one delivery carries
        // this same id, so a consumer that saw attempt 1 land after a timeout
        // can drop attempt 2.
        id: id.toHexString(),
        event,
        workspaceId,
        createdAt: now.toISOString(),
        data,
      };
      return {
        _id: id,
        workspaceId,
        subscriptionId: String(subscription._id),
        event,
        envelope,
        status: "pending" as const,
        attempt: 0,
        responseStatus: null,
        error: null,
        // Due immediately; the sweeper picks it up on its next pass.
        nextAttemptAt: now,
      };
    });

    await WebhookDelivery.insertMany(rows, { ordered: false });
  })().catch(() => {
    // Best-effort, always. See the doc comment.
  });
}
