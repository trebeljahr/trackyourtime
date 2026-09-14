// Signing an outgoing webhook so the receiver can prove it came from here.
//
// The scheme is the industry-standard one: HMAC-SHA256 over
// `${timestamp}.${rawBody}`, hex, sent as `v1=<hex>`. The timestamp is inside
// the signed string, not merely alongside it, so a captured delivery cannot be
// replayed hours later with the timestamp header rewritten.
import { createHmac } from "node:crypto";

export const WEBHOOK_SIGNATURE_HEADERS = {
  event: "X-TrackYourTime-Event",
  delivery: "X-TrackYourTime-Delivery",
  timestamp: "X-TrackYourTime-Timestamp",
  signature: "X-TrackYourTime-Signature",
} as const;

/** The version prefix on the signature header value. */
export const WEBHOOK_SIGNATURE_VERSION = "v1";

/**
 * Sign one request body.
 *
 * `rawBody` MUST be the exact string that is then handed to `fetch` as `body`.
 * Re-serializing the envelope between signing and sending is the failure mode
 * this signature has — `JSON.stringify` gives no ordering guarantee across
 * object identities, and a single reordered key produces a body the receiver
 * computes a different HMAC over and rejects as forged. Compute the string
 * ONCE, sign that string, send that string.
 */
export function signWebhookBody(
  secret: string,
  timestampSeconds: number,
  rawBody: string,
): string {
  return createHmac("sha256", secret)
    .update(`${timestampSeconds}.${rawBody}`, "utf8")
    .digest("hex");
}
