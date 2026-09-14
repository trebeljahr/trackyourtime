// The webhook signature: a known vector, and the ways a receiver must be able
// to tell a tampered delivery apart from a real one.
//
// Pinned with a hard-coded expected digest rather than by recomputing the same
// HMAC in the test: a test that calls `createHmac` the same way the code does
// passes even when both are wrong together, and it would not catch the
// signed-string format changing under a receiver that already implemented it.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import {
  WEBHOOK_SIGNATURE_HEADERS,
  WEBHOOK_SIGNATURE_VERSION,
  signWebhookBody,
} from "../services/webhooks/signature.js";

const SECRET = "whsec_test_secret";
const TIMESTAMP = 1_756_000_000;
const BODY = '{"id":"d1","event":"entry.started"}';

describe("signWebhookBody", () => {
  it("matches a fixed vector — the wire format is a contract", () => {
    // If this value has to change, every already-deployed receiver breaks.
    // Changing it is a versioned event, not a refactor.
    assert.equal(
      signWebhookBody(SECRET, TIMESTAMP, BODY),
      "77927dbf069d7d2e20144e492739e6eb74b46c748c6045363a2f1207517a1ef6",
    );
    // The independent recomputation is the readable spec of the format above:
    // HMAC-SHA256 over `${timestamp}.${rawBody}`, hex.
    assert.equal(
      signWebhookBody(SECRET, TIMESTAMP, BODY),
      createHmac("sha256", SECRET)
        .update(`${TIMESTAMP}.${BODY}`, "utf8")
        .digest("hex"),
    );
  });

  it("signs `timestamp.body`, so the timestamp cannot be rewritten", () => {
    // A captured delivery replayed an hour later with the header edited must
    // not verify — which is only true because the timestamp is INSIDE the
    // signed string, not merely next to it.
    assert.notEqual(
      signWebhookBody(SECRET, TIMESTAMP, BODY),
      signWebhookBody(SECRET, TIMESTAMP + 1, BODY),
    );
  });

  it("changes completely when the body moves by one byte", () => {
    const original = signWebhookBody(SECRET, TIMESTAMP, BODY);
    const mutated = signWebhookBody(
      SECRET,
      TIMESTAMP,
      BODY.replace("entry.started", "entry.stoppe1"),
    );
    assert.notEqual(original, mutated);
    assert.equal(mutated.length, original.length);
  });

  it("is different under a different secret", () => {
    assert.notEqual(
      signWebhookBody(SECRET, TIMESTAMP, BODY),
      signWebhookBody(`${SECRET}x`, TIMESTAMP, BODY),
    );
  });

  it("is stable — the same inputs always produce the same digest", () => {
    assert.equal(
      signWebhookBody(SECRET, TIMESTAMP, BODY),
      signWebhookBody(SECRET, TIMESTAMP, BODY),
    );
  });

  it("distinguishes bodies that differ only in key ORDER", () => {
    // Which is why the sender must sign and send the SAME string: two
    // serializations of one object are two different bodies to this function.
    const a = '{"a":1,"b":2}';
    const b = '{"b":2,"a":1}';
    assert.notEqual(
      signWebhookBody(SECRET, TIMESTAMP, a),
      signWebhookBody(SECRET, TIMESTAMP, b),
    );
  });
});

describe("the header names", () => {
  it("are the ones the docs and every receiver are written against", () => {
    assert.deepEqual({ ...WEBHOOK_SIGNATURE_HEADERS }, {
      event: "X-TrackYourTime-Event",
      delivery: "X-TrackYourTime-Delivery",
      timestamp: "X-TrackYourTime-Timestamp",
      signature: "X-TrackYourTime-Signature",
    });
    assert.equal(WEBHOOK_SIGNATURE_VERSION, "v1");
  });
});
