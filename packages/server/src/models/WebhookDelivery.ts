// One attempt-tracked push of one event to one subscription.
//
// The FULL envelope is stored on the row rather than a reference to whatever
// the entry looks like now: a delivery describes what happened at the moment
// it happened, and re-reading the entry at send time would push the state
// after three later edits under the timestamp of the first.
//
// The visibility projection is NOT applied here — it happens at send time,
// against the subscription owner's live-and-narrowed visibility, so a
// permission change between enqueue and send is honoured.
//
// `_id` is assigned by the emitter, not by the insert: it is the delivery id
// the envelope and the `X-TrackYourTime-Delivery` header carry, so it has to exist
// before the row does.
import mongoose, { Schema, type Document } from "mongoose";
import type {
  WebhookDeliveryStatus,
  WebhookDeliveryWire,
  WebhookEnvelope,
  WebhookEvent,
} from "@starter/shared";

/** Deliveries are a debugging log, not a ledger — 30 days is plenty. */
export const WEBHOOK_DELIVERY_TTL_SECONDS = 60 * 60 * 24 * 30;

export interface IWebhookDelivery extends Document {
  workspaceId: string;
  subscriptionId: string;
  event: WebhookEvent;
  /** The unprojected payload. See the file header. */
  envelope: WebhookEnvelope;
  status: WebhookDeliveryStatus;
  attempt: number;
  responseStatus: number | null;
  error: string | null;
  nextAttemptAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type WebhookDeliveryDocLike = {
  _id?: unknown;
  subscriptionId: string;
  event: WebhookEvent;
  status: WebhookDeliveryStatus;
  attempt?: number | null;
  responseStatus?: number | null;
  error?: string | null;
  nextAttemptAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const webhookDeliverySchema = new Schema<IWebhookDelivery>(
  {
    workspaceId: { type: String, required: true },
    subscriptionId: { type: String, required: true },
    event: { type: String, required: true },
    // Schema.Types.Mixed: the envelope is a discriminated union whose arms
    // differ per event, and pinning a sub-schema here would make adding an
    // event a migration. It is written by this server and read only by the
    // sender, so there is no untrusted shape to validate.
    envelope: { type: Schema.Types.Mixed, required: true },
    status: { type: String, required: true, default: "pending" },
    attempt: { type: Number, required: true, default: 0 },
    responseStatus: { type: Number, default: null },
    error: { type: String, default: null },
    nextAttemptAt: { type: Date, default: null },
  },
  { timestamps: true },
);

/** What the sweeper asks for: everything due, oldest first. */
webhookDeliverySchema.index({ status: 1, nextAttemptAt: 1 });
/** The delivery log for one subscription, newest first. */
webhookDeliverySchema.index({ subscriptionId: 1, createdAt: -1 });
/**
 * Expiry. Declared on the schema rather than swept by hand: a log that grows
 * with every event in the workspace is the collection that quietly becomes
 * the largest thing in the database.
 */
webhookDeliverySchema.index(
  { createdAt: 1 },
  { expires: WEBHOOK_DELIVERY_TTL_SECONDS },
);

export const WebhookDelivery = mongoose.model<IWebhookDelivery>(
  "WebhookDelivery",
  webhookDeliverySchema,
);

/**
 * Convert a delivery into the exact wire shape — never the envelope body.
 *
 * `id` is the row's `_id`, which `emitWebhookEvent` also wrote into the
 * envelope and which is therefore the `X-TrackYourTime-Delivery` header the
 * receiver saw. Deliberately ONE id space: an integrator told to deduplicate
 * on the header must be able to paste that value back and find this row in the
 * settings delivery log, and a second, wire-only id would leave them holding a
 * key that matches nothing in the product.
 */
export function toClientWebhookDelivery(
  doc: WebhookDeliveryDocLike,
): WebhookDeliveryWire {
  return {
    id: String(doc._id),
    subscriptionId: doc.subscriptionId,
    event: doc.event,
    status: doc.status,
    attempt: doc.attempt ?? 0,
    responseStatus: doc.responseStatus ?? null,
    error: doc.error ?? null,
    nextAttemptAt: doc.nextAttemptAt
      ? doc.nextAttemptAt.toISOString()
      : null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}
