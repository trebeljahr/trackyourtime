// Sending one webhook: claim, project, re-check the target, sign, POST, record.
//
// Nothing in here is on a user's request path. `emitWebhookEvent` writes a
// pending row and returns; this module is the background half, so a customer
// endpoint that takes thirty seconds to answer costs nobody a timer.
//
// The order of operations is load-bearing:
//   1. claim the row (so two sweeps cannot send it twice),
//   2. project against the owner's LIVE visibility (permission changes since
//      enqueue are honoured),
//   3. re-resolve the URL and PIN the resolved address (DNS rebinding — a
//      create-time check is decorative, and so is a check-then-`fetch`),
//   4. serialize ONCE, sign that exact string, send that exact string.
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isIP } from "node:net";
import type { Visibility } from "@starter/shared/types";
import type { WebhookEnvelope } from "@starter/shared/webhooks";
import { env } from "../../config/env.js";
import { visibilityOf, WorkspaceMember } from "../../models/WorkspaceMember.js";
import { WebhookDelivery } from "../../models/WebhookDelivery.js";
import { WebhookSubscription } from "../../models/WebhookSubscription.js";
import { nextAttemptAt, shouldAutoDisable } from "./backoff.js";
import {
  WEBHOOK_SIGNATURE_HEADERS,
  WEBHOOK_SIGNATURE_VERSION,
  signWebhookBody,
} from "./signature.js";
import { assertDeliverableUrl, isBlockedAddress } from "./ssrf.js";
import { projectWebhookEnvelope } from "./projection.js";

/** How long a receiver gets to answer before the attempt counts as failed. */
export const WEBHOOK_REQUEST_TIMEOUT_MS = 10_000;

/**
 * How long a claimed delivery stays claimed.
 *
 * The claim is written as a future `nextAttemptAt`, so a process that dies
 * mid-flight releases its rows by simply becoming due again. Longer than the
 * request timeout, or a slow endpoint would be picked up a second time while
 * the first attempt is still in the air.
 */
export const WEBHOOK_CLAIM_LEASE_MS = 60_000;

/** Most deliveries one sweep will send. Keeps a backlog from monopolising it. */
export const WEBHOOK_SWEEP_BATCH = 20;

/**
 * The two ids every outcome write addresses.
 *
 * Strings, so a `lean()` row's `unknown` `_id` is narrowed once here rather
 * than at each of the six updates below.
 */
export type DeliveryTarget = {
  deliveryId: string;
  subscriptionId: string;
};

/** A failed attempt, described the way the delivery row records it. */
export type DeliveryFailure = {
  error: string;
  responseStatus: number | null;
};

/**
 * Turn an HTTP status into "delivered" (`null`) or a failure.
 *
 * A 3xx is a FAILURE, not a hop to follow. Following redirects would hand the
 * SSRF check the wrong URL: every address behind the subscription's own host
 * was validated, and a `Location:` header pointing at 169.254.169.254 is
 * validated by nothing. `node:https` does not follow redirects on its own —
 * that is why `postSignedDelivery` uses it directly and never re-dials — so a
 * 3xx arrives here as a status to record.
 */
export function classifyResponseStatus(status: number): DeliveryFailure | null {
  if (status >= 200 && status < 300) return null;
  if (status >= 300 && status < 400) {
    return { error: "redirect_not_followed", responseStatus: status };
  }
  return { error: `http_${status}`, responseStatus: status };
}

/**
 * The literal addresses this delivery is allowed to be dialled at.
 *
 * `assertDeliverableUrl` answers "is this URL safe", resolves the name to do
 * it, and then DISCARDS the addresses. On its own that is check-then-connect:
 * `fetch` would resolve the name a second time, and the address that was
 * validated is not the address the socket goes to. With a 0-TTL record an
 * attacker answers public for the check and 169.254.169.254 milliseconds
 * later, and the signed envelope — descriptions, project names, hourly rates —
 * is POSTed into the private network, with the response status landing on a
 * delivery row they can read back as a port scanner.
 *
 * So the addresses are kept and one of them is connected to as a literal. The
 * range table is NOT duplicated here: `isBlockedAddress` is imported, and the
 * accept/reject policy matches `assertDeliverableUrl` exactly — ANY private
 * address behind the name rejects the whole host, rather than the safe ones
 * being cherry-picked out of a mixed record set.
 *
 * Throws on anything unusable; the caller records it as `blocked_target`.
 */
export async function approvedDeliveryAddresses(url: URL): Promise<string[]> {
  // WHATWG URL keeps IPv6 literals bracketed; `net`/`dns` want them bare.
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const allowPrivate = env.WEBHOOK_ALLOW_PRIVATE_TARGETS;

  // A literal address is already the thing we would connect to — there is no
  // name, so there is nothing to resolve and nothing to rebind.
  if (isIP(hostname) !== 0) {
    if (!allowPrivate && isBlockedAddress(hostname)) {
      throw new Error("blocked_target");
    }
    return [hostname];
  }

  const resolved = await lookup(hostname, { all: true });
  const addresses = resolved.map((entry) => entry.address);
  if (addresses.length === 0) throw new Error("blocked_target");
  if (allowPrivate) return addresses;

  for (const address of addresses) {
    if (isBlockedAddress(address)) throw new Error("blocked_target");
  }
  return addresses;
}

/** One request, aimed at an address that has already been approved. */
export type PinnedDeliveryRequest = {
  /** The subscription's URL — supplies scheme, port, path and `Host`. */
  url: URL;
  /** The literal address to connect to. From `approvedDeliveryAddresses`. */
  address: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs?: number;
};

/** A timeout that classifies exactly as `AbortSignal.timeout` used to. */
function timeoutError(): Error {
  const error = new Error("Webhook request timed out");
  // The delivery log stores `error.name`; keeping this name means an existing
  // row's `TimeoutError` still means the same thing after the transport swap.
  error.name = "TimeoutError";
  return error;
}

/**
 * POST the signed body to a PINNED address, resolving to the response status.
 *
 * `node:https`/`node:http` rather than `fetch`, because `fetch` takes a URL and
 * does its own DNS: there is no way to tell it "the name is example.com but
 * connect to 203.0.113.7, the address I just validated". Here the socket goes
 * to the literal, while `Host` and TLS `servername` carry the original name, so
 * virtual hosting and certificate validation still work — the certificate is
 * checked against the hostname, never against the pinned address.
 *
 * Redirects are NOT followed, by construction: `node:https` does not follow
 * them, and this function must never grow the ability. A `Location:` header is
 * a second destination chosen by the receiver, resolved by nobody and validated
 * by nobody — following one hands back exactly the SSRF the pinning removes.
 *
 * `agent: false` for the same reason: a pooled keep-alive socket outlives the
 * DNS check that approved its address, so the next delivery would reuse a
 * connection nothing re-validated.
 */
export function postSignedDelivery(
  options: PinnedDeliveryRequest,
): Promise<number> {
  const { url, address, headers, body } = options;
  const timeoutMs = options.timeoutMs ?? WEBHOOK_REQUEST_TIMEOUT_MS;
  const isHttps = url.protocol === "https:";
  const hostname = url.hostname.replace(/^\[|\]$/g, "");

  const requestOptions: RequestOptions = {
    hostname: address,
    port: url.port ? Number(url.port) : isHttps ? 443 : 80,
    path: `${url.pathname}${url.search}`,
    method: "POST",
    agent: false,
    headers: {
      ...headers,
      // The name, not the pinned address: a receiver behind a shared IP routes
      // on this, and `fetch` sent it too.
      Host: url.host,
      "Content-Length": String(Buffer.byteLength(body)),
    },
    // SNI, so the receiver picks the right certificate AND so node checks that
    // certificate against the NAME rather than against the pinned literal it
    // dialled. Omitted when the subscription's own host is an address: SNI must
    // be a name, and with none set node validates against the address, which is
    // what a literal-host URL should be validated against anyway.
    ...(isHttps && isIP(hostname) === 0 ? { servername: hostname } : {}),
  };

  return new Promise<number>((resolve, reject) => {
    const send = isHttps ? httpsRequest : httpRequest;
    const request = send(requestOptions);
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      request.destroy();
      reject(timeoutError());
    }, timeoutMs);

    request.on("response", (response) => {
      const status = response.statusCode ?? 0;
      // Drain and drop the body. Nothing reads it — a receiver's error page can
      // be megabytes of HTML — but an undrained response holds its socket open.
      response.resume();
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(status);
    });

    request.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    request.end(body);
  });
}

/**
 * The visibility a subscription's deliveries are projected against.
 *
 * LIVE, read per delivery: the whole point of projecting at send time is that
 * this answer may have changed since the subscription was created. `null`
 * means the creator is no longer a member of the workspace — which is not an
 * error and not a retry, it is "there is nobody left who may see this", so
 * the delivery is skipped. Fail closed: a subscription created before
 * `createdBy` existed has an empty creator and matches no membership.
 */
async function ownerVisibility(
  workspaceId: string,
  userId: string,
): Promise<Visibility | null> {
  if (!userId) return null;
  const membership = await WorkspaceMember.findOne({
    workspaceId,
    userId,
  }).lean();
  if (!membership) return null;
  return visibilityOf(membership);
}

/** Record a terminal outcome that is not a failure of the endpoint. */
async function markSkipped(deliveryId: string): Promise<void> {
  await WebhookDelivery.updateOne(
    { _id: deliveryId },
    {
      $set: {
        status: "skipped_visibility",
        nextAttemptAt: null,
        error: null,
        responseStatus: null,
      },
    },
  );
}

/**
 * Record a failed attempt and schedule the next one, or give up.
 *
 * `consecutiveFailures` is incremented ONLY when the delivery is exhausted,
 * never per attempt: the auto-disable threshold counts dead deliveries, and
 * counting attempts instead would switch a healthy endpoint off after two and
 * a half bad ones.
 */
async function recordFailure(
  target: DeliveryTarget,
  attemptsMade: number,
  failure: DeliveryFailure,
  now: Date,
): Promise<void> {
  const retryAt = nextAttemptAt(attemptsMade, now);
  await WebhookDelivery.updateOne(
    { _id: target.deliveryId },
    {
      $set: {
        status: retryAt ? "pending" : "failed",
        attempt: attemptsMade,
        error: failure.error,
        responseStatus: failure.responseStatus,
        nextAttemptAt: retryAt,
      },
    },
  );
  if (retryAt) return;

  const subscription = await WebhookSubscription.findOneAndUpdate(
    { _id: target.subscriptionId },
    { $inc: { consecutiveFailures: 1 }, $set: { lastDeliveryAt: now } },
    { returnDocument: "after" },
  ).lean();
  if (!subscription) return;
  if (!shouldAutoDisable(subscription.consecutiveFailures ?? 0)) return;
  if (!subscription.enabled) return;

  await WebhookSubscription.updateOne(
    { _id: target.subscriptionId },
    { $set: { enabled: false, disabledAt: now } },
  );
}

/** Record a success and clear the endpoint's failure streak. */
async function recordSuccess(
  target: DeliveryTarget,
  attemptsMade: number,
  status: number,
  now: Date,
): Promise<void> {
  await WebhookDelivery.updateOne(
    { _id: target.deliveryId },
    {
      $set: {
        status: "delivered",
        attempt: attemptsMade,
        error: null,
        responseStatus: status,
        nextAttemptAt: null,
      },
    },
  );
  await WebhookSubscription.updateOne(
    { _id: target.subscriptionId },
    { $set: { consecutiveFailures: 0, lastDeliveryAt: now } },
  );
}

/**
 * Send one delivery.
 *
 * Two callers cannot double-post the same row, and a plain status read is NOT
 * what stops them: nothing writes a non-`pending` status until after the
 * response comes back, so two concurrent calls would both read `pending`, both
 * pass, and both POST. What stops them is the attempt number being CLAIMED —
 * one atomic `findOneAndUpdate` that only matches while `attempt` is still the
 * value that was read. The loser matches nothing and returns having sent
 * nothing. (The sweeper's `claimDueDeliveries` lease is the coarse version of
 * the same idea; this one also covers a direct call.)
 *
 * The attempt number therefore counts attempts STARTED, not finished — a
 * process that dies mid-flight has spent one, and the row becomes due again
 * when its lease expires rather than replaying that attempt for free.
 */
export async function deliverWebhook(deliveryId: string): Promise<void> {
  const pending = await WebhookDelivery.findById(deliveryId).lean();
  if (!pending || pending.status !== "pending") return;

  const attemptsMade = (pending.attempt ?? 0) + 1;
  // Matching on `attempt` is what makes this a compare-and-swap. It works
  // because the field is always present — schema default 0, and the emitter
  // writes it explicitly — since a Mongo equality filter does NOT match a
  // document that is missing the field, and such a row could never be claimed.
  const delivery = await WebhookDelivery.findOneAndUpdate(
    { _id: deliveryId, status: "pending", attempt: pending.attempt ?? 0 },
    { $set: { attempt: attemptsMade } },
    { returnDocument: "after" },
  ).lean();
  // Somebody else claimed this attempt between the read and the update.
  if (!delivery) return;

  const now = new Date();
  const target: DeliveryTarget = {
    deliveryId: String(delivery._id),
    subscriptionId: delivery.subscriptionId,
  };
  const subscription = await WebhookSubscription.findById(
    delivery.subscriptionId,
  ).lean();

  // A subscription deleted or switched off between enqueue and send has no
  // destination left. Terminal, and NOT counted against anything — there is
  // no endpoint to blame or disable.
  if (!subscription || !subscription.enabled) {
    await WebhookDelivery.updateOne(
      { _id: target.deliveryId },
      {
        $set: {
          status: "failed",
          attempt: attemptsMade,
          error: subscription ? "subscription_disabled" : "subscription_deleted",
          nextAttemptAt: null,
        },
      },
    );
    return;
  }

  const visibility = await ownerVisibility(
    subscription.workspaceId,
    subscription.createdBy,
  );
  if (!visibility) {
    await markSkipped(target.deliveryId);
    return;
  }

  const envelope: WebhookEnvelope | null = projectWebhookEnvelope(
    delivery.envelope,
    visibility,
  );
  if (!envelope) {
    await markSkipped(target.deliveryId);
    return;
  }

  // Re-resolved on EVERY attempt, not just at subscribe time. A name that
  // answered publicly when the subscription was created can answer
  // 169.254.169.254 now; that is DNS rebinding, and it is the whole reason
  // this call is here rather than only in the create resolver.
  //
  // The second call is what makes the first one worth anything: it hands back
  // the approved LITERAL addresses, and the socket below goes to one of them.
  // Validating a name and then handing the name to a resolver again would let
  // the answer change in between.
  let url: URL;
  let addresses: string[];
  try {
    url = await assertDeliverableUrl(subscription.url);
    addresses = await approvedDeliveryAddresses(url);
  } catch {
    await recordFailure(
      target,
      attemptsMade,
      { error: "blocked_target", responseStatus: null },
      now,
    );
    return;
  }

  // First approved address, the way a resolver's first answer is what a client
  // would have dialled anyway. Every entry in the list passed the same check,
  // so which one is picked is not a security decision.
  const address = addresses[0];
  if (!address) {
    await recordFailure(
      target,
      attemptsMade,
      { error: "blocked_target", responseStatus: null },
      now,
    );
    return;
  }

  // Serialize ONCE. The signature covers these exact bytes and the request
  // sends this exact string — re-stringifying the envelope for the body would
  // sign one byte sequence and transmit another, and every delivery would be
  // rejected as forged by a receiver doing its job.
  const rawBody = JSON.stringify(envelope);
  const timestampSeconds = Math.floor(now.getTime() / 1000);
  const signature = signWebhookBody(
    subscription.secret,
    timestampSeconds,
    rawBody,
  );

  try {
    const status = await postSignedDelivery({
      url,
      address,
      headers: {
        "Content-Type": "application/json",
        [WEBHOOK_SIGNATURE_HEADERS.event]: envelope.event,
        // The delivery row's own id, which is also what the settings delivery
        // log shows. One id space, or an integrator handed a dedup key here
        // cannot find the failing delivery anywhere in the product.
        [WEBHOOK_SIGNATURE_HEADERS.delivery]: envelope.id,
        [WEBHOOK_SIGNATURE_HEADERS.timestamp]: String(timestampSeconds),
        [WEBHOOK_SIGNATURE_HEADERS.signature]: `${WEBHOOK_SIGNATURE_VERSION}=${signature}`,
      },
      body: rawBody,
    });
    const failure = classifyResponseStatus(status);
    if (failure) {
      await recordFailure(target, attemptsMade, failure, now);
      return;
    }
    await recordSuccess(target, attemptsMade, status, now);
  } catch (error) {
    // Transport-level: DNS, TLS, connection refused, timeout. The message is
    // stored for the delivery log; it is this server's own text, never the
    // receiver's body, which could be megabytes of HTML.
    await recordFailure(
      target,
      attemptsMade,
      {
        error: error instanceof Error ? error.name : "request_failed",
        responseStatus: null,
      },
      now,
    );
  }
}

/**
 * Take ownership of the deliveries that are due.
 *
 * Claimed one at a time with `findOneAndUpdate`, which is atomic: pushing
 * `nextAttemptAt` into the future is what stops a second sweep — in this
 * process or another one — from picking the same row up. A plain `find` here
 * would double-post every delivery the moment a second instance exists.
 */
export async function claimDueDeliveries(
  now: Date,
  limit: number,
): Promise<string[]> {
  const claimed: string[] = [];
  const leaseUntil = new Date(now.getTime() + WEBHOOK_CLAIM_LEASE_MS);

  for (let i = 0; i < limit; i += 1) {
    const row = await WebhookDelivery.findOneAndUpdate(
      { status: "pending", nextAttemptAt: { $ne: null, $lte: now } },
      { $set: { nextAttemptAt: leaseUntil } },
      { sort: { nextAttemptAt: 1 }, returnDocument: "after", projection: { _id: 1 } },
    ).lean();
    if (!row) break;
    claimed.push(String(row._id));
  }

  return claimed;
}

/**
 * One pass of the queue.
 *
 * Deliveries run sequentially rather than in parallel: the batch is small, and
 * a fan-out of concurrent `fetch`es to a slow host is how a background loop
 * turns into the thing that exhausts the process's sockets.
 */
export async function runWebhookSweep(now: Date = new Date()): Promise<void> {
  const ids = await claimDueDeliveries(now, WEBHOOK_SWEEP_BATCH);
  for (const id of ids) {
    await deliverWebhook(id);
  }
}
