// Outgoing webhooks: the push half of the public API.
//
// A subscription is workspace-scoped like everything else, but its DELIVERIES
// are projected against the visibility of the member who created it. A webhook
// is a standing grant, so the question "may this person see this entry?" has
// to be re-asked at send time rather than at subscribe time — see
// services/webhooks/projection.ts.
import type { Invoice, InvoiceStatus, TimeEntry } from "./types.js";

/**
 * The events a subscription can ask for.
 *
 * `entry.started` / `entry.stopped` are separate from `entry.updated` on
 * purpose: a timer boundary is the thing most integrations care about, and
 * making them filter `end === null` out of a generic update stream would put
 * that rule in every consumer instead of here.
 */
export const WEBHOOK_EVENTS = [
  "entry.started",
  "entry.stopped",
  "entry.created",
  "entry.updated",
  "entry.deleted",
  "invoice.created",
  "invoice.status_changed",
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** A subscription as every client renders it — never its signing secret. */
export type WebhookSubscriptionWire = {
  id: string;
  url: string;
  events: WebhookEvent[];
  enabled: boolean;
  /**
   * How many deliveries have failed back-to-back. Reset by the first success.
   * Shown because a silently disabled endpoint is the failure mode people
   * discover weeks later, when the data they were syncing is already wrong.
   */
  consecutiveFailures: number;
  disabledAt: string | null;
  lastDeliveryAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** The one and only response that carries the signing secret. */
export type CreatedWebhookSubscription = {
  subscription: WebhookSubscriptionWire;
  secret: string;
};

/**
 * `skipped_visibility` is a first-class outcome, not a failure.
 *
 * A delivery the subscription's owner may not see is dropped rather than
 * retried — retrying would never succeed, and counting it as a failure would
 * auto-disable a perfectly healthy endpoint the moment a colleague started a
 * timer.
 */
export type WebhookDeliveryStatus =
  | "pending"
  | "delivered"
  | "failed"
  | "skipped_visibility";

export type WebhookDeliveryWire = {
  id: string;
  subscriptionId: string;
  event: WebhookEvent;
  status: WebhookDeliveryStatus;
  attempt: number;
  responseStatus: number | null;
  error: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * The payload half of an envelope.
 *
 * `entry-deleted` carries `authorId` explicitly, unlike the id-only
 * `SyncEvent` counterpart: the row is gone by the time the delivery is sent,
 * so there is nothing left to look the author up on — and without an author
 * the visibility check cannot run and the delivery could only be dropped.
 */
export type WebhookEventData =
  | { kind: "entry"; entry: TimeEntry }
  | { kind: "entry-deleted"; id: string; authorId: string }
  /**
   * The whole `Invoice` wire shape, so `issuer` and `recipient` — the parties
   * frozen at creation — travel with both invoice events. Any field added to
   * `Invoice` reaches integrators here; document it in docs-site webhooks.md.
   */
  | { kind: "invoice"; invoice: Invoice }
  | {
      kind: "invoice-status";
      invoice: Invoice;
      from: InvoiceStatus;
      to: InvoiceStatus;
    };

/**
 * What is signed and POSTed.
 *
 * `id` is the delivery id, so a receiver can deduplicate across the retry
 * schedule — every attempt of one delivery carries the same `id`.
 */
export type WebhookEnvelope = {
  id: string;
  event: WebhookEvent;
  workspaceId: string;
  createdAt: string;
  data: WebhookEventData;
};
