---
sidebar_position: 6
description: Webhook event catalogue, the signed request format, a Node verification example, retry and auto-disable behaviour, and the SSRF policy.
---

# Webhooks

A webhook subscription posts a signed JSON document to a URL of yours whenever
something happens in your workspace, so an integration does not have to poll.

Create one in **Settings → Integrations → New webhook**: a URL and the events you want.
The signing secret is shown **once**, at creation. Store it where you keep your other
secrets; it cannot be recovered afterwards, only replaced by deleting the subscription
and creating another.

## Events

| Event | Fires when |
| --- | --- |
| `entry.started` | A timer starts. |
| `entry.stopped` | A running timer stops. |
| `entry.created` | A completed entry is created outright, with an explicit start and end. |
| `entry.updated` | An entry is edited. |
| `entry.deleted` | An entry is deleted. |
| `invoice.created` | An invoice is created. |
| `invoice.status_changed` | An invoice moves between statuses. |

## The request

```http
POST /your-endpoint HTTP/1.1
Content-Type: application/json
X-TrackYourTime-Event: entry.stopped
X-TrackYourTime-Delivery: 6650f1c3a4b21d0e8c7f9a12
X-TrackYourTime-Timestamp: 1789012345
X-TrackYourTime-Signature: v1=6f3a…c2
```

| Header | Meaning |
| --- | --- |
| `X-TrackYourTime-Event` | The event name, so you can route without parsing the body. |
| `X-TrackYourTime-Delivery` | This delivery's id: 24 lowercase hex characters. Stable across retries — use it to deduplicate. |
| `X-TrackYourTime-Timestamp` | Unix seconds at signing time. Part of the signed string. |
| `X-TrackYourTime-Signature` | `v1=` plus the hex HMAC-SHA256. |

The body is one envelope:

```json
{
  "id": "6650f1c3a4b21d0e8c7f9a12",
  "event": "entry.stopped",
  "workspaceId": "664a…",
  "createdAt": "2026-09-07T15:04:05.000Z",
  "data": {
    "kind": "entry",
    "entry": {
      "id": "665f…",
      "workspaceId": "664a…",
      "authorId": "6612…",
      "description": "Invoicing run",
      "projectId": "6640…",
      "billable": true,
      "start": "2026-09-07T14:00:00.000Z",
      "end": "2026-09-07T15:04:05.000Z",
      "durationSec": 3845,
      "hourlyRate": 95,
      "currency": "EUR",
      "tagIds": ["6644…"]
    }
  }
}
```

`data` is a discriminated union on `kind`:

| `kind` | Carried by | Shape |
| --- | --- | --- |
| `entry` | `entry.started`, `entry.stopped`, `entry.created`, `entry.updated` | `{ entry }` |
| `entry-deleted` | `entry.deleted` | `{ id, authorId }` |
| `invoice` | `invoice.created` | `{ invoice }` |
| `invoice-status` | `invoice.status_changed` | `{ invoice, from, to }` |

An `invoice` carries the two parties as they stood when it was created:
`issuer` (the workspace's business profile: `legalName`, `addressLines`,
`postalCode`, `city`, `country`, `taxId`, `email`, `phone`, `website`,
`paymentDetails`, `paymentTermsDays`, `invoiceFooter`) and `recipient` (the
client's `name` plus `legalName`, `addressLines`, `postalCode`, `city`,
`country`, `taxId`, `email`, `reference`). Blank fields are `null`. Either is
`null` when there was nothing to copy, and on invoices created before these
fields existed. They never change after creation, so the payload of
`invoice.status_changed` shows the same parties as `invoice.created`.

`entry.deleted` carries `authorId` explicitly rather than the id alone, because who
authored it is what decides whether you are allowed to be told about it at all.

## Verifying a delivery

The signature is `HMAC-SHA256(secret, timestamp + "." + rawBody)`, hex-encoded. Three
things this example does that a naive check does not, and each of them is the whole
point of the check:

```js
import { createHmac, timingSafeEqual } from "node:crypto";
import express from "express";

const app = express();
const SECRET = process.env.TRACKYOURTIME_WEBHOOK_SECRET;
const TOLERANCE_SECONDS = 300;

// The RAW bytes, not a parsed-and-reserialized object. `JSON.stringify` gives
// no key-ordering guarantee across object identities, so re-serializing the
// parsed body produces a different string and every signature fails.
app.post("/hooks/trackyourtime", express.raw({ type: "application/json" }), (req, res) => {
  const timestamp = req.get("X-TrackYourTime-Timestamp") ?? "";
  const header = req.get("X-TrackYourTime-Signature") ?? "";
  const rawBody = req.body.toString("utf8");

  // Reject a stale delivery. The timestamp is INSIDE the signed string, so it
  // cannot be rewritten — which is what makes this check worth anything: a
  // captured delivery cannot be replayed at you tomorrow.
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > TOLERANCE_SECONDS) {
    return res.status(400).send("stale");
  }

  const expected = createHmac("sha256", SECRET)
    .update(`${timestamp}.${rawBody}`, "utf8")
    .digest("hex");
  const presented = header.startsWith("v1=") ? header.slice(3) : "";

  // Constant-time, and length-checked first: timingSafeEqual THROWS on a
  // length mismatch, and `===` on hex strings leaks the comparison position.
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(presented, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return res.status(401).send("bad signature");
  }

  // Answer fast, work later. Anything past ten seconds is a failed delivery.
  res.status(202).end();
  void handle(JSON.parse(rawBody));
});
```

Deduplicate on `X-TrackYourTime-Delivery`: a retry after a timeout carries the same id, and
your endpoint may well have already processed the delivery it timed out on.

There is only one delivery id. The header, the envelope's `id`, and the id of the row
in the Settings delivery log are the same 24-character hex value, so a delivery you
logged as failed on your side can be looked up on ours.

## Delivery, retries and failure

A delivery is **successful** on any `2xx`. Everything else is a failure, including
`3xx` — redirects are never followed, because a `Location` header is validated by
nothing and following one would let a receiver aim this server wherever it liked. A
redirect is recorded as `redirect_not_followed`.

Each request is given **10 seconds**. Six attempts, then the delivery is abandoned:

| Attempt | After |
| --- | --- |
| 1 | immediately |
| 2 | 30 seconds |
| 3 | 2 minutes |
| 4 | 10 minutes |
| 5 | 1 hour |
| 6 | 6 hours |

A subscription whose deliveries fail **15 times consecutively** is disabled
automatically and stops being sent anything; the settings screen says so and says why.
A successful delivery clears the counter, and re-enabling the subscription there
resumes it. The counter is per *delivery*, not per attempt — otherwise a healthy
endpoint having a bad afternoon would be switched off after two and a half of them.

The delivery log — status, attempt, response code, error — is kept for **30 days** and
is visible per subscription in Settings.

## Not everything is delivered

Deliveries are filtered against the **subscription owner's current visibility**, read
at send time rather than at subscription time, so a permission change between the two
is honoured.

- Without `canViewOthersTime`, a colleague's `entry.*` event is withheld entirely.
- Without `canViewOthersMoney`, a colleague's entry arrives with `hourlyRate: null`.
  `currency` stays — it is workspace configuration, not an amount.
- `invoice.*` is money end to end with nothing to strip, so it is withheld entirely
  without `canViewOthersMoney`.

A withheld delivery is recorded as `skipped_visibility` — a permission outcome, not a
failure. It is not retried and does not count towards auto-disabling.

## Where deliveries may be sent

A webhook URL is caller-controlled, which makes an unguarded delivery an SSRF: anyone
who can create a subscription could aim the server at an address only the server can
reach — a cloud metadata endpoint, an internal admin panel, a database's HTTP
interface. So:

- **https only.** `http:` is refused, and every other scheme (`file:`, `gopher:`, …)
  with it.
- **Private and special-use addresses are refused**: loopback, link-local (where the
  cloud metadata address lives), RFC 1918, CGNAT, multicast, reserved, and their IPv6
  equivalents — including an IPv4-mapped address wearing IPv6 spelling.
- **Every address a hostname resolves to is checked**, not just the first. One public
  A record beside one private one would otherwise pass.
- **The check runs again immediately before each delivery**, not only when the
  subscription is created. DNS rebinding — a name that answers publicly once and
  privately afterwards — makes a create-time-only check decorative.
- **The connection is pinned to the address that was checked.** The request is opened
  against that literal address, with `Host` and the TLS server name still carrying your
  hostname, so your certificate is validated against your hostname as usual. Checking a
  name and then letting the HTTP client resolve it a second time would leave a window
  in which the answer changes between the two.
- **Redirects are never followed and connections are never pooled.** A `Location`
  header is a second destination that no check has seen, and a kept-alive socket would
  outlive the check that approved its address.

If your endpoint's address changes, deliveries follow it on the next attempt: the
resolution is per attempt, not cached by this server.

### Self-hosting against a local listener

`WEBHOOK_ALLOW_PRIVATE_TARGETS=true` lifts all of that: private targets become
deliverable and plain `http` is accepted, because there is no certificate for
`localhost` worth insisting on.

It exists for pointing a local listener at a dev server. **Leave it off everywhere
else** — with it on, anyone who can create a subscription can make the server issue
requests into its own network.
