import { installStorageQuota } from "../services/storage-quota.js";
// One endpoint a workspace pushes events to.
//
// `secret` never leaves this collection: it is returned once, at create time,
// and after that only ever used to sign a body. `toClientWebhookSubscription`
// drops it BY CONSTRUCTION — it builds a fresh object rather than spreading
// the document, so a field added later cannot leak by default.
import mongoose, { Schema, type Document } from "mongoose";
import type { WebhookEvent, WebhookSubscriptionWire } from "@starter/shared";

/**
 * Consecutive failures after which a subscription disables itself.
 *
 * The retry schedule spans six hours, so fifteen back-to-back failures is
 * days of a dead endpoint, not a blip. Auto-disabling matters because a
 * subscription nobody owns any more otherwise keeps this server dialling a
 * host that may since have been handed to somebody else.
 */
export const WEBHOOK_AUTO_DISABLE_AFTER = 15;

export interface IWebhookSubscription extends Document {
  workspaceId: string;
  /** The member who created it. Deliveries are projected against THEIR view. */
  createdBy: string;
  url: string;
  secret: string;
  events: WebhookEvent[];
  enabled: boolean;
  consecutiveFailures: number;
  disabledAt: Date | null;
  lastDeliveryAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type WebhookSubscriptionDocLike = {
  _id?: unknown;
  workspaceId: string;
  createdBy: string;
  url: string;
  events?: WebhookEvent[] | null;
  enabled: boolean;
  consecutiveFailures?: number | null;
  disabledAt?: Date | null;
  lastDeliveryAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const webhookSubscriptionSchema = new Schema<IWebhookSubscription>(
  {
    workspaceId: { type: String, required: true },
    createdBy: { type: String, required: true, default: "" },
    url: { type: String, required: true, maxlength: 2000 },
    secret: { type: String, required: true },
    // Not `required`, for the same reason as every other array on a document
    // that may predate the field: a required array fails validation on the
    // next save of a row written without it.
    events: { type: [String], default: [] },
    enabled: { type: Boolean, required: true, default: true },
    consecutiveFailures: { type: Number, required: true, default: 0 },
    disabledAt: { type: Date, default: null },
    lastDeliveryAt: { type: Date, default: null },
  },
  { timestamps: true },
);

/** The settings list, and the fan-out that asks "who wants this event?". */
webhookSubscriptionSchema.index({ workspaceId: 1, enabled: 1 });

export const WebhookSubscription = mongoose.model<IWebhookSubscription>(
  "WebhookSubscription",
  webhookSubscriptionSchema,
);

/** Convert a subscription into the exact wire shape — never its secret. */
export function toClientWebhookSubscription(
  doc: WebhookSubscriptionDocLike,
): WebhookSubscriptionWire {
  return {
    id: String(doc._id),
    url: doc.url,
    events: doc.events ?? [],
    enabled: doc.enabled,
    consecutiveFailures: doc.consecutiveFailures ?? 0,
    disabledAt: doc.disabledAt ? doc.disabledAt.toISOString() : null,
    lastDeliveryAt: doc.lastDeliveryAt
      ? doc.lastDeliveryAt.toISOString()
      : null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

installStorageQuota(WebhookSubscription);
